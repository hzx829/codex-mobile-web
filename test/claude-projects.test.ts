import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROJECT_ID, ProjectStore, projectInput, projectLaunch, memoryIndex} from '../src/connector/claude-projects.js';
import {ClaudeCodeBridge, type ClaudeSessions} from '../src/connector/claude-code.js';
import {ClaudeRuntime, type QueryFn} from '../src/connector/claude-runtime.js';
import {Ledger} from '../src/connector/ledger.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const opId = () => `${Date.now()}:${randomUUID()}`;

test('project input is validated and normalized', () => {
  const input = projectInput({name: ' 网站 ', folders: 'C:\\work\\site\n\nD:\\shared\nC:\\work\\site', instructions: ' 用中文回答 ',
    mcpServers: '{"files":{"command":"npx","args":["-y","files"]}}'});
  assert.deepEqual(input, {name: '网站', folders: ['C:\\work\\site', 'D:\\shared'], instructions: '用中文回答', memoryDir: '',
    mcpServers: {files: {command: 'npx', args: ['-y', 'files']}}});
  assert.throws(() => projectInput({name: 'x', folders: []}), /至少需要一个文件夹/);
  assert.throws(() => projectInput({name: 'x', folders: ['relative/dir']}), /完整路径/);
  assert.throws(() => projectInput({name: 'x', folders: ['\\\\server\\share']}), /完整路径/);
  assert.throws(() => projectInput({name: '', folders: ['C:\\a']}), /项目名称/);
  assert.throws(() => projectInput({name: 'x', folders: ['C:\\a'], mcpServers: '{bad'}), /JSON/);
  assert.throws(() => projectInput({name: 'x', folders: ['C:\\a'], mcpServers: {s: {args: []}}}), /command 或 url/);
  assert.throws(() => projectInput({name: 'x', folders: ['C:\\a'], memoryDir: 'mem'}), /记忆目录/);
});

test('project store keeps projects in claude-projects.json and survives bad entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-projects-'));
  try {
    const file = join(root, 'claude-projects.json');
    const store = new ProjectStore(file);
    assert.deepEqual(await store.list(), [], 'a missing file means no projects');
    const a = await store.create(projectInput({name: 'A', folders: [join(root, 'a')]}));
    assert.match(a.id, PROJECT_ID);
    const b = await store.create(projectInput({name: 'B', folders: [join(root, 'b')]}));
    await Promise.all([store.addSession(a.id, 's1'), store.addSession(a.id, 's2'), store.addSession(b.id, 's3')]);
    await store.addSession(b.id, 's1');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.projects.map((p: any) => [p.name, p.sessionIds]), [['A', ['s2']], ['B', ['s3', 's1']]], 'a session belongs to one project');
    await store.update(a.id, projectInput({name: 'A2', folders: [join(root, 'a')], instructions: 'hi'}));
    assert.equal((await new ProjectStore(file).get(a.id)).name, 'A2');
    assert.deepEqual((await new ProjectStore(file).get(a.id)).sessionIds, ['s2'], 'editing keeps the sessions');
    assert.equal((await store.ofSession('s3'))?.id, b.id);
    await store.remove(b.id);
    assert.deepEqual((await new ProjectStore(file).list()).map(p => p.name), ['A2']);
    await assert.rejects(store.get(b.id), /不存在/);

    // A hand-edited file with one broken entry still loads the good ones.
    await writeFile(file, JSON.stringify({projects: [{id: 'bad'}, {id: a.id, name: 'X', folders: [join(root, 'x')]}, {id: a.id, name: 'dup', folders: [join(root, 'y')]}]}));
    assert.deepEqual((await new ProjectStore(file).list()).map(p => p.name), ['X']);
    await writeFile(file, '{not json');
    await assert.rejects(new ProjectStore(file).list(), /无法读取/);
  } finally {await removeTestTemp(root);}
});

test('project launch adds folders, instructions, memory index and MCP servers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-memory-'));
  try {
    await writeFile(join(root, 'MEMORY.md'), '- [部署](deploy.md) — 生产环境步骤\n');
    assert.equal(await memoryIndex(join(root, 'missing')), '');
    const launch = await projectLaunch({id: 'p_0000000000000000', name: '网站', folders: ['C:\\site', 'D:\\assets'], instructions: '用中文回答',
      memoryDir: root, mcpServers: {files: {command: 'npx'}}, sessionIds: []});
    assert.equal(launch.cwd, 'C:\\site');
    assert.deepEqual(launch.additionalDirectories, ['D:\\assets']);
    assert.deepEqual(launch.mcpServers, {files: {command: 'npx'}});
    for (const part of ['# 项目：网站', '- D:\\assets', '## 项目说明\n用中文回答', `记忆目录：${root}`, '- [部署](deploy.md) — 生产环境步骤'])
      assert.ok(launch.append.includes(part), part);
    const plain = await projectLaunch({id: 'p_0000000000000000', name: 'P', folders: ['C:\\p'], instructions: '', memoryDir: '', mcpServers: {}, sessionIds: []});
    assert.equal(plain.append, '# 项目：P');assert.deepEqual(plain.additionalDirectories, []);
  } finally {await removeTestTemp(root);}
});

