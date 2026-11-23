import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeArtifactTitles, claudeRecordedSettings, claudeTranscriptCwd, claudeTurns, toolActivity} from '../src/connector/claude-transcript.js';
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

test('a background task notification is a status line, not something the user typed', () => {
  const notice = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<output-file>C:\\tmp\\b1.output</output-file>\n'
    + '<status>completed</status>\n<summary>Background command "Run evals" completed (exit code 0)</summary>\n</task-notification>';
  const turns = claudeTurns([
    {type: 'user', uuid: 'u1', message: {role: 'user', content: '跑一下评测'}},
    {type: 'assistant', uuid: 'a1', message: {role: 'assistant', content: [{type: 'text', text: '已在后台运行。'}]}},
    {type: 'user', uuid: 'u2', message: {role: 'user', content: notice}},
    {type: 'assistant', uuid: 'a2', message: {role: 'assistant', content: [{type: 'text', text: '评测通过。'}]}},
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].items.map(item => [item.role, item.text]), [
    ['user', '跑一下评测'], ['assistant', '已在后台运行。'], ['status', 'Background command "Run evals" completed (exit code 0)'], ['assistant', '评测通过。'],
  ]);
});

test('a compaction summary and other injected messages are not shown as the user’s input', () => {
  const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary: …';
  const turns = claudeTurns([
    {type: 'user', uuid: 'u1', message: {role: 'user', content: '重构一下'}},
    {type: 'system', uuid: 's1', message: undefined},
    {type: 'user', uuid: 'u2', message: {role: 'user', content: summary}},
    {type: 'user', uuid: 'u3', message: {role: 'user', content: '<artifact-content-authored-by-others/>\nThe summarized conversation included Artifact content written by people other than you.\n' + summary}},
    {type: 'user', uuid: 'u4', message: {role: 'user', content: 'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] The report follows:\n  done\n</agent-message>'}},
    {type: 'user', uuid: 'u5', message: {role: 'user', content: '<ci-monitor-event>Auto-fix enabled.</ci-monitor-event>'}},
    {type: 'assistant', uuid: 'a1', message: {role: 'assistant', content: [{type: 'text', text: '继续。'}]}},
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].items.map(item => [item.role, item.text]), [
    ['user', '重构一下'], ['activity', '整理上下文'], ['status', '子 Agent 已交回结果'], ['status', 'CI 监控通知'], ['assistant', '继续。'],
  ]);
  // The desktop app's context ahead of a prompt is left out; its Create PR button shows as such.
  const prompts = claudeTurns([
    {type: 'user', uuid: 'p1', message: {role: 'user', content: [{type: 'text', text: '<system-reminder>\nScratch workspace.\n</system-reminder>\n'}, {type: 'text', text: '环境有什么区别？'}]}},
    {type: 'user', uuid: 'p2', message: {role: 'user', content: '<artifact-view-context artifact="x">\n{}\n<artifact-content-authored-by-others/>\n</artifact-view-context>\n\ncommit 吧'}},
    {type: 'user', uuid: 'p3', message: {role: 'user', content: '<create-pr-command>\n## Overview\n</create-pr-command>'}},
    {type: 'user', uuid: 'p4', message: {role: 'user', content: '<agent-message from="a1">\nhi\n</agent-message>'}},
  ]).flatMap(turn => turn.items.map(item => [item.role, item.text]));
  assert.deepEqual(prompts, [['user', '环境有什么区别？'], ['user', 'commit 吧'], ['user', '创建 PR'], ['status', '收到另一个 Claude 会话的消息']]);
});

test('a session’s model, effort and permission mode are read from the latest entries that record them', () => {
  const line = (entry: object) => JSON.stringify(entry);
  const reply = (model: string, extra: object = {}) => line({type: 'assistant', ...extra, message: {role: 'assistant', model, content: []}});
  const transcript = [
    line({type: 'user', permissionMode: 'default', message: {role: 'user', content: '先看看'}}),
    reply('claude-sonnet-4-5', {effort: 'high', perTurnEffort: 'high'}),
    line({type: 'user', permissionMode: 'auto', message: {role: 'user', content: '继续'}}),
    line({type: 'api-request', body: {model: 'claude-haiku-4-5', output_config: {effort: 'low'}}}),
    reply('claude-opus-5-5', {effort: 'xhigh', perTurnEffort: 'xhigh'}),
    reply('claude-haiku-4-5', {isSidechain: true, effort: 'low'}),
    reply('<synthetic>'),
    line({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't', content: 'ok'}]}}),
  ].join('\n');
  assert.deepEqual(claudeRecordedSettings(transcript), {model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'auto'});
  // An older transcript without them says nothing, rather than guessing.
  assert.deepEqual(claudeRecordedSettings(reply('claude-opus-5-5')), {model: 'claude-opus-5-5', effort: '', permissionMode: ''});
  assert.deepEqual(claudeRecordedSettings(''), {model: '', effort: '', permissionMode: ''});
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

