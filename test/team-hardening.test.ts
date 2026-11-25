import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {WebSocket} from 'ws';
import {Ledger, requestActor} from '../src/connector/ledger.js';
import {createRelay} from '../src/server/relay.js';
import {TeamStore} from '../src/server/team/store.js';
import {applyLiveFrames} from '../web/live.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const MAIN = 'main-fixture-token-for-hardening-tests';

test('an older connector put back after an update can still record operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-ledger-compat-'));
  const file = join(dir, 'operations.sqlite');
  try {
    // A database widened by an earlier build of the team feature.
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE operations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated INTEGER NOT NULL, actor TEXT)");
    old.prepare('INSERT INTO operations VALUES (?,?,?,?,?,?)').run('1:old', 'h', 'accepted', null, Date.now(), JSON.stringify({userId: 'u1', name: 'Bo'}));
    old.close();
    let ledger = new Ledger(file);
    assert.deepEqual(ledger.actor('1:old'), {userId: 'u1', name: 'Bo'}, 'senders recorded before survive the move');
    const id = `${Date.now()}:${randomUUID()}`;
    await requestActor.run({userId: 'u2', name: 'Ada'}, () => ledger.run(id, {action: 'turn.send'}, async () => ({})));
    assert.deepEqual(ledger.actor(id), {userId: 'u2', name: 'Ada'});
    ledger.close();
    // What the previous connector does on every operation.
    const previous = new DatabaseSync(file);
    previous.prepare('INSERT INTO operations VALUES (?,?,?,NULL,?)').run('2:previous', 'h', 'pending', Date.now());
    previous.close();
    ledger = new Ledger(file);
    assert.equal(ledger.read('2:previous').state, 'uncertain');
    ledger.close();
  } finally {await removeTestTemp(dir);}
});

test('a usage record that cannot be written does not fail the send', () => {
  const ledger = new Ledger(':memory:');
  ledger.db.exec('DROP TABLE usage_outbox');
  assert.doesNotThrow(() => ledger.recordUsage({id: 'antigravity:c:1', service: 'antigravity', threadId: 'c', turnId: '1', models: []}));
  ledger.close();
});

test('live frames that replace a turn keep the senders the last read showed', () => {
  const sender = {id: 'u1', name: 'Bo'};
  const view: any = {id: 't', generation: 'g', running: true, turns: [{id: 'turn', status: 'inProgress', canFork: false, items: [
    {id: 'u', type: 'userMessage', role: 'user', text: 'hi', sender}, {id: 'a', type: 'agentMessage', role: 'assistant', text: 'wor'}]}]};
  const whole = applyLiveFrames(view, [{threadId: 't', generation: 'g', turnId: 'turn', turn: {id: 'turn', status: 'inProgress', canFork: false, items: [
    {id: 'u', type: 'userMessage', role: 'user', text: 'hi'}, {id: 'a', type: 'agentMessage', role: 'assistant', text: 'working'}]}}]);
  assert.deepEqual(whole.view!.turns[0].items.map(item => [item.text, item.sender?.name]), [['hi', 'Bo'], ['working', undefined]]);
  const item = applyLiveFrames(view, [{threadId: 't', generation: 'g', turnId: 'turn', ops: [{i: 'u', item: {id: 'u', type: 'userMessage', role: 'user', text: 'hi!'}}]}]);
  assert.equal(item.view!.turns[0].items[0].sender?.name, 'Bo');
});

test('a Claude Code turn that a send-now message starts counts for that sender', async () => {
  const {ClaudeRuntime} = await import('../src/connector/claude-runtime.js');
  let count = 0;
  // 'urgent' interrupts the running turn: Claude Code ends it with its own result, then answers 'urgent' in a new turn.
  const query = (({prompt}: any) => {
    async function* run(): AsyncGenerator<any> {
      yield {type: 'system', subtype: 'init', session_id: 's1', model: 'claude-test'};
      for await (const input of prompt) {
        const text = (input.message.content as any[]).find(block => block.type === 'text')?.text;
        if (text === 'long') {yield {type: 'assistant', session_id: 's1', message: {}};continue;}
        if (text === 'urgent') yield {type: 'result', subtype: 'error_during_execution', session_id: 's1', uuid: `r${++count}`, errors: [], modelUsage: {}};
        yield {type: 'assistant', session_id: 's1', message: {}};
        yield {type: 'result', subtype: 'success', session_id: 's1', uuid: `r${++count}`, errors: [], modelUsage: {}};
      }
    }
    const generator = run() as any;generator.interrupt = async () => {};generator.close = () => {};
    return generator;
  }) as any;
  const runtime = new ClaudeRuntime(async () => query, () => undefined, 60_000);
  const turns: any[] = [];
  runtime.on('turn', (_session, result, opId) => turns.push([result.uuid, opId]));
  const session = await runtime.start({cwd: tmpdir()});
  runtime.send(session, 'long', [], undefined, 'op-a');
  runtime.send(session, 'urgent', [], 'now', 'op-b');
  await new Promise(resolve => setTimeout(resolve, 60));
  runtime.send(session, 'later', [], undefined, 'op-c');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(turns, [['r1', 'op-a'], ['r2', 'op-b'], ['r3', 'op-c']]);
  await runtime.close();
});