test('Claude sessions start in projects, register with them and list by project or folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-project-run-'));
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    const site = join(root, 'site'), assets = join(root, 'assets'), loose = join(root, 'loose');
    for (const dir of [site, assets, loose]) await mkdir(dir);
    const starts: any[] = [];
    const query: QueryFn = ({prompt, options}) => {
      const id = options?.resume || randomUUID();
      starts.push({id, options});
      async function* run(): AsyncGenerator<any> {
        yield {type: 'system', subtype: 'init', session_id: id};
        for await (const _ of prompt) {
          yield {type: 'result', subtype: 'success', session_id: id, errors: []};
          yield {type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: id};
        }
      }
      const generator = run() as any;
      generator.close = () => {};generator.interrupt = async () => {};
      return generator;
    };
    const catalog: {sessionId: string; summary: string; lastModified: number; cwd: string}[] = [
      {sessionId: '11111111-1111-4111-8111-111111111111', summary: '散装会话', lastModified: 3, cwd: loose},
      {sessionId: '22222222-2222-4222-8222-222222222222', summary: '站点旧会话', lastModified: 2, cwd: site},
    ];
    const sessions: ClaudeSessions = {
      listSessions: async () => catalog,
      getSessionInfo: async id => catalog.find(s => s.sessionId === id),
      getSessionMessages: async () => [],
    };
    const store = new ProjectStore(join(root, 'claude-projects.json'));
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'), async () => sessions, Date.now, new ClaudeRuntime(async () => query, () => undefined, 60_000), store);

    const saved = await bridge.handle('claude.project.save', {name: '网站', folders: [site, assets], instructions: '先跑测试', opId: opId()});
    assert.equal(saved.state, 'accepted');
    const projectId = saved.projectId;
    assert.deepEqual((await bridge.handle('claude.project.get', {projectId})).project.folders, [site, assets]);

    const created = await bridge.handle('claude.create', {projectId, text: '你好', opId: opId()});
    assert.equal(created.state, 'accepted');
    const start = starts.at(-1).options;
    assert.equal(start.cwd, site);
    assert.deepEqual(start.additionalDirectories, [assets]);
    assert.ok(start.systemPrompt.append.includes('先跑测试'));
    assert.equal(start.mcpServers, undefined, 'no MCP servers unless the project has some');
    assert.deepEqual((await store.get(projectId)).sessionIds, [created.conversationId]);
    // The transcript can appear before the SDK knows the session; a live session still reads.
    await mkdir(join(root, 'config', 'projects', 'x'), {recursive: true});
    await writeFile(join(root, 'config', 'projects', 'x', created.conversationId + '.jsonl'), '{}\n');
    const early = await bridge.handle('claude.read', {conversationId: created.conversationId});
    assert.equal(early.controlled, true);assert.deepEqual(early.turns, []);
    catalog.unshift({sessionId: created.conversationId, summary: '项目里的新会话', lastModified: 4, cwd: site});

    const home = await bridge.handle('claude.list', {refresh: true});
    assert.deepEqual(home.projects, [{id: projectId, path: site, name: '网站', kind: 'project'},
      {id: loose, path: loose, kind: 'folder'}, {id: site, path: site, kind: 'folder'}]);
    assert.deepEqual((await bridge.handle('claude.list', {project: projectId})).data.map((s: any) => s.title), ['项目里的新会话']);
    assert.deepEqual((await bridge.handle('claude.list', {project: site})).data.map((s: any) => s.title), ['站点旧会话'], 'folder groups leave out project sessions');
    await assert.rejects(bridge.handle('claude.list', {project: 'p_ffffffffffffffff'}), /不存在/);

    // A project session resumed later keeps the project's settings; others do not get them.
    bridge.runtime.close();
    await mkdir(join(root, 'config', 'projects', 'x'), {recursive: true});
    for (const id of [created.conversationId, '11111111-1111-4111-8111-111111111111'])
      await writeFile(join(root, 'config', 'projects', 'x', id + '.jsonl'), '{}\n');
    await new Promise(resolve => setTimeout(resolve, 0));
    await bridge.handle('claude.project.save', {projectId, name: '网站', folders: [site], instructions: '新的说明', mcpServers: {files: {command: 'npx'}}, opId: opId()});
    assert.equal((await bridge.handle('claude.send', {conversationId: created.conversationId, text: '继续', opId: opId(), confirmIdle: true})).state, 'accepted');
    const resumed = starts.at(-1).options;
    assert.equal(resumed.resume, created.conversationId);
    assert.ok(resumed.systemPrompt.append.includes('新的说明'));
    assert.deepEqual(resumed.mcpServers, {files: {command: 'npx'}});
    assert.equal((await bridge.handle('claude.send', {conversationId: '11111111-1111-4111-8111-111111111111', text: '继续', opId: opId(), confirmIdle: true})).state, 'accepted');
    assert.equal(starts.at(-1).options.systemPrompt.append, undefined);

    assert.equal((await bridge.handle('claude.read', {conversationId: created.conversationId})).project.name, '网站');
    assert.equal((await bridge.handle('claude.project.delete', {projectId, opId: opId()})).state, 'accepted');
    assert.deepEqual((await bridge.handle('claude.list', {project: site, refresh: true})).data.map((s: any) => s.title), ['项目里的新会话', '站点旧会话'],
      'sessions of a deleted project go back to their folder');
  } finally {
    bridge?.close();ledger.close();
    await removeTestTemp(root);
  }
});
