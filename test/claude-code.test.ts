import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeArtifactTitles, claudeTurns, toolActivity} from '../src/connector/claude-transcript.js';
import {ClaudeCodeBridge} from '../src/connector/claude-code.js';
import {removeTestTemp} from '../scripts/test-temp.js';
import {Ledger} from '../src/connector/ledger.js';
import {ClaudeRuntime, type QueryFn} from '../src/connector/claude-runtime.js';

const sid = '11111111-2222-4333-8444-555555555555';

function transcript(cwd: string) {
  let parent: string | null = null, n = 0;
  const base = {sessionId: sid, cwd, version: '2.1.0', gitBranch: 'main', userType: 'external', isSidechain: false};
  const lines: object[] = [];
  const add = (entry: object) => {
    const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    lines.push({...base, ...entry, uuid, parentUuid: parent, timestamp: new Date(1_790_000_000_000 + n * 1000).toISOString()});
    parent = uuid;
  };
  const assistant = (id: string, block: object) => add({type: 'assistant', message: {id, role: 'assistant', model: 'claude-sonnet-4-5', content: [block]}});
  add({type: 'user', message: {role: 'user', content: '修复登录 bug'}});
  assistant('msg_1', {type: 'thinking', thinking: '先看代码', signature: 'x'});
  assistant('msg_1', {type: 'text', text: '我先看看代码。'});
  assistant('msg_1', {type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {command: 'ls'}});
  add({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts'}]}});
  assistant('msg_2', {type: 'tool_use', id: 'toolu_2', name: 'Edit', input: {file_path: join(cwd, 'a.ts'), old_string: 'a', new_string: 'b'}});
  add({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok'}]}});
  assistant('msg_3', {type: 'text', text: '改好了，见 `a.ts`。'});
  add({type: 'user', message: {role: 'user', content: '<command-name>/model</command-name>\n<command-args>opus</command-args>'}});
  add({type: 'user', message: {role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>'}});
  add({type: 'user', message: {role: 'user', content: [{type: 'text', text: '再跑一遍测试'}]}});
  assistant('msg_4', {type: 'tool_use', id: 'toolu_3', name: 'Bash', input: {command: 'npm test'}});
  add({type: 'user', message: {role: 'user', content: [{type: 'text', text: '[Request interrupted by user for tool use]'}]}});
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

test('Claude Code transcripts become Codex-style turns', () => {
  const lines = transcript('/work').trim().split('\n').map(line => JSON.parse(line));
  const turns = claudeTurns(lines.map(line => ({type: line.type, uuid: line.uuid, message: line.message, parent_tool_use_id: null})));
  assert.equal(turns.length, 3);
  const [first, command, last] = turns;
  assert.deepEqual(first.items.map(item => [item.role, item.type]), [
    ['user', 'userMessage'], ['activity', 'reasoning'], ['assistant', 'agentMessage'], ['activity', 'commandExecution'],
    ['activity', 'fileChange'], ['assistant', 'agentMessage'],
  ]);
  assert.equal(first.items[3].text, '$ ls\na.ts\nb.ts');
  assert.deepEqual(first.items[4].files, [join('/work', 'a.ts')]);
  assert.equal(command.items[0].text, '/model opus');
  assert.deepEqual(command.items.slice(1).map(item => [item.role, item.text]), [['status', 'Set model to opus']]);
  assert.equal(last.items[0].text, '再跑一遍测试');
  assert.equal(last.status, 'interrupted');
  // A fork ends at the turn's last entry: the reply, not the next prompt.
  assert.equal(first.anchor, lines[7].uuid);assert.equal(first.canFork, true);
  assert.equal(last.anchor, lines.at(-1).uuid);
  assert.equal(claudeTurns([{type: 'user', uuid: 'u', message: {content: 'hi'}}], true)[0].status, 'inProgress');
  assert.equal(toolActivity({name: 'TodoWrite', input: {todos: [{content: 'a', status: 'completed'}, {content: 'b', status: 'pending'}]}}).text, '[x] a\n[ ] b');
  assert.equal(toolActivity({name: 'mcp__x__y', input: {q: 1}}).type, 'toolCall');
});

test('connector lists, reads and watches Claude Code sessions from the local transcripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    await writeFile(join(cwd, 'a.ts'), 'export const a = 1;\n');
    const file = join(project, sid + '.jsonl');
    await writeFile(file, transcript(cwd));
    const old = new Date(Date.now() - 60_000);await utimes(file, old, old);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    let clockOffset = 0;
    const bridge = new ClaudeCodeBridge(undefined, join(root, 'config'), undefined, () => Date.now() + clockOffset);

    const list = await bridge.handle('claude.list', {});
    assert.deepEqual(list.data.map((item: any) => [item.id, item.title, item.cwd, item.running]), [[sid, '修复登录 bug', cwd, false]]);
    assert.deepEqual(list.projects, [{id: cwd, path: cwd}]);
    assert.equal((await bridge.handle('claude.list', {search: '不存在'})).data.length, 0);
    assert.equal((await bridge.handle('claude.list', {project: join(root, 'other')})).data.length, 0);

    const view = await bridge.handle('claude.read', {conversationId: sid});
    assert.equal(view.title, '修复登录 bug');assert.equal(view.cwd, cwd);assert.equal(view.model, 'claude-sonnet-4-5');
    assert.equal(view.running, false);assert.equal(view.turns.length, 3);

    const file2 = await bridge.handle('claude.file.read', {conversationId: sid, path: 'a.ts'});
    assert.equal(file2.text, 'export const a = 1;\n');

    const watching = bridge.handle('claude.watch', {conversationId: sid, revision: view.revision});
    await new Promise(resolve => setTimeout(resolve, 100));
    await writeFile(file, transcript(cwd) + JSON.stringify({type: 'user', sessionId: sid, cwd, uuid: '00000000-0000-4000-8000-999999999999',
      parentUuid: '00000000-0000-4000-8000-000000000013', timestamp: new Date().toISOString(), message: {role: 'user', content: '还有一个问题'}}) + '\n');
    const next = await watching;
    assert.notEqual(next.revision, view.revision);
    assert.equal(next.running, true);
    assert.equal(next.turns.at(-1).items[0].text, '还有一个问题');
    assert.equal(next.turns.at(-1).status, 'inProgress');

    const waitingForIdle = bridge.handle('claude.watch', {conversationId: sid, revision: next.revision});
    await new Promise(resolve => setTimeout(resolve, 100));
    clockOffset = 30_000;
    const idle = await waitingForIdle;
    assert.equal(idle.external, false);
    assert.equal(idle.running, false);

    await assert.rejects(bridge.handle('claude.read', {conversationId: '../x'}), /无效/);
    await assert.rejects(bridge.handle('claude.read', {conversationId: '99999999-2222-4333-8444-555555555555'}), /找不到/);
    await assert.rejects(bridge.handle('claude.delete', {conversationId: sid}), /暂不支持/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});

test('connector forks, copies, renames and archives Claude Code sessions with the SDK', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    const file = join(project, sid + '.jsonl');
    await writeFile(file, transcript(cwd));
    const old = new Date(Date.now() - 60_000);await utimes(file, old, old);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    const bridge = new ClaudeCodeBridge(ledger, join(root, 'config'));
    let op = 0;
    const run = async (action: string, payload: object) => {
      const result = await bridge.handle(action, {conversationId: sid, opId: `${Date.now()}:a1b2c3d4-0000-4000-8000-${String(++op).padStart(12, '0')}`, ...payload});
      assert.equal(result.state, 'accepted', JSON.stringify(result));
      return result;
    };

    const view = await bridge.handle('claude.read', {conversationId: sid});
    const forked = await run('claude.fork', {upToMessageId: view.turns[0].anchor});
    const branch = await bridge.handle('claude.read', {conversationId: forked.conversationId});
    assert.equal(branch.title, '修复登录 bug（分叉）');
    assert.equal(branch.turns.length, 1);
    assert.deepEqual(branch.turns[0].items.map((item: any) => item.text), view.turns[0].items.map((item: any) => item.text));

    const copy = await run('claude.fork', {});
    assert.equal((await bridge.handle('claude.read', {conversationId: copy.conversationId})).turns.length, 3);
    const missing = await bridge.handle('claude.fork', {conversationId: sid, opId: `${Date.now()}:a1b2c3d4-0000-4000-8000-ffffffffffff`, upToMessageId: '00000000-0000-4000-8000-0000000000ff'});
    assert.equal(missing.state, 'failed');

    await run('claude.rename', {title: '登录问题'});
    assert.equal((await bridge.handle('claude.read', {conversationId: sid})).title, '登录问题');
    await run('claude.archive', {});
    const list = await bridge.handle('claude.list', {refresh: true});
    assert.equal(list.data.some((item: any) => item.id === sid), false);
    assert.equal(list.data.length, 2);
  } finally {
    ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});

test('editing a message resumes the session from the turn before it, with diffs from the transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    const file = join(project, sid + '.jsonl');
    // The Edit's result carries the patch, as Claude Code writes it.
    const text = transcript(cwd).split('\n').map(line => {
      if (!line.includes('toolu_2')) return line;
      const entry = JSON.parse(line);
      if (entry.type !== 'user') return line;
      entry.toolUseResult = {filePath: join(cwd, 'a.ts'), structuredPatch: [{oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b']}]};
      return JSON.stringify(entry);
    }).join('\n');
    await writeFile(file, text);
    const old = new Date(Date.now() - 60_000);await utimes(file, old, old);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    const starts: any[] = [];
    const sent: any[] = [];
    const query: QueryFn = ({prompt, options}) => {
      starts.push(options);
      async function* run(): AsyncGenerator<any> {
        yield {type: 'system', subtype: 'init', session_id: sid};
        for await (const message of prompt) {sent.push(message);yield {type: 'result', subtype: 'success', session_id: sid, errors: []};}
      }
      const generator = run() as any;
      generator.close = () => {};generator.interrupt = async () => {};
      return generator;
    };
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'), undefined, Date.now, new ClaudeRuntime(async () => query, () => undefined, 60_000));
    const view = await bridge.handle('claude.read', {conversationId: sid});
    assert.match(view.turns[0].diff, /^diff --git a\/a\.ts b\/a\.ts\n--- a\/a\.ts\n\+\+\+ b\/a\.ts\n@@ -1,1 \+1,1 @@\n-a\n\+b\n$/);
    assert.equal(view.turns[1].diff, undefined);
    const opId = () => `${Date.now()}:a1b2c3d4-0000-4000-8000-${String(starts.length + sent.length + Math.floor(Math.random() * 1e6)).padStart(12, '0')}`;

    const first = await bridge.handle('claude.edit', {conversationId: sid, opId: opId(), turnId: view.turns[0].id, text: '改一下'});
    assert.equal(first.state, 'failed');assert.match(first.error.message, /第一条消息不能改写/);

    const last = view.turns.at(-1);
    const edited = await bridge.handle('claude.edit', {conversationId: sid, opId: opId(), turnId: last.id, text: '只跑单元测试'});
    assert.equal(edited.state, 'accepted', JSON.stringify(edited));
    assert.equal(starts.at(-1).resume, sid);
    assert.equal(starts.at(-1).resumeSessionAt, view.turns.at(-2).anchor);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(sent.at(-1).message.content.at(-1).text, '只跑单元测试');
  } finally {
    bridge?.close();ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});

test('claude.ai pages are named from the raw transcript and repeated on the newest turn', () => {
  const page = 'https://claude.ai/artifact/FR2QT5upk4yhRE2SLNe2oM', type = 'https://claude.ai/artifact/GZLZthZ2sQjn7T16skfdeF';
  const user = (uuid: string, content: unknown) => ({type: 'user', uuid, message: {role: 'user', content}});
  const call = (uuid: string, id: string, input: Record<string, unknown>) => ({type: 'assistant', uuid, message: {role: 'assistant', content: [{type: 'tool_use', id, name: 'Artifact', input}]}});
  const result = (uuid: string, id: string, text: string) => user(uuid, [{type: 'tool_result', tool_use_id: id, content: text}]);
  // The call that created and named the page sits on a branch the SDK's messages no longer follow.
  const created = [user('a', '做个看板'), call('b', 't1', {action: 'publish', type_url: type, title: '持仓决策看板'}), result('c', 't1', `Created a new Artifact at ${page} from the Artifact type ${type}`)];
  const branch = [user('d', '改一下'), call('e', 't2', {action: 'open', url: page}), result('f', 't2', 'Opened.'), user('g', '提交')];
  const raw = [...created, ...branch].map(line => JSON.stringify(line)).join('\n');
  const titles = claudeArtifactTitles(raw);
  assert.deepEqual([...titles], [[page, '持仓决策看板']]);
  const turns = claudeTurns(branch.map(line => ({...line, parent_tool_use_id: null})), false, undefined, titles);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].pages, [{url: page, title: '持仓决策看板', changed: 't2', shown: 't2'}]);
  assert.deepEqual(turns[1].pages, [{url: page, title: '持仓决策看板', earlier: true}]);
  // A page the newest turn already shows is not repeated, and a turn with no pages anywhere gets none.
  assert.deepEqual(claudeTurns(branch.slice(0, 3).map(line => ({...line, parent_tool_use_id: null})), false, undefined, titles).at(-1)?.pages, [{url: page, title: '持仓决策看板', changed: 't2', shown: 't2'}]);
  assert.equal(claudeTurns([{type: 'user', uuid: 'u', message: {content: 'hi'}}]).at(-1)?.pages, undefined);
});
