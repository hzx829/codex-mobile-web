import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPlan, entryTimestamp, readPeerStatuses} from '../src/connector/claude-progress.js';
import {claudeTurns} from '../src/connector/claude-transcript.js';
import {ClaudeCodeBridge} from '../src/connector/claude-code.js';
import {Ledger} from '../src/connector/ledger.js';
import {removeTestTemp} from '../scripts/test-temp.js';
import {randomUUID} from 'node:crypto';

const opId = () => `${Date.now()}:${randomUUID()}`;

const sid = '21111111-2222-4333-8444-555555555555';
const plan = (steps: ReturnType<typeof applyPlan>) => steps?.map(step => `${step.status}:${step.text}`);

test('the desktop app’s plan updates and TodoWrite give the plan as it stands', () => {
  const first = applyPlan(undefined, 'mcp__ccd_turn__update_plan', {scope: 'continuation', items: [
    {content: 'Commit', status: 'in_progress'}, {content: 'Run Gate 0', status: 'pending'}, {content: 'Run step 1', status: 'pending'}, {content: '', status: 'pending'}]});
  assert.deepEqual(plan(first), ['in_progress:Commit', 'pending:Run Gate 0', 'pending:Run step 1']);
  // Step numbers count from 1; `start` moves the step under way, `advance` completes it and starts the next.
  assert.deepEqual(plan(applyPlan(first, 'mcp__ccd_turn__update_plan', {done: [1], start: 3})), ['completed:Commit', 'pending:Run Gate 0', 'in_progress:Run step 1']);
  assert.deepEqual(plan(applyPlan(first, 'mcp__ccd_turn__update_plan', {advance: true})), ['completed:Commit', 'in_progress:Run Gate 0', 'pending:Run step 1']);
  assert.deepEqual(plan(applyPlan(first, 'mcp__ccd_turn__update_plan', {done: [9], start: 0})), plan(first));
  assert.equal(applyPlan(undefined, 'mcp__ccd_turn__update_plan', {advance: true}), undefined);
  assert.deepEqual(plan(applyPlan(first, 'TodoWrite', {todos: [{content: 'Read', status: 'completed', activeForm: 'Reading'}, {content: 'Fix', status: 'weird'}]})),
    ['completed:Read', 'pending:Fix']);
});

test('a running turn says what it is doing and since when; each turn keeps the plan it left', () => {
  const messages = [
    {type: 'user', uuid: 'u1', message: {role: 'user', content: 'Commit and run'}},
    {type: 'assistant', uuid: 'a1', message: {role: 'assistant', content: [{type: 'tool_use', id: 't1', name: 'mcp__ccd_turn__update_plan',
      input: {items: [{content: 'Commit', status: 'in_progress'}, {content: 'Run evals', status: 'pending'}]}}]}},
    {type: 'user', uuid: 'r1', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', content: 'Plan updated'}]}},
    {type: 'assistant', uuid: 'a2', message: {role: 'assistant', content: [{type: 'tool_use', id: 't2', name: 'mcp__ccd_turn__update_plan', input: {advance: true}}]}},
    {type: 'user', uuid: 'r2', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't2', content: 'Plan updated'}]}},
    {type: 'assistant', uuid: 'a3', message: {role: 'assistant', content: [{type: 'tool_use', id: 't3', name: 'Bash',
      input: {command: 'for i in $(seq 1 190); do sleep 3; done', description: 'Wait for the step 1 eval summaries'}}]}},
  ];
  const times: Record<string, string> = {a3: '2026-11-22T13:39:10.355Z', r2: '2026-11-22T13:39:01.000Z'};
  const [turn] = claudeTurns(messages, true, undefined, undefined, uuid => times[uuid] || '');
  assert.equal(turn.status, 'inProgress');
  assert.deepEqual(plan(turn.plan), ['completed:Commit', 'in_progress:Run evals']);
  assert.deepEqual(turn.step, {text: 'Wait for the step 1 eval summaries', type: 'commandExecution', item: 'a3:0', startedAt: '2026-11-22T13:39:10.355Z'});
  assert.equal(turn.items.find(item => item.id === 'a2:0')?.type, 'plan');
  // Between calls the model is at work: no call to name, the time counts from the latest entry.
  const thinking = claudeTurns(messages.slice(0, 5), true, undefined, undefined, uuid => times[uuid] || '')[0];
  assert.deepEqual(thinking.step, {text: '', startedAt: '2026-11-22T13:39:01.000Z'});
  // A finished turn has no step; the next turn shows the plan only once it changes it.
  const done = claudeTurns([...messages, {type: 'user', uuid: 'r3', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't3', content: 'ok'}]}},
    {type: 'user', uuid: 'u2', message: {role: 'user', content: '下一步'}}], false);
  assert.equal(done[0].step, undefined);assert.ok(done[0].plan);assert.equal(done[1].plan, undefined);
});

