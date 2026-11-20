import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, appendFile, writeFile, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClaudeCodeBridge} from '../src/connector/claude-code.js';
import {ClaudeRuntime, claudeEnv, findClaude, userMessage, type QueryFn} from '../src/connector/claude-runtime.js';
import {Ledger} from '../src/connector/ledger.js';
import {removeTestTemp} from '../scripts/test-temp.js';
import {readFile} from 'node:fs/promises';
import {uploadAttachments} from '../web/file-upload.js';
import {fileReference} from '../web/preview-target.js';

const opId = () => `${Date.now()}:${randomUUID()}`;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, timeout = 3000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {const value = await read();if (ok(value)) return value;if (Date.now() > deadline) throw new Error('timed out: ' + JSON.stringify(value));await wait(20);}
}

/** A stand-in for the Claude Code process: answers each prompt, asks for tools on request, and writes the transcript. */
function fakeClaude(projects: string) {
  const calls: any[] = [], answers: any[] = [];
  const query: QueryFn = ({prompt, options}) => {
    const id = options?.resume || randomUUID();
    const file = join(projects, 'work', id + '.jsonl');
    let parent: string | null = null, interrupted = false, closed = false;
    // A resumed process continues the existing chain, as the CLI does.
    try {parent = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1)!).uuid;} catch {}
    const write = async (entry: object) => {
      const uuid = randomUUID();
      await appendFile(file, JSON.stringify({sessionId: id, cwd: options?.cwd, isSidechain: false, userType: 'external', version: '2.1.0', ...entry, uuid, parentUuid: parent, timestamp: new Date().toISOString()}) + '\n');
      parent = uuid;
    };
    calls.push({type: 'start', options});
    async function* run(): AsyncGenerator<any> {
      yield {type: 'system', subtype: 'init', session_id: id, model: options?.model || 'claude-test', permissionMode: options?.permissionMode, cwd: options?.cwd};
      for await (const input of prompt) {
        if (closed) return;
        const text = (input.message.content as any[]).find(block => block.type === 'text')?.text || '';
        calls.push({type: 'message', text, priority: input.priority, images: (input.message.content as any[]).filter(block => block.type === 'image').length});
        await write({type: 'user', message: {role: 'user', content: text}});
        yield {type: 'system', subtype: 'session_state_changed', state: 'running', session_id: id};
        if (text.startsWith('run ')) {
          const command = text.slice(4);
          const result = await options!.canUseTool!('Bash', {command}, {signal: new AbortController().signal, suggestions: [{type: 'addRules', rules: [{toolName: 'Bash'}], behavior: 'allow', destination: 'session'}]} as any);
          answers.push(result);
          await write({type: 'assistant', message: {id: 'm', role: 'assistant', model: 'claude-test', content: [{type: 'tool_use', id: 't1', name: 'Bash', input: {command}}]}});
        }
        if (text === 'ask') {
          answers.push(await options!.canUseTool!('AskUserQuestion', {questions: [{question: '用哪个数据库？', header: '数据库', multiSelect: false, options: [{label: 'SQLite', description: ''}, {label: 'Postgres', description: ''}]}]}, {signal: new AbortController().signal} as any));
        }
        if (text === 'slow') await until(() => interrupted || closed, Boolean, 5000);
        await write({type: 'assistant', message: {id: 'r', role: 'assistant', model: 'claude-test', content: [{type: 'text', text: interrupted ? '已停止' : `好的：${text}`}]}});
        yield {type: 'assistant', session_id: id, message: {}};
        yield {type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', session_id: id, errors: []};
        yield {type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: id};
        interrupted = false;
      }
    }
    const generator = run() as any;
    generator.interrupt = async () => {interrupted = true;calls.push({type: 'interrupt'});};
    generator.setModel = async (model: string) => {calls.push({type: 'model', model});};
    generator.setPermissionMode = async (mode: string) => {calls.push({type: 'mode', mode});};
    generator.supportedModels = async () => [{value: 'opus', displayName: 'Opus', description: '最强'}, {value: 'sonnet', displayName: 'Sonnet', description: '均衡'}];
    generator.close = () => {closed = true;calls.push({type: 'close'});};
    return generator;
  };
  return {query, calls, answers};
}

