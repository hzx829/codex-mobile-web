import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {instructionsInput, mcpServersInput, projectKey, readProjectSettings, saveProjectSettings} from '../src/connector/claude-projects.js';
import {ClaudeCodeBridge, type ClaudeSessions} from '../src/connector/claude-code.js';
import {ClaudeRuntime, type QueryFn} from '../src/connector/claude-runtime.js';
import {Ledger} from '../src/connector/ledger.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const opId = () => `${Date.now()}:${randomUUID()}`;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

test('phone input for project settings is validated', () => {
  assert.deepEqual(mcpServersInput('{"files":{"command":"npx","args":["-y","files"]}}'), {files: {command: 'npx', args: ['-y', 'files']}});
  assert.deepEqual(mcpServersInput('  '), {});
  assert.throws(() => mcpServersInput('{bad'), /JSON/);
  assert.throws(() => mcpServersInput('[]'), /对象/);
  assert.throws(() => mcpServersInput({s: {args: []}}), /command 或 url/);
  assert.throws(() => mcpServersInput({'bad name': {command: 'x'}}), /名称无效/);
  assert.equal(instructionsInput('a\r\nb'), 'a\nb');
  assert.equal(instructionsInput(null), null);
  assert.throws(() => instructionsInput('a\0'), /无效/);
  assert.equal(projectKey('C:\\Users\\me\\Documents\\delegate\\codex-mobile-web'), 'C--Users-me-Documents-delegate-codex-mobile-web');
  assert.equal(projectKey('/home/me/' + 'x'.repeat(300)), '', 'long folders are not guessed');
});

test('project settings are the folder\'s CLAUDE.md, .mcp.json and Claude Code memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-settings-'));
  try {
    const folder = join(root, 'site'), memory = join(root, 'config', 'projects', 'site');
    await mkdir(folder);await mkdir(join(memory, 'memory'), {recursive: true});
    await writeFile(join(memory, 'memory', 'MEMORY.md'), '- [部署](deploy.md) — 生产环境步骤\n');
    await writeFile(join(memory, 'memory', 'deploy.md'), '---\nname: deploy\n---\n');

    const empty = await readProjectSettings(folder, memory);
    assert.equal(empty.instructions, '');assert.equal(empty.mcpServers, '');
    assert.equal(empty.claudeMd, join(folder, 'CLAUDE.md'));
    assert.equal(empty.memoryIndex, '- [部署](deploy.md) — 生产环境步骤\n');
    assert.deepEqual(empty.memoryFiles, ['deploy.md']);

    // Saving nothing creates no files.
    await saveProjectSettings(folder, {instructions: '', mcpServers: {}, revision: empty.revision});
    await assert.rejects(readFile(join(folder, 'CLAUDE.md')), /ENOENT/);
    await assert.rejects(readFile(join(folder, '.mcp.json')), /ENOENT/);

    await saveProjectSettings(folder, {instructions: '先跑测试', mcpServers: {files: {command: 'npx'}}, revision: empty.revision});
    assert.equal(await readFile(join(folder, 'CLAUDE.md'), 'utf8'), '先跑测试\n');
    assert.deepEqual(await json(join(folder, '.mcp.json')), {mcpServers: {files: {command: 'npx'}}});
    assert.deepEqual(await json(join(folder, '.claude', 'settings.local.json')), {enabledMcpjsonServers: ['files']}, 'new servers are approved');

    const saved = await readProjectSettings(folder, memory);
    assert.equal(saved.instructions, '先跑测试\n');
    assert.deepEqual(JSON.parse(saved.mcpServers), {files: {command: 'npx'}});
    await assert.rejects(saveProjectSettings(folder, {instructions: 'x', mcpServers: null, revision: empty.revision}), /被改过/);

    // Other keys in the files survive; disabled servers stay disabled; CRLF files keep their line endings.
    await writeFile(join(folder, 'CLAUDE.md'), 'a\r\nb\r\n');
    await writeFile(join(folder, '.mcp.json'), JSON.stringify({mcpServers: {files: {command: 'npx'}}, other: 1}));
    await writeFile(join(folder, '.claude', 'settings.local.json'), JSON.stringify({permissions: {allow: ['Bash(ls)']}, enabledMcpjsonServers: ['files'], disabledMcpjsonServers: ['web']}));
    const edited = await readProjectSettings(folder, memory);
    assert.equal(edited.instructions, 'a\r\nb\r\n');
    await saveProjectSettings(folder, {instructions: 'a\nb\nc', mcpServers: {files: {command: 'npx'}, web: {url: 'https://example.test/mcp'}, db: {command: 'db'}}, revision: edited.revision});
    assert.equal(await readFile(join(folder, 'CLAUDE.md'), 'utf8'), 'a\r\nb\r\nc\r\n');
    assert.equal((await json(join(folder, '.mcp.json'))).other, 1);
    assert.deepEqual(await json(join(folder, '.claude', 'settings.local.json')),
      {permissions: {allow: ['Bash(ls)']}, enabledMcpjsonServers: ['files', 'db'], disabledMcpjsonServers: ['web']});

    // A broken .mcp.json is shown as text and does not block editing CLAUDE.md.
    await writeFile(join(folder, '.mcp.json'), '{broken');
    const broken = await readProjectSettings(folder, memory);
    assert.equal(broken.mcpServers, '{broken');
    await saveProjectSettings(folder, {instructions: 'new', mcpServers: null, revision: broken.revision});
    assert.equal(await readFile(join(folder, '.mcp.json'), 'utf8'), '{broken');

    // .claude/CLAUDE.md is used when it is the only one.
    const nested = join(root, 'nested');
    await mkdir(join(nested, '.claude'), {recursive: true});
    await writeFile(join(nested, '.claude', 'CLAUDE.md'), 'nested');
    const settings = await readProjectSettings(nested, '');
    assert.equal(settings.claudeMd, join(nested, '.claude', 'CLAUDE.md'));
    assert.equal(settings.instructions, 'nested');assert.equal(settings.memoryDir, '');
  } finally {await removeTestTemp(root);}
});

