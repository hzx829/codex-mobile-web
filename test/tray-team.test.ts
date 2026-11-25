import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, stat} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {LocalControlServer, LOCAL_CONTROL_FILE, fetchLocalStatus, localBridgeRequest} from '../src/connector/local-control.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError} from '../src/shared/types.js';
import {createRelay} from '../src/server/relay.js';
import {TeamStore} from '../src/server/team/store.js';
import {relayStatus} from '../scripts/setup-status.js';
import {prepareSettings} from '../scripts/setup-config.js';
import {connectionPage} from '../scripts/connection-page.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const MAIN = 'main-fixture-token-for-tray-team-tests';

test('local control server exposes team status and local requests with bearer auth and cleans up on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-local-ctrl-'));
  const control = new LocalControlServer({
    dataDir: dir,
    getStatus: async () => ({
      relay: 'ok',
      authReason: null,
      connector: 'online',
      teamMode: true,
      ownToken: true,
      machineId: 'pc-1',
      machineName: '办公室主力机',
      services: ['codex', 'claude', 'antigravity'],
      codexVersion: '0.146.0',
      desktopOnline: true,
      claudeSignIn: 'yes',
      activeTasks: [{service: 'codex', threadId: 't1', actorName: '张三'}],
      pendingUsage: 3,
    }),
    handleRequest: async (action, payload) => {
      if (action === 'claude.artifact.login') return {signedIn: 'yes', op: payload.op};
      throw new BridgeError('active', '任务运行中');
    },
  });
  try {
    const record = await control.start();
    assert.ok(record.port > 0);
    // Unauthenticated callers on localhost are rejected.
    const denied = await fetch(`http://127.0.0.1:${record.port}/status`);
    assert.equal(denied.status, 401);

    const status = await fetchLocalStatus(dir);
    assert.equal(status?.teamMode, true);
    assert.equal(status?.ownToken, true);
    assert.equal(status?.machineName, '办公室主力机');
    assert.equal(status?.pendingUsage, 3);
    assert.deepEqual(status?.activeTasks, [{service: 'codex', threadId: 't1', actorName: '张三'}]);

    // relayStatus uses the local control endpoint first, avoiding role=phone 4401 in team mode.
    const probed = await relayStatus({relayUrl: 'https://127.0.0.1:1', token: 'cnt_test', machineId: 'pc-1'}, 3000, dir);
    assert.equal(probed.relay, 'ok');
    assert.equal(probed.teamMode, true);
    assert.equal(probed.activeTasks?.length, 1);

    const rpcOk = await localBridgeRequest(dir, 'claude.artifact.login', {op: 'check'});
    assert.deepEqual(rpcOk, {signedIn: 'yes', op: 'check'});

    await assert.rejects(() => localBridgeRequest(dir, 'runtime.reload', {}), (error: any) => error instanceof BridgeError && error.code === 'active');

    control.close();
    await assert.rejects(() => stat(join(dir, LOCAL_CONTROL_FILE)));
  } finally {
    control.close();
    await removeTestTemp(dir);
  }
});

test('relay notifies connectors of teamMode, ownToken, and machine_token_mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-relay-tray-'));
  const store = new TeamStore(join(dir, 'relay.sqlite'));
  const relay = createRelay(MAIN, undefined, 0, [], store);
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const url = `ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  const sockets: WebSocket[] = [];
  async function connectConnector(token: string): Promise<{ws: WebSocket; ready?: any; code?: number; reason?: string}> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    await once(ws, 'open');
    const result = new Promise<{ws: WebSocket; ready?: any; code?: number; reason?: string}>(resolve => {
      ws.once('message', raw => resolve({ws, ready: JSON.parse(raw.toString())}));
      ws.once('close', (code, reason) => resolve({ws, code, reason: reason.toString('utf8')}));
    });
    ws.send(JSON.stringify({type: 'hello', role: 'connector', token, machineId: 'pc-a', name: 'Office PC'}));
    return result;
  }
  try {
    const personal = await connectConnector(MAIN);
    assert.equal(personal.ready.teamMode, false);
    assert.equal(personal.ready.ownToken, false);
    personal.ws.close();

    store.createUser({name: 'Ada', role: 'owner'});
    const teamShared = await connectConnector(MAIN);
    assert.equal(teamShared.ready.teamMode, true);
    assert.equal(teamShared.ready.ownToken, false);
    teamShared.ws.close();

    const dedicated = store.createMachineToken('pc-a');
    const rejected = await connectConnector(MAIN);
    assert.equal(rejected.code, 4401);
    assert.equal(rejected.reason, 'machine_token_mismatch');

    const accepted = await connectConnector(dedicated);
    assert.equal(accepted.ready.teamMode, true);
    assert.equal(accepted.ready.ownToken, true);
  } finally {
    for (const ws of sockets) ws.terminate();
    await relay.close();
    store.close();
    await removeTestTemp(dir);
  }
});

test('prepareSettings supports custom machineName and connectionPage hides dedicated tokens', async () => {
  const token = 'cnt_0123456789abcdef0123456789abcdef';
  const saved = await prepareSettings({mode: 'connector', relayUrl: 'https://relay.example', token, machineName: '  研发主机  '});
  assert.equal(saved.machineName, '研发主机');
  const cleared = await prepareSettings({mode: 'connector', relayUrl: 'https://relay.example', token, machineName: '   '}, saved);
  assert.equal(cleared.machineName, hostname());
  await assert.rejects(() => prepareSettings({mode: 'connector', relayUrl: 'https://relay.example', token, machineName: 'x'.repeat(65)}), /64/);

  const html = connectionPage(saved, 'data:image/png;base64,AAAA', 'codex 0.146.0');
  assert.ok(!html.includes(token), 'dedicated machine token must never appear in connect.html');
  assert.ok(!html.includes('#token='), 'team node page must not include #token= links');
  assert.ok(html.includes('打开团队网页'));
});

test('ledger pendingUsageCount tracks unacknowledged team usage turns', () => {
  const ledger = new Ledger(':memory:');
  try {
    assert.equal(ledger.pendingUsageCount(), 0);
    ledger.recordUsage({id: 'codex:t1:turn1', service: 'codex', threadId: 't1', turnId: 'turn1', models: []});
    ledger.recordUsage({id: 'codex:t1:turn2', service: 'codex', threadId: 't1', turnId: 'turn2', models: []});
    assert.equal(ledger.pendingUsageCount(), 2);
    ledger.ackUsage(['codex:t1:turn1']);
    assert.equal(ledger.pendingUsageCount(), 1);
    ledger.ackUsage(['codex:t1:turn2']);
    assert.equal(ledger.pendingUsageCount(), 0);
  } finally {
    ledger.close();
  }
});