function waitFrame(ws: WebSocket, predicate: (v: any) => boolean): Promise<any> {return new Promise((resolve, reject) => {
  const timer = setTimeout(() => {ws.off('message', listen);reject(Error('frame timeout'));}, 3000);
  const listen = (b: any) => {const value = JSON.parse(b.toString());if (predicate(value)) {clearTimeout(timer);ws.off('message', listen);resolve(value);}};ws.on('message', listen);
});}

async function startRelay(store: TeamStore) {
  const relay = createRelay(MAIN, undefined, 0, [], store);
  relay.server.listen(0, '127.0.0.1');relay.previewServer.listen(0, '127.0.0.1');
  await Promise.all([once(relay.server, 'listening'), once(relay.previewServer, 'listening')]);
  const url = `ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  const sockets: WebSocket[] = [];
  async function hello(fields: object): Promise<{ws: WebSocket; ready?: any; code?: number}> {
    const ws = new WebSocket(url);sockets.push(ws);await once(ws, 'open');
    const result = Promise.race([waitFrame(ws, frame => frame.type === 'ready').then(ready => ({ws, ready})), once(ws, 'close').then(([code]) => ({ws, code: code as number}))]);
    ws.send(JSON.stringify({type: 'hello', ...fields}));
    return result;
  }
  return {relay, hello, close: async () => {for (const ws of sockets) ws.terminate();await relay.close();}};
}

test('a member who loses a computer, or a removed device, loses its web previews at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-preview-access-'));
  const store = new TeamStore(join(dir, 'relay.sqlite'));
  const owner = store.createUser({name: 'Ada', role: 'owner'}), member = store.createUser({name: 'Bo', role: 'member'});
  const relay = await startRelay(store);
  try {
    const pc = await relay.hello({role: 'connector', token: MAIN, machineId: 'pc-a', name: 'pc-a'});
    const stops: any[] = [];
    pc.ws.on('message', (buffer: any) => {
      const frame = JSON.parse(buffer.toString());
      if (frame.type === 'preview.stop') stops.push(frame);
      if (frame.type === 'request') pc.ws.send(JSON.stringify({type: 'response', id: frame.id, result: {sessionId: `pv-${frame.payload.threadId}`, url: 'http://127.0.0.1:5173', threadId: frame.payload.threadId}}));
    });
    const ada = await relay.hello({role: 'phone', invite: store.createInvite(owner.id, null).code});
    const bo = await relay.hello({role: 'phone', invite: store.createInvite(member.id, owner.id).code});
    const startPreview = async (ws: WebSocket, threadId: string) => {
      const reply = waitFrame(ws, frame => frame.id === threadId);
      ws.send(JSON.stringify({type: 'request', id: threadId, machineId: 'pc-a', action: 'preview.start', payload: {threadId, url: 'http://127.0.0.1:5173'}}));
      assert.ok((await reply).result.ticket);
    };
    await startPreview(bo.ws, 'bo-thread');
    const ended = waitFrame(bo.ws, frame => frame.type === 'preview.ended');
    const boStopped = waitFrame(pc.ws, frame => frame.type === 'preview.stop' && frame.sessionId === 'pv-bo-thread');
    const narrowed = waitFrame(ada.ws, frame => frame.type === 'response' && frame.id === 'narrow');
    ada.ws.send(JSON.stringify({type: 'team', id: 'narrow', action: 'team.members.update', payload: {userId: member.id, machines: []}}));
    await narrowed;
    assert.equal((await ended).sessionId, 'pv-bo-thread');
    await boStopped;
    assert.deepEqual(stops.map(frame => frame.sessionId), ['pv-bo-thread']);
    // The owner's own preview on a computer they keep is untouched; removing their device ends it.
    await startPreview(ada.ws, 'ada-thread');
    const second = await relay.hello({role: 'phone', invite: store.createInvite(owner.id, null).code});
    const closed = once(ada.ws, 'close');
    const adaStopped = waitFrame(pc.ws, frame => frame.type === 'preview.stop' && frame.sessionId === 'pv-ada-thread');
    const revoked = waitFrame(second.ws, frame => frame.type === 'response' && frame.id === 'revoke');
    second.ws.send(JSON.stringify({type: 'team', id: 'revoke', action: 'team.devices.revoke', payload: {deviceId: ada.ready.device.id}}));
    await revoked;await closed;await adaStopped;
    assert.deepEqual(stops.map(frame => frame.sessionId), ['pv-bo-thread', 'pv-ada-thread']);
  } finally {await relay.close();store.close();await removeTestTemp(dir);}
});

test('a team database error closes one connection, not the relay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-relay-errors-'));
  const store = new TeamStore(join(dir, 'relay.sqlite'));
  const relay = await startRelay(store);
  try {
    const machineToken = store.machineToken.bind(store);
    store.machineToken = () => {throw new Error('SQLITE_BUSY: database is locked');};
    const broken = await relay.hello({role: 'connector', token: MAIN, machineId: 'pc-a', name: 'pc-a'});
    assert.equal(broken.code, 1011);
    store.machineToken = machineToken;
    assert.ok((await relay.hello({role: 'connector', token: MAIN, machineId: 'pc-a', name: 'pc-a'})).ready, 'the relay keeps serving');
  } finally {await relay.close();store.close();await removeTestTemp(dir);}
});
