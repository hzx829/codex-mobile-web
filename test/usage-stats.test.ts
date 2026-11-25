import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {Ledger, requestActor} from '../src/connector/ledger.js';
import {Control} from '../src/connector/control.js';
import {claudeDelta, claudeTotals, codexBase, codexTokens, recordClaudeTurn} from '../src/connector/usage-meter.js';
import {createRelay} from '../src/server/relay.js';
import {TeamStore} from '../src/server/team/store.js';
import {formatTokens, groupUsage, rangeDays, usageCsv} from '../web/usage.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const breakdown = (input: number, cached: number, output: number, reasoning: number) =>
  ({totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning});

test('a Codex turn counts the growth of the thread total from before its first model call', () => {
  const base = codexBase(breakdown(1500, 1000, 300, 100), breakdown(500, 400, 100, 50));
  assert.deepEqual(base, {inputTokens: 1000, cachedInputTokens: 600, outputTokens: 200, reasoningOutputTokens: 50});
  assert.deepEqual(codexTokens('gpt-5.5', base, breakdown(2600, 1800, 500, 160)),
    {model: 'gpt-5.5', inputTokens: 1600, cachedInputTokens: 1200, outputTokens: 300, reasoningTokens: 110});
});

test('Claude Code turns are measured from the saved running total, and unknown starts only set it', async () => {
  const ledger = new Ledger(':memory:');
  const usage = (input: number, read: number, write: number, output: number) => ({modelUsage: {'claude-opus-5-5': {inputTokens: input, cacheReadInputTokens: read, cacheCreationInputTokens: write, outputTokens: output}}});
  assert.deepEqual(claudeDelta(claudeTotals(usage(10, 0, 0, 5).modelUsage), claudeTotals(usage(30, 100, 20, 9).modelUsage)),
    [{model: 'claude-opus-5-5', inputTokens: 140, cachedInputTokens: 100, outputTokens: 4, reasoningTokens: 0}]);
  assert.equal(claudeDelta(claudeTotals(usage(30, 0, 0, 9).modelUsage), claudeTotals(usage(5, 0, 0, 1).modelUsage)), undefined, 'a cleared total counts nothing');

  const opId = `${Date.now()}:${randomUUID()}`;
  await requestActor.run({userId: 'u1', name: 'Bo'}, () => ledger.run(opId, {action: 'claude.send'}, async () => ({})));
  recordClaudeTurn(ledger, 'new-session', 'zero', {uuid: 'r1', ...usage(10, 0, 0, 5)}, opId);
  recordClaudeTurn(ledger, 'new-session', 'cursor', {uuid: 'r2', ...usage(25, 50, 0, 8)});
  // Resumed from elsewhere with no saved total: the first turn sets the baseline, the next is measured.
  recordClaudeTurn(ledger, 'old-session', 'cursor', {uuid: 'r3', ...usage(900, 0, 0, 90)});
  recordClaudeTurn(ledger, 'old-session', 'cursor', {uuid: 'r4', ...usage(950, 0, 0, 95)});
  // A crashed turn reporting zeros keeps the saved total.
  recordClaudeTurn(ledger, 'old-session', 'cursor', {uuid: 'r5', modelUsage: {}});
  recordClaudeTurn(ledger, 'old-session', 'cursor', {uuid: 'r6', ...usage(960, 0, 0, 96)});
  const events = ledger.pendingUsage();
  assert.deepEqual(events.map(event => [event.turnId, event.models.map(model => model.inputTokens + model.outputTokens)]),
    [['r1', [15]], ['r2', [68]], ['r3', []], ['r4', [55]], ['r5', []], ['r6', [11]]]);
  assert.deepEqual(events[0].actor, {userId: 'u1', name: 'Bo'});
  ledger.ackUsage(['claude:new-session:r1', 'claude:new-session:r2']);
  assert.equal(ledger.pendingUsage().length, 4);
  ledger.close();
});

