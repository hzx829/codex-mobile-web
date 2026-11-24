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

test('upload parts reach the computer as streams, in order, from this site only', async () => {
  const {receiveBlob} = await import('../src/connector/blob.js');
  const {startUpload, appendUpload} = await import('../src/connector/attachments.js');
  const {Ledger} = await import('../src/connector/ledger.js');
  const {randomUUID} = await import('node:crypto');
  const {readFile} = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'cmw-blob-up-'));
  const token = 'blob-upload-fixture-token-for-tests';
  const relay = createRelay(token, undefined, 0), ledger = new Ledger(':memory:');
  relay.server.listen(0, '127.0.0.1');await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  const connector = new WebSocket(base.replace('http', 'ws') + '/ws'), opened = once(connector, 'open');
  try {
    await opened;
    connector.send(JSON.stringify({type: 'hello', role: 'connector', token, machineId: 'pc', name: 'pc'}));
    connector.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'blob.push') return;
      // What the connector does: the chunk action, given the part as a stream.
      void receiveBlob(base, m.stream, m.length, body => appendUpload(ledger, m.payload.threadId, m.payload.id, Number(m.payload.offset), body))
        .then(outcome => connector.send(JSON.stringify({type: 'blob.done', stream: m.stream, ...outcome})));
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const bytes = Buffer.from(Array.from({length: 9_000_000}, (_, index) => (index * 7) % 256));
    const id = randomUUID();
    assert.deepEqual(await startUpload(ledger, 'thread', root, {id, name: 'big.bin', size: bytes.length}), {id, offset: 0});
    const signedIn = await fetch(`${base}/blob/session`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}});
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
    const put = (offset: number, part: Buffer, extra: Record<string, string> = {}, action = 'file.uploadChunk') =>
      fetch(`${base}/blob/pc/upload?action=${action}&threadId=thread&id=${id}&offset=${offset}`, {method: 'PUT', body: new Uint8Array(part), headers: {cookie, ...extra}});

    assert.equal((await put(0, bytes.subarray(0, 10), {Origin: 'https://elsewhere.example'})).status, 403, 'Another site cannot write.');
    assert.equal((await put(0, bytes.subarray(0, 10), {}, 'claude.send')).status, 400, 'Only upload parts are relayed.');
    assert.equal((await put(0, Buffer.alloc(8 * 1024 * 1024 + 1))).status, 413);
    const first = await put(0, bytes.subarray(0, 5_000_000), {Origin: base});
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {result: {id, offset: 5_000_000}});
    const skipped = await put(6_000_000, bytes.subarray(6_000_000, 7_000_000));
    assert.equal(skipped.status, 409, 'A part must start where the file ends.');
    assert.equal((await skipped.json()).error.code, 'conflict');
    const second = await put(5_000_000, bytes.subarray(5_000_000));
    assert.deepEqual(await second.json(), {result: {id, offset: bytes.length}});
    assert.ok((await readFile(join(root, '.codex-mobile-attachments', id, 'big.bin'))).equals(bytes));
    assert.equal((await startUpload(ledger, 'thread', root, {id, name: 'big.bin', size: bytes.length})).offset, bytes.length);
  } finally {
    connector.close();await relay.close();ledger.close();await removeTestTemp(root);
  }
});

test('images go both ways by content: kept for good when read, stored when sent', async () => {
  const {receiveBlob} = await import('../src/connector/blob.js');
  const {BlobStore} = await import('../src/connector/blob-store.js');
  const root = await mkdtemp(join(tmpdir(), 'cmw-blob-img-'));
  const token = 'blob-image-fixture-token-for-tests';
  const relay = createRelay(token, undefined, 0), store = new BlobStore(root);
  relay.server.listen(0, '127.0.0.1');await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${(relay.server.address() as any).port}`;
  const connector = new WebSocket(base.replace('http', 'ws') + '/ws'), opened = once(connector, 'open');
  try {
    await opened;
    connector.send(JSON.stringify({type: 'hello', role: 'connector', token, machineId: 'pc', name: 'pc'}));
    connector.on('message', raw => {
      const m = JSON.parse(raw.toString());
      // What the connector does with images (src/connector/main.ts).
      if (m.type === 'blob.pull' && m.action === 'blob.image') void sendBlob(base, m.stream, () => store.open(m.payload.sha));
      if (m.type === 'blob.push' && m.action === 'blob.image.put') void receiveBlob(base, m.stream, m.length, async body => {
        const parts: Buffer[] = [];for await (const chunk of body.stream) parts.push(chunk);
        return {ref: 'cmw-image:' + store.put(Buffer.concat(parts), m.payload.mime)};
      }).then(outcome => connector.send(JSON.stringify({type: 'blob.done', stream: m.stream, ...outcome})));
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const cookie = (await fetch(`${base}/blob/session`, {method: 'POST', headers: {Authorization: `Bearer ${token}`}})).headers.get('set-cookie')!.split(';')[0];
    const bytes = Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(500), 'hex');
    const sent = await fetch(`${base}/blob/pc/image`, {method: 'PUT', body: new Uint8Array(bytes), headers: {cookie, 'Content-Type': 'image/png'}});
    const {result} = await sent.json();
    assert.match(result.ref, /^cmw-image:[a-f0-9]{64}$/);
    assert.equal((await fetch(`${base}/blob/pc/image`, {method: 'PUT', body: 'x', headers: {cookie, 'Content-Type': 'text/html'}})).status, 415);
    const read = await fetch(`${base}/blob/pc/image/${result.ref.slice('cmw-image:'.length)}`, {headers: {cookie}});
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('content-type'), 'image/png');
    assert.equal(read.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.ok(Buffer.from(await read.arrayBuffer()).equals(bytes));
    assert.equal((await fetch(`${base}/blob/pc/image/${'f'.repeat(64)}`, {headers: {cookie}})).status, 404);
  } finally {connector.close();await relay.close();await removeTestTemp(root);}
});
