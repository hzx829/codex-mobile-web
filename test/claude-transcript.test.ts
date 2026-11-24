import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, appendFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exchangeStep, lastExchange} from '../src/connector/claude-transcript.js';
import {ClaudeCodeBridge} from '../src/connector/claude-code.js';
import {Ledger} from '../src/connector/ledger.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const sid = '7a1b2c3d-1111-4222-8333-444455556666';
const at = (ms: number) => new Date(ms).toISOString();
const prompt = (text: string, time: number) => ({type: 'user', sessionId: sid, timestamp: at(time), message: {role: 'user', content: text}});
const reply = (stop: string | null, time: number, content: object[] = [{type: 'text', text: '好'}]) =>
  ({type: 'assistant', sessionId: sid, timestamp: at(time), message: {role: 'assistant', stop_reason: stop, content}});
const toolResult = (time: number) => ({type: 'user', sessionId: sid, timestamp: at(time), message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', content: 'ok'}]}});
/** What Claude Code, the desktop app and the SDK append that is not the conversation: none of it carries a turn. */
const bookkeeping = (time: number) => [
  {type: 'last-prompt', sessionId: sid, lastPrompt: '修一下'}, {type: 'ai-title', sessionId: sid, aiTitle: '修复登录'},
  {type: 'custom-title', sessionId: sid, customTitle: '登录问题'}, {type: 'mode', sessionId: sid, mode: 'default'},
  {type: 'cost-state', sessionId: sid}, {type: 'session-owner', sessionId: sid}, {type: 'pr-link', sessionId: sid, timestamp: at(time)},
  {type: 'api-request', timestamp: at(time)}, {type: 'queue-operation', timestamp: at(time)},
];
const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';

test('only a conversation step opens or closes a turn', () => {
  assert.equal(exchangeStep(prompt('修一下', 0)), true);
  assert.equal(exchangeStep(toolResult(0)), true);
  assert.equal(exchangeStep(reply('tool_use', 0, [{type: 'tool_use', id: 't1', name: 'Bash', input: {}}])), true);
  assert.equal(exchangeStep(reply(null, 0)), true);
  for (const stop of ['end_turn', 'stop_sequence', 'max_tokens', 'refusal']) assert.equal(exchangeStep(reply(stop, 0)), false);
  assert.equal(exchangeStep(prompt('[Request interrupted by user]', 0)), false);
  assert.equal(exchangeStep({...prompt('', 0), message: {role: 'user', content: [{type: 'text', text: '[Request interrupted by user for tool use]'}]}}), false);
  for (const local of ['<command-name>/model</command-name>', '<local-command-stdout>Set model</local-command-stdout>', '<bash-input>ls</bash-input>'])
    assert.equal(exchangeStep(prompt(local, 0)), undefined);
  assert.equal(exchangeStep({...prompt('caveat', 0), isMeta: true}), undefined);
  assert.equal(exchangeStep({...prompt('summary', 0), isCompactSummary: true}), undefined);
  assert.equal(exchangeStep({...prompt('subagent', 0), isSidechain: true}), undefined);
  for (const entry of bookkeeping(0)) assert.equal(exchangeStep(entry), undefined);
});

test('the last exchange is read from the end, across chunks and long lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-exchange-'));
  try {
    const file = join(dir, sid + '.jsonl');
    const long = 'x'.repeat(5000);
    await writeFile(file, lines([prompt('修一下', 1000), reply('end_turn', 2000, [{type: 'text', text: long}]), ...bookkeeping(3000)]));
    for (const chunk of [16, 1000, 64 << 10]) assert.deepEqual(await lastExchange(file, 16 << 20, chunk), {open: false, at: 3000});

    // A prompt, then a long tool call whose progress is logged: open, with the progress as its latest activity.
    await appendFile(file, lines([prompt('再看看', 4000), reply('tool_use', 5000, [{type: 'tool_use', id: 't1', name: 'Bash', input: {}}]),
      {type: 'progress', timestamp: at(9000), data: {output: long}}, {type: 'ai-title', aiTitle: '再看看'}]));
    for (const chunk of [16, 1000, 64 << 10]) assert.deepEqual(await lastExchange(file, 16 << 20, chunk), {open: true, at: 9000});

    assert.equal(await lastExchange(file, 100, 16), null);
    await writeFile(file, lines(bookkeeping(1000)));
    assert.equal(await lastExchange(file), undefined);
    await writeFile(file, '');
    assert.equal(await lastExchange(file), undefined);
  } finally {await removeTestTemp(dir);}
});

test('no bookkeeping write, whoever makes it, shows a finished session as running; an open turn still does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    const file = join(project, sid + '.jsonl');
    const base = {sessionId: sid, cwd};
    const conversation = (entries: object[]) => entries.map((entry, n) => ({...base, ...entry, uuid: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
      parentUuid: n ? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` : null}));
    const old = Date.now() - 10 * 60_000;
    const finished = conversation([prompt('修一下', old), reply('end_turn', old + 1000)]);
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'));
    const state = async () => {
      const view = await bridge!.handle('claude.read', {conversationId: sid});
      const listed = (await bridge!.handle('claude.list', {refresh: true})).data.find((item: any) => item.id === sid);
      return {external: view.external, running: view.running, last: view.turns.at(-1)?.status, listed: listed?.running};
    };
    const idle = {external: false, running: false, last: 'completed', listed: false};

    // Each of these lands just now on a session whose last turn ended ten minutes ago.
    for (const entry of bookkeeping(Date.now())) {
      await writeFile(file, lines([...finished, {...base, ...entry}]));
      assert.deepEqual(await state(), idle, JSON.stringify(entry));
    }
    // A session left mid-turn long ago and only renamed now.
    await writeFile(file, lines([...conversation([prompt('修一下', old), reply('tool_use', old + 1000, [{type: 'tool_use', id: 't1', name: 'Bash', input: {}}])]),
      {...base, type: 'custom-title', customTitle: '登录问题'}]));
    assert.equal((await state()).running, false);

    // A terminal sending a prompt, then running a tool: running.
    await writeFile(file, lines([...finished, ...conversation([prompt('再看看', Date.now())]).map(entry => ({...entry, uuid: '00000000-0000-4000-8000-0000000000aa'}))]));
    assert.equal((await state()).external, true);
    await writeFile(file, lines([...finished, {...base, ...toolResult(Date.now()), uuid: '00000000-0000-4000-8000-0000000000ab'}]));
    const busy = await state();
    assert.equal(busy.external, true);assert.equal(busy.running, true);assert.equal(busy.listed, true);
    // The turn ends: idle again at once, though the file was just written.
    await appendFile(file, lines([{...base, ...reply('end_turn', Date.now()), uuid: '00000000-0000-4000-8000-0000000000ac'}]));
    const now = new Date();await utimes(file, now, now);
    assert.deepEqual(await state(), idle);
  } finally {
    bridge?.close();ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});