test('a session run in the desktop app shows its own settings and keeps them when the phone continues it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    const file = join(project, sid + '.jsonl');
    // As the desktop app writes it: effort on each reply, the permission mode on each prompt.
    const lines = transcript(cwd).trim().split('\n').map(line => {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant') {Object.assign(entry, {effort: 'xhigh', perTurnEffort: 'xhigh'});entry.message.model = 'claude-opus-5-5';}
      if (entry.type === 'user' && typeof entry.message.content === 'string' && !entry.message.content.startsWith('<')) entry.permissionMode = 'bypassPermissions';
      return JSON.stringify(entry);
    });
    await writeFile(file, lines.join('\n') + '\n');
    const old = new Date(Date.now() - 60_000);await utimes(file, old, old);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    const starts: any[] = [];
    let fallback = 'claude-sonnet-4-5';
    const query: QueryFn = ({prompt, options}) => {
      // Reading the model list starts Claude Code briefly too; only resumes are kept.
      if (options?.resume) starts.push(options);
      async function* run(): AsyncGenerator<any> {
        yield {type: 'system', subtype: 'init', session_id: sid};
        for await (const _ of prompt) yield {type: 'result', subtype: 'success', session_id: sid, errors: []};
      }
      const generator = run() as any;
      generator.close = () => {};generator.interrupt = async () => {};
      generator.supportedModels = async () => [{value: 'default', displayName: 'Default', description: '', resolvedModel: fallback}];
      return generator;
    };
    const runtime = new ClaudeRuntime(async () => query, () => undefined, 60_000);
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'), undefined, Date.now, runtime);
    const view = await bridge.handle('claude.read', {conversationId: sid});
    assert.deepEqual([view.model, view.effort, view.permissionMode], ['claude-opus-5-5', 'xhigh', 'bypassPermissions']);

    let n = 0;
    const opId = () => `${Date.now()}:a1b2c3d4-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    // Claude Code's default is another model, so the session's own model, level and mode are named.
    assert.equal((await bridge.handle('claude.send', {conversationId: sid, text: '继续', opId: opId()})).state, 'accepted');
    assert.deepEqual([starts[0].resume, starts[0].model, starts[0].effort, starts[0].permissionMode, starts[0].allowDangerouslySkipPermissions],
      [sid, 'claude-opus-5-5', 'xhigh', 'bypassPermissions', true]);
    const live = await bridge.handle('claude.read', {conversationId: sid});
    assert.deepEqual([live.model, live.effort, live.permissionMode], ['claude-opus-5-5', 'xhigh', 'bypassPermissions']);

    // Editing restarts the session; what the phone picks wins, the rest is kept. A default resolving to the session's own
    // model (here an alias with a context suffix) is left in use.
    fallback = 'claude-opus-5-5[1m]';
    (runtime as any).models = undefined;
    const turn = live.turns.at(-1);
    assert.equal((await bridge.handle('claude.edit', {conversationId: sid, opId: opId(), turnId: turn.id, text: '只跑单元测试', effort: 'high'})).state, 'accepted');
    assert.deepEqual([starts[1].model, starts[1].effort, starts[1].permissionMode], [undefined, 'high', 'bypassPermissions']);
  } finally {
    bridge?.close();ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});

test('a session whose first prompt carries a large image still resumes in its own folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    const file = join(project, sid + '.jsonl');
    // As Claude Code writes it: the image comes first and the entry's cwd after it, past the SDK's 64 KiB head.
    const [first, ...rest] = transcript(cwd).trim().split('\n').map(line => JSON.parse(line));
    const {cwd: _, ...head} = first;
    const image = {type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(100_000)}};
    const lines = [{...head, message: {role: 'user', content: [image, {type: 'text', text: '看看这张图'}]}, cwd}, ...rest,
      {type: 'ai-title', aiTitle: '看图修 bug', sessionId: sid}];
    await writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    const old = new Date(Date.now() - 60_000);await utimes(file, old, old);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    const {getSessionInfo} = await import('@anthropic-ai/claude-agent-sdk');
    assert.equal((await getSessionInfo(sid))?.cwd, undefined, 'the SDK no longer misses the folder; this fallback may be unneeded');

    const starts: any[] = [];
    const query: QueryFn = ({prompt, options}) => {
      if (options?.resume) starts.push(options);
      async function* run(): AsyncGenerator<any> {
        yield {type: 'system', subtype: 'init', session_id: sid};
        for await (const _ of prompt) yield {type: 'result', subtype: 'success', session_id: sid, errors: []};
      }
      const generator = run() as any;
      generator.close = () => {};generator.interrupt = async () => {};
      generator.supportedModels = async () => [];
      return generator;
    };
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'), undefined, Date.now, new ClaudeRuntime(async () => query, () => undefined, 60_000));
    const list = await bridge.handle('claude.list', {});
    assert.deepEqual(list.data.map((item: any) => [item.id, item.cwd]), [[sid, cwd]]);
    assert.deepEqual(list.projects, [{id: cwd, path: cwd}]);
    assert.equal((await bridge.handle('claude.read', {conversationId: sid})).cwd, cwd);
    const sent = await bridge.handle('claude.send', {conversationId: sid, text: '好', opId: `${Date.now()}:a1b2c3d4-0000-4000-8000-000000000001`});
    assert.equal(sent.state, 'accepted', JSON.stringify(sent));
    assert.equal(starts[0].cwd, cwd);
  } finally {
    bridge?.close();ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});

test('a transcript’s folder is where it was last moved, else the first entry that names one', () => {
  const line = (entry: object) => JSON.stringify(entry);
  assert.equal(claudeTranscriptCwd([line({type: 'ai-title', aiTitle: 'x'}), line({type: 'user', cwd: '/a', message: {content: [{type: 'tool_use', input: {cwd: '/z'}}]}}),
    line({type: 'user', cwd: '/b'})].join('\n')), '/a');
  assert.equal(claudeTranscriptCwd([line({type: 'user', cwd: '/a'}), line({type: 'relocated', relocatedCwd: '/b'}), 'not json',
    line({type: 'relocated', relocatedCwd: '/c'})].join('\n')), '/c');
  assert.equal(claudeTranscriptCwd(line({type: 'user', message: {content: '"cwd":"/fake"'}})), undefined);
  assert.equal(claudeTranscriptCwd(''), undefined);
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

/** `count` prompts and replies, compacted after `compactAfter` of them: the SDK returns only what follows the boundary. */
function compactedTranscript(cwd: string, count: number, compactAfter: number) {
  let parent: string | null = null, n = 0;
  const base = {sessionId: sid, cwd, version: '2.1.0', userType: 'external', isSidechain: false};
  const lines: object[] = [];
  const add = (entry: object) => {
    const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    lines.push({parentUuid: parent, ...base, ...entry, uuid, timestamp: new Date(1_790_000_000_000 + n * 1000).toISOString()});
    parent = uuid;
    return uuid;
  };
  for (let index = 1; index <= count; index++) {
    if (index === compactAfter + 1) {
      const last = parent;
      parent = null;
      add({type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', logicalParentUuid: last, compactMetadata: {trigger: 'auto'}});
      add({type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
        message: {role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary…'}});
    }
    add({type: 'user', message: {role: 'user', content: `问题 ${index}`}});
    add({type: 'assistant', message: {id: `msg_${index}`, role: 'assistant', model: 'claude-sonnet-4-5', content: [{type: 'text', text: `回答 ${index}`}]}});
  }
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

test('a compacted session shows what came before the compaction, and the phone can load earlier turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    const file = join(project, sid + '.jsonl');
    await writeFile(file, compactedTranscript(cwd, 100, 90));
    const old = new Date(Date.now() - 60_000);await utimes(file, old, old);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'));
    const text = (turn: any) => turn.items.find((item: any) => item.role === 'user')?.text;

    const view = await bridge.handle('claude.read', {conversationId: sid});
    assert.equal(view.turns.length, 60);assert.equal(view.truncated, true);
    assert.equal(text(view.turns[0]), '问题 41');assert.equal(text(view.turns.at(-1)), '问题 100');
    assert.ok(view.turns.at(-11).items.some((item: any) => item.type === 'contextCompaction'));
    // Edits and forks resume from the branch after the compaction.
    assert.equal(view.turns.find((turn: any) => text(turn) === '问题 50').canFork, false);
    assert.equal(view.turns.find((turn: any) => text(turn) === '问题 95').canFork, true);

    const earlier = await bridge.handle('claude.read', {conversationId: sid, from: view.turns[0].id, earlier: 30});
    assert.equal(earlier.turns.length, 90);assert.equal(text(earlier.turns[0]), '问题 11');assert.equal(earlier.truncated, true);
    // Watching keeps the loaded turns.
    const kept = await bridge.handle('claude.read', {conversationId: sid, from: earlier.turns[0].id});
    assert.equal(text(kept.turns[0]), '问题 11');
    const all = await bridge.handle('claude.read', {conversationId: sid, from: kept.turns[0].id, earlier: 30});
    assert.equal(all.turns.length, 100);assert.equal(text(all.turns[0]), '问题 1');assert.equal(all.truncated, false);
    const ids = all.turns.flatMap((turn: any) => turn.items.map((item: any) => item.id));
    assert.equal(new Set(ids).size, ids.length);

    const edit = await bridge.handle('claude.edit', {conversationId: sid, turnId: all.turns[49].id, text: '改写', opId: `${Date.now()}:a1b2c3d4-0000-4000-8000-000000000001`});
    assert.equal(edit.state, 'failed');assert.match(edit.error.message, /整理上下文之前/);
    await assert.rejects(bridge.handle('claude.read', {conversationId: sid, earlier: -1}), /无效/);
  } finally {
    bridge?.close();ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});

test('what a released session’s own process saves as it exits does not look like a turn under way', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const cwd = join(root, 'work'), project = join(root, 'config', 'projects', 'work');
    await mkdir(cwd, {recursive: true});await mkdir(project, {recursive: true});
    const file = join(project, sid + '.jsonl');
    await writeFile(file, transcript(cwd));
    const old = new Date(Date.now() - 60_000);await utimes(file, old, old);
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
    const query: QueryFn = ({prompt}) => {
      async function* run(): AsyncGenerator<any> {
        yield {type: 'system', subtype: 'init', session_id: sid};
        for await (const _ of prompt) yield {type: 'result', subtype: 'success', session_id: sid, errors: []};
      }
      const generator = run() as any;
      generator.close = () => {};generator.interrupt = async () => {};
      return generator;
    };
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'), undefined, Date.now, new ClaudeRuntime(async () => query, () => undefined, 60_000));
    const sent = await bridge.handle('claude.send', {conversationId: sid, opId: `${Date.now()}:a1b2c3d4-0000-4000-8000-000000000001`, text: '继续'});
    assert.equal(sent.state, 'accepted', JSON.stringify(sent));
    await new Promise(resolve => setTimeout(resolve, 50));
    const live = bridge.runtime.get(sid)!;
    assert.equal(live.running, false);

    // Claude Code saves the session's title, mode and cost as it exits, minutes after the last turn.
    await writeFile(file, transcript(cwd) + JSON.stringify({type: 'ai-title', sessionId: sid, aiTitle: '修复登录 bug'}) + '\n');
    await bridge.runtime.shutdown(live);
    const view = await bridge.handle('claude.read', {conversationId: sid});
    assert.equal(view.controlled, false);
    assert.equal(view.external, false);assert.equal(view.running, false);
    assert.notEqual(view.turns.at(-1).status, 'inProgress');
    assert.equal((await bridge.handle('claude.list', {refresh: true})).data[0].running, false);

    // A terminal that takes the session up afterwards still shows.
    const later = new Date(Date.now() + 10_000);await utimes(file, later, later);
    const resumed = await bridge.handle('claude.read', {conversationId: sid});
    assert.equal(resumed.external, true);assert.equal(resumed.running, true);
  } finally {
    bridge?.close();ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});
