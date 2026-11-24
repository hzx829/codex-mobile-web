import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {createRelay} from '../src/server/relay.js';
import {sendBlob} from '../src/connector/blob.js';
import {openProjectDownload, readProjectFile} from '../src/connector/project.js';
import {BridgeError} from '../src/shared/types.js';
import {removeTestTemp} from '../scripts/test-temp.js';

type Reply = {status: number; headers: Record<string, string | string[] | undefined>; body: Buffer};
function http(url: string, options: {method?: string; headers?: Record<string, string>} = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(url, {method: options.method || 'GET', headers: options.headers}, async res => {
      const chunks: Buffer[] = [];for await (const chunk of res) chunks.push(Buffer.from(chunk));
      resolve({status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks)});
    });
    req.on('error', reject);req.end();
  });
}

test('files reach a signed-in phone as plain HTTP downloads, with ranges, errors and the usual checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-blob-'));
  const token = 'blob-fixture-token-for-relay-tests';
  const relay = createRelay(token, undefined, 0);
  relay.server.listen(0, '127.0.0.1');await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  const connector = new WebSocket(base.replace('http', 'ws') + '/ws'), opened = once(connector, 'open');
  try {
    const bytes = Buffer.from(Array.from({length: 300_000}, (_, index) => index % 251));
    await writeFile(join(root, 'clip.mp4'), bytes);
    await writeFile(join(root, 'page.html'), '<script>alert(1)</script>');
    const pulls: any[] = [];
    await opened;
    connector.send(JSON.stringify({type: 'hello', role: 'connector', token, machineId: 'pc', name: 'pc'}));
    connector.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'blob.pull') return;
      pulls.push(m);
      // What the connector does: the download action, opened for streaming, with its usual checks.
      void sendBlob(base, m.stream, async () => {
        if (m.payload.path === 'missing') throw new BridgeError('not_found', '文件已移动或删除');
        return openProjectDownload(root, m.payload.path, m.payload.revision, m.range);
      });
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const clip = await readProjectFile(root, 'clip.mp4'), page = await readProjectFile(root, 'page.html');
    const url = (path: string, revision: string, extra = '') => `${base}/blob/pc/file?action=claude.file.download&conversationId=c&path=${encodeURIComponent(path)}&revision=${revision}${extra}`;

    assert.equal((await http(`${base}/blob/session`, {method: 'POST', headers: {Authorization: 'Bearer wrong'}})).status, 401);
    assert.equal((await http(url('clip.mp4', clip.revision))).status, 401, 'Without the cookie nothing is sent.');
    const signedIn = await http(`${base}/blob/session`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}});
    assert.equal(signedIn.status, 204);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
    assert.match(String(signedIn.headers['set-cookie']), /HttpOnly; SameSite=Strict; Path=\/blob/);
    const get = (target: string, headers: Record<string, string> = {}) => http(target, {headers: {cookie, ...headers}});

    const whole = await get(url('clip.mp4', clip.revision));
    assert.equal(whole.status, 200);
    assert.ok(whole.body.equals(bytes));
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.match(String(whole.headers['content-security-policy']), /^sandbox/);
    assert.deepEqual([pulls[0].action, pulls[0].payload], ['claude.file.download', {conversationId: 'c', path: 'clip.mp4', revision: clip.revision}]);

    const part = await get(url('clip.mp4', clip.revision), {Range: 'bytes=1000-1999'});
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], `bytes 1000-1999/${bytes.length}`);
    assert.ok(part.body.equals(bytes.subarray(1000, 2000)));
    const tail = await get(url('clip.mp4', clip.revision), {Range: 'bytes=299990-'});
    assert.ok(tail.body.equals(bytes.subarray(299_990)));

    const saved = await get(url('clip.mp4', clip.revision, '&download=1'));
    assert.equal(saved.headers['content-type'], 'application/octet-stream');
    assert.match(String(saved.headers['content-disposition']), /^attachment; filename\*=UTF-8''clip\.mp4$/);
    const html = await get(url('page.html', page.revision));
    assert.equal(html.headers['content-type'], 'application/octet-stream', 'A page is never shown as this site’s page.');
    assert.match(String(html.headers['content-disposition']), /^attachment/);

    assert.equal((await get(url('clip.mp4', 'stale'))).status, 409, 'A changed file is refused as a chunked download would be.');
    const missing = await get(url('missing', 'x'));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.toString(), '文件已移动或删除');
    assert.equal((await get(`${base}/blob/pc/file?action=claude.send&text=x`)).status, 400, 'Only downloads are relayed.');
    assert.equal((await get(url('clip.mp4', clip.revision).replace('/pc/', '/other/'))).status, 503);
    assert.equal((await get(url('clip.mp4', clip.revision), {Range: 'bytes=-10'})).status, 416);
    assert.equal((await http(`${base}/blob-feed/${'0'.repeat(64)}`, {method: 'POST'})).status, 404, 'An unknown stream takes nothing.');
  } finally {
    connector.close();await relay.close();await removeTestTemp(root);
  }
});