test('Codex turns record their tokens from app-server updates and desktop snapshots', async () => {
  const ledger = new Ledger(':memory:');
  class Runtime extends EventEmitter {requests = new Map();rpc() {throw Error('desktop turn must stay on desktop');}close() {}}
  class Desktop extends EventEmitter {
    clientId = 'desktop';calls: any[] = [];
    states = new Map<string, any>([['s', {hostId: 'local', state: {id: 's', turns: [], latestTokenUsageInfo: {total: breakdown(1000, 800, 200, 50), last: breakdown(100, 80, 20, 5)}}}]]);
    async follow() {return {id: 's', turns: [], requests: []};}
    async request(method: string, params: any) {this.calls.push({method, params});return {result: {turn: {id: 'desktop-turn'}}};}
    close() {}
  }
  const runtime = new Runtime(), desktop = new Desktop(), control = new Control(ledger, runtime as any, desktop as any);
  try {
    // App-server turn: updates carry the turn, the first one tells the total before it.
    runtime.emit('event', {method: 'thread/tokenUsage/updated', params: {threadId: 't', turnId: 'turn-1', tokenUsage: {total: breakdown(600, 400, 60, 10), last: breakdown(600, 400, 60, 10)}}});
    runtime.emit('event', {method: 'thread/tokenUsage/updated', params: {threadId: 't', turnId: 'turn-1', tokenUsage: {total: breakdown(1300, 1000, 150, 30), last: breakdown(700, 600, 90, 20)}}});
    runtime.emit('event', {method: 'turn/completed', params: {threadId: 't', turn: {id: 'turn-1', status: 'completed'}}});
    // Desktop turn started from the phone, finished in the desktop's snapshot.
    const opId = `${Date.now()}:${randomUUID()}`;
    const sent = await requestActor.run({userId: 'u2', name: 'Ada'}, () => control.handle({id: randomUUID(), action: 'turn.send', payload: {threadId: 's', source: 'desktop', generation: control.generation, expectedTurnId: null, text: 'hi', opId}}));
    assert.equal(sent.state, 'accepted');
    desktop.states.get('s').state = {id: 's', turns: [{turnId: 'desktop-turn', status: 'completed', items: []}], latestTokenUsageInfo: {total: breakdown(1600, 1200, 290, 70), last: breakdown(600, 400, 90, 20)}};
    desktop.emit('change', 's');
    const events = ledger.pendingUsage();
    assert.deepEqual(events.map(event => [event.id, event.actor?.userId, event.models[0]?.inputTokens, event.models[0]?.outputTokens]),
      [['codex:t:turn-1', undefined, 1300, 150], ['codex:s:desktop-turn', 'u2', 600, 90]]);
  } finally {control.close();}
});

function waitFrame(ws: WebSocket, predicate: (v: any) => boolean): Promise<any> {return new Promise((resolve, reject) => {
  const timer = setTimeout(() => {ws.off('message', listen);reject(Error('frame timeout'));}, 3000);
  const listen = (b: any) => {const value = JSON.parse(b.toString());if (predicate(value)) {clearTimeout(timer);ws.off('message', listen);resolve(value);}};ws.on('message', listen);
});}

