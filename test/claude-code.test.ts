import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeTurns, toolActivity} from '../src/connector/claude-transcript.js';
import {ClaudeCodeBridge} from '../src/connector/claude-code.js';
import {removeTestTemp} from '../scripts/test-temp.js';

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
    assert.deepEqual(list.projects, [{id: cwd, path: cwd, kind: 'folder'}]);
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