test('a transcript entry’s time is read from the raw transcript by uuid', () => {
  const raw = [JSON.stringify({parentUuid: 'x', uuid: 'a', timestamp: '2026-11-22T13:00:00.000Z'}), JSON.stringify({parentUuid: 'a', uuid: 'b', timestamp: '2026-11-22T13:00:05.000Z'})].join('\n');
  assert.equal(entryTimestamp(raw, 'a'), '2026-11-22T13:00:00.000Z');
  assert.equal(entryTimestamp(raw, 'b'), '2026-11-22T13:00:05.000Z');
  assert.equal(entryTimestamp(raw, 'c'), '');
});

test('Claude Code’s own session reports say which sessions are busy; reports of exited processes are ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-peers-'));
  try {
    await mkdir(join(root, 'sessions'));
    const report = (pid: number, sessionId: string, status: string, at: number, extra = {}) =>
      writeFile(join(root, 'sessions', `${pid}.json`), JSON.stringify({pid, sessionId, status, statusUpdatedAt: at, updatedAt: at, ...extra}));
    await report(10, 'a', 'busy', 1);
    await report(11, 'b', 'waiting', 1, {waitingFor: 'permission'});
    await report(12, 'a', 'idle', 0);
    await report(13, 'c', 'busy', 5);
    await writeFile(join(root, 'sessions', '14.json'), '{broken');
    const statuses = await readPeerStatuses(root, pid => pid !== 13);
    assert.deepEqual(Object.fromEntries(statuses), {a: {status: 'busy', updatedAt: 1}, b: {status: 'waiting', waitingFor: 'permission', updatedAt: 1}});
    assert.equal((await readPeerStatuses(join(root, 'missing'))).size, 0);
  } finally {await removeTestTemp(root);}
});

test('a session the desktop app is running stays running through a long call, and a send waits for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-peer-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const cwd = join(root, 'work'), config = join(root, 'config'), project = join(config, 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});await mkdir(join(config, 'sessions'));
    const base = {sessionId: sid, cwd, version: '2.1.330', isSidechain: false};
    const lines = [
      {...base, type: 'user', uuid: '30000000-0000-4000-8000-000000000001', parentUuid: null, timestamp: '2026-11-22T13:30:00.000Z', message: {role: 'user', content: 'Commit and run'}},
      {...base, type: 'assistant', uuid: '30000000-0000-4000-8000-000000000002', parentUuid: '30000000-0000-4000-8000-000000000001', timestamp: '2026-11-22T13:39:10.355Z',
        message: {id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {command: 'sleep 600', description: 'Wait for the step 1 eval summaries'}}]}},
    ];
    const file = join(project, sid + '.jsonl');
    await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    // The call has run for minutes: the transcript has not been written since.
    const old = new Date(Date.now() - 5 * 60_000);await utimes(file, old, old);
    const status = (value: string) => writeFile(join(config, 'sessions', `${process.pid}.json`),
      JSON.stringify({pid: process.pid, sessionId: sid, cwd, status: value, statusUpdatedAt: Date.now(), kind: 'interactive', entrypoint: 'claude-desktop'}));
    await status('busy');
    process.env.CLAUDE_CONFIG_DIR = config;
    let clock = 0;
    bridge = new ClaudeCodeBridge(ledger, config, undefined, () => Date.now() + clock);

    assert.equal((await bridge.handle('claude.list', {})).data[0].running, true);
    const view = await bridge.handle('claude.read', {conversationId: sid});
    assert.equal(view.running, true);assert.equal(view.external, true);assert.equal(view.externalStatus, 'busy');
    assert.match(view.notice, /正在运行这条会话.*排队/);
    assert.equal(view.turns.at(-1).status, 'inProgress');
    assert.deepEqual(view.turns.at(-1).step, {text: 'Wait for the step 1 eval summaries', type: 'commandExecution', item: '30000000-0000-4000-8000-000000000002:0', startedAt: '2026-11-22T13:39:10.355Z'});

    // A plain send waits on this computer instead of starting a second writer.
    const sent = await bridge.handle('claude.send', {conversationId: sid, text: '跑完告诉我', opId: opId()});
    assert.equal(sent.kind, 'queued');
    assert.equal((await bridge.handle('claude.read', {conversationId: sid})).queuedMessages.length, 1);

    // The app is now blocked on a dialog: still running, and the revision changes so watching phones see it.
    await status('waiting');clock += 1000;
    const waiting = await bridge.handle('claude.read', {conversationId: sid});
    assert.equal(waiting.externalStatus, 'waiting');assert.equal(waiting.running, true);assert.notEqual(waiting.revision, view.revision);

    // Leave nothing queued for the drain to send through a real Claude Code once the app is idle.
    await bridge.handle('claude.cancelQueued', {conversationId: sid, queuedId: ledger.claudeQueue.queued(sid)[0].id, opId: opId()});
    await status('idle');clock += 1000;
    const idle = await bridge.handle('claude.read', {conversationId: sid});
    assert.equal(idle.running, false);assert.equal(idle.external, false);assert.equal(idle.externalStatus, '');
  } finally {
    bridge?.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});
