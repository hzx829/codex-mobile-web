import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';
import {ArtifactViewer, profileFolder} from '../src/connector/claude-artifacts.js';
import {relayStatus} from '../scripts/setup-status.js';
import {removeTestTemp} from '../scripts/test-temp.js';

test('the claude.ai sign-in is answered from what was last seen, without starting a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-signin-'));
  try {
    const chrome = 'C:\\x\\chrome.exe', viewer = new ArtifactViewer(dir, () => chrome);
    const check = async (from = viewer) => (await from.signIn({op: 'check'})).signedIn;
    assert.equal(await check(), 'no', 'a computer that never opened the browser is not signed in');
    await mkdir(join(dir, profileFolder(chrome)));
    assert.equal(await check(), 'unknown', 'a profile from before sign-ins were recorded may be signed in');
    await writeFile(join(dir, 'claude-signin.json'), JSON.stringify({profile: profileFolder(chrome), signedIn: true}));
    assert.equal(await check(), 'yes');
    // The record belongs to the browser that made it.
    assert.equal(await check(new ArtifactViewer(dir, () => 'C:\\x\\msedge.exe')), 'no');
    assert.deepEqual(await new ArtifactViewer(dir, () => undefined).signIn({op: 'check'}), {desktop: true, available: false, signedIn: 'no'});
  } finally {await removeTestTemp(dir);}
});

test('the status check reports the claude.ai sign-in only where Claude Code is there and the connector answers', async () => {
  const server = new WebSocketServer({port: 0, host: '127.0.0.1'});
  let services = ['codex', 'claude'], answer: Record<string, unknown> = {result: {desktop: true, available: true, signedIn: 'no'}}, asked = 0;
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'hello') socket.send(JSON.stringify({type: 'ready', machines: [{id: 'm1', services}]}));
    else if (message.action === 'info') socket.send(JSON.stringify({type: 'response', id: message.id, result: {runtime: {version: '1.0'}}}));
    else if (message.action === 'claude.artifact.login') {asked++;assert.deepEqual(message.payload, {op: 'check'});socket.send(JSON.stringify({type: 'response', id: message.id, ...answer}));}
  }));
  await new Promise(resolve => server.once('listening', resolve));
  const config = {relayUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`, token: 't', machineId: 'm1'};
  try {
    assert.equal((await relayStatus(config)).claudeSignIn, 'no');
    answer = {result: {desktop: true, available: true, signedIn: 'yes'}};
    assert.equal((await relayStatus(config)).claudeSignIn, 'yes');
    // An older connector refuses the question, and a computer without a browser cannot sign in at all.
    answer = {error: {code: 'expired', message: '登录窗口已关闭，请重新开始'}};
    const old = await relayStatus(config);
    assert.equal(old.claudeSignIn, undefined);
    assert.equal(old.codexVersion, '1.0');
    answer = {result: {desktop: true, available: false, signedIn: 'no'}};
    assert.equal((await relayStatus(config)).claudeSignIn, undefined);
    services = ['codex'];
    const before = asked;
    assert.equal((await relayStatus(config)).claudeSignIn, undefined);
    assert.equal(asked, before, 'a computer without Claude Code is not asked');
  } finally {for (const client of server.clients) client.terminate();await new Promise(resolve => server.close(resolve));}
});