test('Claude Code projects are folders: list, settings and new sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-claude-project-run-'));
  const ledger = new Ledger(':memory:');
  let bridge: ClaudeCodeBridge | undefined;
  try {
    await mkdir(join(root, 'site'));
    const site = await realpath(join(root, 'site')); // The connector resolves folders the same way.
    const loose = join(root, 'loose');await mkdir(loose);
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
    const old = '22222222-2222-4222-8222-222222222222';
    const catalog: {sessionId: string; summary: string; lastModified: number; cwd: string}[] = [
      {sessionId: '11111111-1111-4111-8111-111111111111', summary: '散装会话', lastModified: 3, cwd: loose},
      {sessionId: old, summary: '站点旧会话', lastModified: 2, cwd: site},
    ];
    const sessions: ClaudeSessions = {
      listSessions: async () => catalog,
      getSessionInfo: async id => catalog.find(s => s.sessionId === id),
      getSessionMessages: async () => [],
      forkSession: async () => {throw new Error('unused');},
      renameSession: async () => {},
      archiveSession: async () => {},
    };
    // The site's sessions live in a folder whose name the connector does not have to guess.
    const transcripts = join(root, 'config', 'projects', 'odd-name');
    await mkdir(join(transcripts, 'memory'), {recursive: true});
    await writeFile(join(transcripts, old + '.jsonl'), '{}\n');
    await writeFile(join(transcripts, 'memory', 'MEMORY.md'), '- 记住这个\n');
    bridge = new ClaudeCodeBridge(ledger, join(root, 'config'), async () => sessions, Date.now, new ClaudeRuntime(async () => query, () => undefined, 60_000));

    const home = await bridge.handle('claude.list', {refresh: true});
    assert.deepEqual(home.projects, [{id: loose, path: loose}, {id: site, path: site}]);
    assert.deepEqual((await bridge.handle('claude.list', {project: site})).data.map((s: any) => s.title), ['站点旧会话']);

    const {project} = await bridge.handle('claude.project.get', {folder: site});
    assert.equal(project.memoryDir, join(transcripts, 'memory'));
    assert.equal(project.memoryIndex, '- 记住这个\n');
    const saved = await bridge.handle('claude.project.save', {folder: site, instructions: '先跑测试', mcpServers: '', revision: project.revision, opId: opId()});
    assert.equal(saved.state, 'accepted');
    assert.equal(await readFile(join(site, 'CLAUDE.md'), 'utf8'), '先跑测试\n');
    await assert.rejects(bridge.handle('claude.project.get', {folder: join(root, 'missing')}));
    await assert.rejects(bridge.handle('claude.project.save', {folder: site, instructions: 'x', revision: project.revision}), /操作标识/);

    // Sessions start in the folder; Claude Code reads CLAUDE.md and .mcp.json there itself.
    const created = await bridge.handle('claude.create', {cwd: site, text: '你好', opId: opId()});
    assert.equal(created.state, 'accepted');
    const start = starts.at(-1).options;
    assert.equal(start.cwd, site);
    assert.deepEqual(start.systemPrompt, {type: 'preset', preset: 'claude_code'});
    assert.equal(start.additionalDirectories, undefined);assert.equal(start.mcpServers, undefined);assert.equal(start.settingSources, undefined);
    await assert.rejects(bridge.handle('claude.create', {projectId: 'p_0000000000000000', text: '你好', opId: opId()}), /项目目录/);
  } finally {
    bridge?.close();ledger.close();
    await removeTestTemp(root);
  }
});