test('phone drives Claude Code sessions: create, approve, answer, queue, stop and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-run-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const config = join(root, 'config'), cwd = join(root, 'repo');
    await mkdir(join(config, 'projects', 'work'), {recursive: true});await mkdir(cwd);
    process.env.CLAUDE_CONFIG_DIR = config;
    const fake = fakeClaude(join(config, 'projects'));
    const runtime = new ClaudeRuntime(async () => fake.query, () => undefined, 200);
    bridge = new ClaudeCodeBridge(ledger, config, undefined, Date.now, runtime);
    const read = (id: string) => bridge!.handle('claude.read', {conversationId: id});

    // New session, with a model and image.
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const create = {cwd, text: '你好', images: [image], model: 'opus', permissionMode: 'acceptEdits', opId: opId()};
    const created = await bridge.handle('claude.create', create);
    assert.equal(created.state, 'accepted');
    const id = created.conversationId;
    assert.deepEqual(await bridge.handle('claude.create', create), created, 'retrying an operation never starts a second session');
    assert.equal(fake.calls.filter(call => call.type === 'start').length, 1);
    assert.equal(fake.calls[0].options.model, 'opus');assert.equal(fake.calls[0].options.permissionMode, 'acceptEdits');
    assert.equal(fake.calls[0].options.env.CLAUDE_CODE_ENTRYPOINT, 'codex-mobile-web', 'an entrypoint the terminal resume list shows');
    assert.equal(fake.calls[0].options.cwd, cwd);
    assert.deepEqual(fake.calls[0].options.systemPrompt, {type: 'preset', preset: 'claude_code'});
    assert.equal(fake.calls[1].images, 1);
    let view = await until(() => read(id), value => !value.running && value.turns.length === 1);
    assert.equal(view.controlled, true);assert.equal(view.turns[0].items.at(-1).text, '好的：你好');

    // Tool approval with "remember".
    assert.equal((await bridge.handle('claude.send', {conversationId: id, text: 'run npm test', opId: opId()})).state, 'accepted');
    view = await until(() => read(id), value => value.requests.length === 1);
    const firstRequestId = view.requests[0].id;
    assert.equal(view.running, true);
    assert.deepEqual({kind: view.requests[0].kind, detail: view.requests[0].detail, canRemember: view.requests[0].canRemember, rememberScope: view.requests[0].rememberScope}, {kind: 'permission', detail: 'npm test', canRemember: true, rememberScope: 'session'});
    const watched = bridge.handle('claude.watch', {conversationId: id, revision: view.revision});
    assert.equal((await bridge.handle('claude.respond', {conversationId: id, requestId: view.requests[0].id, decision: 'allowSession', opId: opId()})).state, 'accepted');
    assert.notEqual((await watched).revision, view.revision, 'an answered request wakes the phone without a transcript write');
    assert.deepEqual(fake.answers[0], {behavior: 'allow', updatedInput: {command: 'npm test'}, updatedPermissions: [{type: 'addRules', rules: [{toolName: 'Bash'}], behavior: 'allow', destination: 'session'}]});
    const expired = await bridge.handle('claude.respond', {conversationId: id, requestId: view.requests[0].id, decision: 'allow', opId: opId()});
    assert.equal(expired.state, 'failed');
    await until(() => read(id), value => !value.running);

    // A question from Claude.
    await bridge.handle('claude.send', {conversationId: id, text: 'ask', opId: opId()});
    view = await until(() => read(id), value => value.requests.length === 1);
    assert.equal(view.requests[0].kind, 'question');assert.equal(view.requests[0].questions[0].options[1].label, 'Postgres');
    assert.equal((await bridge.handle('claude.respond', {conversationId: id, requestId: view.requests[0].id, decision: 'allow', answers: {}, opId: opId()})).state, 'failed');
    await bridge.handle('claude.respond', {conversationId: id, requestId: view.requests[0].id, decision: 'allow', answers: {'用哪个数据库？': 'Postgres'}, opId: opId()});
    assert.deepEqual(fake.answers[1].updatedInput.answers, {'用哪个数据库？': 'Postgres'});
    await until(() => read(id), value => !value.running);

    // Queue behind a running task on this computer, withdraw and delete queued messages, steer, send now, stop, and change model.
    await bridge.handle('claude.send', {conversationId: id, text: 'slow', opId: opId()});
    await until(() => read(id), value => value.running);
    const queuedOp = opId();
    assert.equal((await bridge.handle('claude.send', {conversationId: id, text: '之后再做', images: [image], model: 'opus', opId: queuedOp})).kind, 'queued');
    await bridge.handle('claude.send', {conversationId: id, text: '撤回我', opId: opId()});
    const dropOp = opId();
    await bridge.handle('claude.send', {conversationId: id, text: '删掉我', opId: dropOp});
    view = await read(id);
    assert.deepEqual(view.queuedMessages.map((m: any) => [m.text, m.imageCount, m.state]), [['之后再做', 1, 'queued'], ['撤回我', 0, 'queued'], ['删掉我', 0, 'queued']]);
    assert.equal(fake.calls.filter(call => call.type === 'message').at(-1).text, 'slow', 'queued messages stay on this computer while the turn runs');
    const withdrawn = await bridge.handle('claude.withdrawQueued', {conversationId: id, queuedId: view.queuedMessages[1].id, opId: opId()});
    assert.deepEqual([withdrawn.kind, withdrawn.message.text], ['queue_withdrawn', '撤回我']);
    assert.equal((await bridge.handle('claude.cancelQueued', {conversationId: id, queuedId: dropOp, opId: opId()})).kind, 'queue_cancelled');
    assert.equal((await bridge.handle('claude.operation', {opId: dropOp})).kind, 'queue_cancelled', 'a deleted message reads back as not sent');
    assert.equal((await bridge.handle('claude.archive', {conversationId: id, opId: opId()})).state, 'failed', 'queued messages block archiving');
    await bridge.handle('claude.send', {conversationId: id, text: '顺便', mode: 'steer', model: 'sonnet', opId: opId()});
    await bridge.handle('claude.send', {conversationId: id, text: '马上', mode: 'now', opId: opId()});
    await assert.rejects(bridge.handle('claude.send', {conversationId: id, text: 'x', mode: 'later', opId: opId()}), /发送方式无效/, 'unknown send modes are refused');
    assert.equal((await bridge.handle('claude.stop', {conversationId: id, opId: opId()})).state, 'accepted');
    await until(() => read(id), value => !value.running && !value.queuedMessages.length);
    const messages = fake.calls.filter(call => call.type === 'message');
    assert.deepEqual(messages.slice(-4).map(call => [call.text, call.priority, call.images]),
      [['slow', undefined, 0], ['顺便', 'next', 0], ['马上', 'now', 0], ['之后再做', undefined, 1]], 'the queued message goes out after the turn, with its image');
    assert.equal((await bridge.handle('claude.operation', {opId: queuedOp})).submitted, true);
    assert.ok(fake.calls.some(call => call.type === 'model' && call.model === 'sonnet'));
    assert.ok(fake.calls.some(call => call.type === 'interrupt'));
    assert.equal((await read(id)).error, '', 'a requested stop is not reported as an error');
    assert.deepEqual((await bridge.handle('claude.models', {})).models.map((m: any) => m.id), ['opus', 'sonnet']);

    // Idle sessions are released so the terminal can resume them.
    await until(() => read(id), value => value.controlled === false, 15_000);
    assert.ok(fake.calls.some(call => call.type === 'close') || !runtime.get(id));

    // Resuming a session someone just used elsewhere needs confirmation.
    const file = join(config, 'projects', 'work', id + '.jsonl');
    const now = new Date();await utimes(file, now, now);
    const blocked = await bridge.handle('claude.send', {conversationId: id, text: '继续', opId: opId()});
    assert.equal(blocked.state, 'failed');assert.equal(blocked.error.code, 'active');
    const beforeResume = fake.calls.filter(call => call.type === 'start').length;
    const resumed = await Promise.all([
      bridge.handle('claude.send', {conversationId: id, text: '继续', confirmIdle: true, opId: opId()}),
      bridge.handle('claude.send', {conversationId: id, text: '另一台手机', confirmIdle: true, opId: opId()}),
    ]);
    assert.equal(resumed[0].state, 'accepted');
    assert.equal(resumed[1].error?.code, 'busy');
    assert.equal(fake.calls.filter(call => call.type === 'start').length, beforeResume + 1);
    assert.equal(fake.calls.filter(call => call.type === 'start').at(-1).options.resume, id);
    await until(() => read(id), value => !value.running && value.turns.at(-1).items.at(-1).text === '好的：继续');

    await bridge.handle('claude.send', {conversationId: id, text: 'run git status', opId: opId()});
    const approval = await until(() => read(id), value => value.requests.length === 1);
    const stale = await bridge.handle('claude.respond', {conversationId: id, requestId: firstRequestId, decision: 'allow', opId: opId()});
    assert.equal(stale.error?.code, 'expired');
    assert.equal((await read(id)).requests[0].id, approval.requests[0].id);
    await bridge.handle('claude.respond', {conversationId: id, requestId: approval.requests[0].id, decision: 'deny', opId: opId()});
    await until(() => read(id), value => !value.running);

    await assert.rejects(bridge.handle('claude.create', {cwd: join(root, 'missing'), text: 'x', opId: opId()}));
    await assert.rejects(bridge.handle('claude.send', {conversationId: id, text: '', opId: opId()}), /请输入消息/);
    await assert.rejects(bridge.handle('claude.send', {conversationId: id, text: 'x', permissionMode: 'yolo', opId: opId()}), /权限模式无效/);
  } finally {
    bridge?.close();ledger.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR = previous;
    await removeTestTemp(root);
  }
});