test('a team relay stores reported turns once and answers usage by member', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-usage-'));
  const store = new TeamStore(join(dir, 'relay.sqlite'));
  const owner = store.createUser({name: 'Ada', role: 'owner'}), member = store.createUser({name: 'Bo', role: 'member'});
  const relay = createRelay('main-fixture-token-for-usage-tests', undefined, 0, [], store);
  relay.server.listen(0, '127.0.0.1');await once(relay.server, 'listening');
  const url = `ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  const open = async (hello: object) => {const ws = new WebSocket(url);await once(ws, 'open');const ready = waitFrame(ws, frame => frame.type === 'ready');ws.send(JSON.stringify({type: 'hello', ...hello}));return {ws, ready: await ready};};
  let sequence = 0;
  const ask = async (ws: WebSocket, action: string, payload: object = {}) => {const id = `q${++sequence}`;const reply = waitFrame(ws, frame => frame.id === id);ws.send(JSON.stringify({type: 'team', id, action, payload}));return (await reply).result;};
  try {
    const pc = await open({role: 'connector', token: 'main-fixture-token-for-usage-tests', machineId: 'pc-a', name: 'Studio PC'});
    assert.ok(pc.ready.features.includes('team'));
    const now = Date.now();
    const events = [
      {id: 'codex:t1:a', ts: now, service: 'codex', threadId: 't1', turnId: 'a', actor: {userId: member.id}, models: [{model: 'gpt-5.5', inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, reasoningTokens: 40}]},
      {id: 'claude:c1:b', ts: now, service: 'claude', threadId: 'c1', turnId: 'b', actor: {userId: owner.id}, models: [
        {model: 'claude-opus-5-5', inputTokens: 500, cachedInputTokens: 200, outputTokens: 50, reasoningTokens: 0},
        {model: 'claude-haiku-5-5', inputTokens: 30, cachedInputTokens: 0, outputTokens: 3, reasoningTokens: 0}]},
      {id: 'antigravity:g1:c', ts: now, service: 'antigravity', threadId: 'g1', turnId: 'c', models: []},
      {id: 'bad', service: 'other', threadId: 'x', models: []},
    ];
    for (let round = 0; round < 2; round++) {
      const ack = waitFrame(pc.ws, frame => frame.type === 'usage.ack');
      pc.ws.send(JSON.stringify({type: 'usage', events}));
      assert.deepEqual((await ack).ids, ['codex:t1:a', 'claude:c1:b', 'antigravity:g1:c', 'bad'], 'resent turns are confirmed again, not stored twice');
    }
    const ada = await open({role: 'phone', invite: store.createInvite(owner.id, null).code});
    const all = await ask(ada.ws, 'team.usage', {since: now - 86400_000, offsetMinutes: 480});
    assert.equal(all.rows.reduce((sum: number, row: any) => sum + row.turns, 0), 3);
    assert.deepEqual(all.rows.filter((row: any) => row.service === 'claude').map((row: any) => [row.model, row.turns, row.inputTokens]).sort(),
      [['claude-haiku-5-5', 0, 30], ['claude-opus-5-5', 1, 500]]);
    assert.equal(all.rows.find((row: any) => row.service === 'antigravity').inputTokens, null);
    assert.equal(all.rows.find((row: any) => row.service === 'antigravity').userId, null);
    assert.deepEqual(all.machines, [{id: 'pc-a', name: 'Studio PC'}]);
    const bo = await open({role: 'phone', invite: store.createInvite(member.id, owner.id).code});
    const own = await ask(bo.ws, 'team.usage', {since: now - 86400_000, userId: owner.id});
    assert.deepEqual(own.rows.map((row: any) => [row.userId, row.turns, row.inputTokens]), [[member.id, 1, 1000]], 'members only see their own turns');
    assert.deepEqual(own.members, [{id: member.id, name: 'Bo'}]);
    assert.equal(store.owners('pc-a', 'codex', ['t1']).get('t1')?.name, 'Bo', 'a turn names the owner of a session without one');
    for (const socket of [pc.ws, ada.ws, bo.ws]) socket.terminate();
  } finally {await relay.close();store.close();await removeTestTemp(dir);}
});

test('the usage page formats tokens, days and CSV for its readers', () => {
  assert.equal(formatTokens(9999), '9,999');
  assert.equal(formatTokens(12_345), '1.2万');
  assert.equal(formatTokens(4_560_000), '456万');
  assert.equal(formatTokens(250_000_000), '2.5亿');
  assert.equal(formatTokens(null), '—');
  const range = rangeDays(7, new Date(2026, 10, 21, 15, 30));
  assert.deepEqual([range.days[0], range.days.at(-1), range.days.length], ['2026-11-15', '2026-11-21', 7]);
  assert.equal(range.since, new Date(2026, 10, 15).getTime());
  const rows = [
    {day: '2026-11-21', userId: 'u1', machineId: 'pc', service: 'codex', model: 'gpt-5.5', turns: 2, inputTokens: 100, cachedInputTokens: 50, outputTokens: 10, reasoningTokens: 2},
    {day: '2026-11-21', userId: null, machineId: 'pc', service: 'antigravity', model: '', turns: 1, inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null},
    {day: '2026-11-20', userId: 'u1', machineId: 'pc', service: 'codex', model: 'gpt-5.5', turns: 1, inputTokens: 300, cachedInputTokens: 0, outputTokens: 30, reasoningTokens: 0},
  ];
  const byMember = groupUsage(rows, row => row.userId || 'local');
  assert.deepEqual(byMember.map(([name, totals]) => [name, totals.turns, totals.input, totals.known]), [['u1', 3, 400, true], ['local', 1, 0, false]]);
  const csv = usageCsv(rows, id => id === null ? '电脑本机' : '张三, "老张"', () => '工作站');
  assert.ok(csv.startsWith('﻿日期,成员,'));
  assert.ok(csv.includes('2026-11-21,"张三, ""老张""",工作站,Codex,gpt-5.5,2,100,50,10,2\r\n'));
  assert.ok(csv.includes('2026-11-21,电脑本机,工作站,Antigravity,,1,,,,\r\n'));
});

test('a Claude Code turn reports the operation that started it, not later steering', async () => {
  const {ClaudeRuntime} = await import('../src/connector/claude-runtime.js');
  let total = 0;
  const query = (({prompt}: any) => {
    async function* run(): AsyncGenerator<any> {
      yield {type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-test'};
      for await (const input of prompt) {
        // 'first' keeps running until the steering message joins it; the turn ends after both.
        const text = (input.message.content as any[]).find(block => block.type === 'text')?.text;
        yield {type: 'assistant', session_id: 'session-1', message: {}};
        if (text === 'first') continue;
        total += 100;
        yield {type: 'result', subtype: 'success', session_id: 'session-1', uuid: `r${total}`, errors: [], modelUsage: {'claude-test': {inputTokens: total, outputTokens: total / 10}}};
      }
    }
    const generator = run() as any;
    generator.interrupt = async () => {};generator.close = () => {};
    return generator;
  }) as any;
  const runtime = new ClaudeRuntime(async () => query, () => undefined, 60_000);
  const turns: any[] = [];
  runtime.on('turn', (session, result, opId) => turns.push({baseline: session.usageBaseline, uuid: result.uuid, opId}));
  const session = await runtime.start({cwd: tmpdir()});
  runtime.send(session, 'first', [], undefined, 'op-first');
  runtime.send(session, 'steer', [], 'next', 'op-steer');
  await new Promise(resolve => setTimeout(resolve, 50));
  runtime.send(session, 'second', [], undefined, 'op-second');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(turns, [{baseline: 'zero', uuid: 'r100', opId: 'op-first'}, {baseline: 'cursor', uuid: 'r200', opId: 'op-second'}]);
  await runtime.close();
});