test('Claude Code executable and messages', () => {
  assert.equal(findClaude({CLAUDE_CODE_BIN: 'C:/tools/claude.exe'}, () => false, 'win32'), 'C:/tools/claude.exe');
  assert.equal(findClaude({PATH: 'C:\\a;C:\\b', USERPROFILE: 'C:\\Users\\me'}, path => path === join('C:\\b', 'claude.exe'), 'win32'), join('C:\\b', 'claude.exe'));
  assert.equal(findClaude({PATH: '', USERPROFILE: 'C:\\Users\\me'}, path => path === join('C:\\Users\\me', '.local', 'bin', 'claude.exe'), 'win32'), join('C:\\Users\\me', '.local', 'bin', 'claude.exe'));
  assert.equal(findClaude({PATH: ''}, () => false, 'win32'), undefined);
  assert.deepEqual(claudeEnv('custom', {PATH: 'x', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts'}), {PATH: 'x', CLAUDE_CODE_ENTRYPOINT: 'custom'});
  assert.deepEqual(claudeEnv(undefined, {PATH: 'x'}), {PATH: 'x', CLAUDE_CODE_ENTRYPOINT: 'codex-mobile-web'}, 'not sdk-ts, which the terminal hides');
  const inherited = {PATH: 'x', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_HOST_SESSION_ID: 'local_x', CLAUDE_PID: '1', CLAUDE_CODE_MESSAGING_TOKEN: 't'};
  assert.deepEqual(claudeEnv(undefined, inherited), {PATH: 'x', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_ENTRYPOINT: 'codex-mobile-web'},
    'a connector started inside a Claude Code session does not make its sessions its children');
  const message = userMessage('看图', ['data:image/png;base64,AAAA'], 'later');
  assert.deepEqual(message.message.content, [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'AAAA'}}, {type: 'text', text: '看图'}]);
  assert.equal(message.priority, 'later');assert.deepEqual(message.origin, {kind: 'human'});
});

test('documents upload into the project and reach Claude Code as links, only in the scope they were uploaded for', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-files-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const config = join(root, 'config'), cwd = join(root, 'repo');
    await mkdir(join(config, 'projects', 'work'), {recursive: true});await mkdir(cwd);
    process.env.CLAUDE_CONFIG_DIR = config;
    const fake = fakeClaude(join(config, 'projects'));
    bridge = new ClaudeCodeBridge(ledger, config, undefined, Date.now, new ClaudeRuntime(async () => fake.query, () => undefined, 200));
    const call = (action: any, payload: any) => bridge!.handle(action, payload);
    const doc = (text: string) => ({id: randomUUID(), name: '需求.md', size: Buffer.byteLength(text), file: new File([text], '需求.md')});
    const linked = (text: string) => [...text.matchAll(/\]\(<([^>]+)>\)/g)].map(match => fileReference(match[1]).path);
    const messages = () => fake.calls.filter(item => item.type === 'message');

    // Before the session exists the files belong to its project; with files the typed text may be empty.
    const first = await uploadAttachments(call, {prefix: 'claude.', scope: {cwd}}, [doc('第一版')]);
    const created = await bridge.handle('claude.create', {cwd, text: '', files: first, opId: opId()});
    assert.equal(created.state, 'accepted', JSON.stringify(created));
    const id = created.conversationId;
    await until(() => messages().length, count => count === 1);
    assert.equal(await readFile(linked(messages()[0].text)[0], 'utf8'), '第一版');
    await until(() => bridge!.handle('claude.read', {conversationId: id}), value => !value.running);

    const elsewhere = await bridge.handle('claude.send', {conversationId: id, text: '再看', files: first, opId: opId()});
    assert.equal(elsewhere.state, 'failed');assert.match(elsewhere.error.message, /当前会话/);
    const own = await uploadAttachments(call, {prefix: 'claude.', scope: {conversationId: id}}, [doc('第二版')]);
    assert.equal((await bridge.handle('claude.send', {conversationId: id, text: '再看', files: own, opId: opId()})).state, 'accepted');
    await until(() => messages().length, count => count === 2);
    assert.match(messages()[1].text, /^再看\n\n附件/);
    assert.equal(await readFile(linked(messages()[1].text)[0], 'utf8'), '第二版');
    await until(() => bridge!.handle('claude.read', {conversationId: id}), value => !value.running);
  } finally {
    bridge?.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    ledger.close();
    await removeTestTemp(root);
  }
});
