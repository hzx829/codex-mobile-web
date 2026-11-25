import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, parse} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Ledger, type Actor} from '../src/connector/ledger.js';
import {
  WorkspaceManager,
  assertSafeProjectPath,
  createProjectsHandler,
  defaultProjectRoot,
  validateFolderName,
} from '../src/connector/workspace.js';
import {BridgeError} from '../src/shared/types.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const opId = () => `${Date.now()}:${randomUUID()}`;

test('validateFolderName and assertSafeProjectPath enforce strict path safety boundaries', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cmw-ws-safety-'));
  const fakeHome = await realpath(join(sandbox, 'home')).catch(async () => {
    await mkdir(join(sandbox, 'home'), {recursive: true});
    return realpath(join(sandbox, 'home'));
  });
  const dataDir = join(sandbox, 'data');
  await mkdir(dataDir, {recursive: true});
  const safety = {home: fakeHome, dataDir};

  try {
    assert.equal(validateFolderName('  my-app_01  '), 'my-app_01');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'bad:name', 'trail.', 'trail .', 'CON', 'nul.txt', 'a'.repeat(81)]) {
      assert.throws(() => validateFolderName(bad), (e: any) => e instanceof BridgeError && e.code === 'invalid', `should reject ${JSON.stringify(bad)}`);
    }

    const fsRoot = parse(fakeHome).root;
    await assert.rejects(() => assertSafeProjectPath(fsRoot, safety), /磁盘根目录/);
    await assert.rejects(() => assertSafeProjectPath(fakeHome, safety), /用户主目录/);
    await assert.rejects(() => assertSafeProjectPath(join(fakeHome, '.codex', 'sub'), safety), /应用配置\/数据目录/);
    await assert.rejects(() => assertSafeProjectPath(join(fakeHome, '.claude'), safety), /应用配置\/数据目录/);
    await assert.rejects(() => assertSafeProjectPath(join(fakeHome, '.gemini', 'config'), safety), /应用配置\/数据目录/);
    await assert.rejects(() => assertSafeProjectPath(join(dataDir, 'sub'), safety), /应用配置\/数据目录/);
    await assert.rejects(() => assertSafeProjectPath('\\\\server\\share\\proj', safety), /网络共享/);
    await assert.rejects(() => assertSafeProjectPath('relative/path', safety), /绝对目录/);
    await assert.rejects(() => assertSafeProjectPath(join(fakeHome, 'Documents', 'Projects', 'app', '.git'), safety), /\.git 或 worktree/);
    await assert.rejects(() => assertSafeProjectPath(join(fakeHome, 'Documents', 'Projects', 'app', '.claude', 'worktrees', 'w1'), safety), /\.git 或 worktree/);

    const safe = await assertSafeProjectPath(join(fakeHome, 'Documents', 'Projects', 'demo'), safety);
    assert.equal(safe, join(fakeHome, 'Documents', 'Projects', 'demo'));
  } finally {
    await removeTestTemp(sandbox);
  }
});

test('WorkspaceManager restricts team members to default root until configured, while allowing admins and personal mode outside', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cmw-ws-roles-'));
  const fakeHome = join(sandbox, 'home');
  const outside = join(sandbox, 'outside', 'existing-repo');
  const configuredRoot = join(sandbox, 'team-root');
  await mkdir(fakeHome, {recursive: true});
  await mkdir(outside, {recursive: true});
  await mkdir(join(outside, '.git'), {recursive: true});
  await mkdir(configuredRoot, {recursive: true});
  const realHome = await realpath(fakeHome);
  const realOutside = await realpath(outside);
  const realConfigured = await realpath(configuredRoot);

  const member: Actor = {userId: 'u-m', deviceId: 'd-m', name: 'Bo', role: 'member'};
  const admin: Actor = {userId: 'u-a', deviceId: 'd-a', name: 'Ada', role: 'admin'};

  try {
    // 1. Unconfigured projectRoots: member is confined to default ~/Documents/Projects
    const unconfigured = new WorkspaceManager({
      projectRoots: [],
      home: realHome,
      runGitInit: async dir => { await mkdir(join(dir, '.git'), {recursive: true}); },
    });

    const memberRoots = await unconfigured.roots(member);
    assert.equal(memberRoots.configured, false);
    assert.equal(memberRoots.allowOutsideRoots, false);
    assert.equal(memberRoots.roots[0].path, defaultProjectRoot(realHome));

    const adminRoots = await unconfigured.roots(admin);
    assert.equal(adminRoots.allowOutsideRoots, true);

    const personalRoots = await unconfigured.roots(undefined);
    assert.equal(personalRoots.allowOutsideRoots, true);

    // Before first create, browsing unconfigured default root returns exists: false cleanly.
    const emptyBrowse = await unconfigured.browse(undefined, member);
    assert.equal(emptyBrowse.exists, false);
    assert.deepEqual(emptyBrowse.entries, []);

    // Member is forbidden from browsing or attaching outside default root.
    await assert.rejects(() => unconfigured.browse(realOutside, member), (e: any) => e instanceof BridgeError && e.code === 'forbidden');
    await assert.rejects(() => unconfigured.prepareDirectory({mode: 'existing', path: realOutside}, member), (e: any) => e instanceof BridgeError && e.code === 'forbidden');

    // Member CAN create a new folder inside default root (auto-creating ~/Documents/Projects).
    const created = await unconfigured.prepareDirectory({mode: 'new', folderName: 'alpha', initGit: true}, member);
    assert.equal(created.created, true);
    assert.equal(created.gitInit, true);
    assert.equal(created.path, join(defaultProjectRoot(realHome), 'alpha'));

    // Duplicate folder name fails strictly with EEXIST (code: 'exists').
    await assert.rejects(() => unconfigured.prepareDirectory({mode: 'new', folderName: 'alpha'}, member), (e: any) => e instanceof BridgeError && e.code === 'exists');

    // Now browsing default root shows `alpha` with isGit: true and no parent escape above default root.
    const listed = await unconfigured.browse(undefined, member);
    assert.equal(listed.exists, true);
    assert.equal(listed.parent, null);
    assert.deepEqual(listed.entries, [{name: 'alpha', path: created.path, isGit: true}]);

    // Member can attach subfolder inside default root, but cannot attach the root directory itself.
    const attached = await unconfigured.prepareDirectory({mode: 'existing', path: created.path}, member);
    assert.equal(attached.path, created.path);
    await assert.rejects(() => unconfigured.prepareDirectory({mode: 'existing', path: defaultProjectRoot(realHome)}, member), (e: any) => e instanceof BridgeError && e.code === 'forbidden');

    // Admin and personal mode CAN browse and attach outside default root.
    const adminBrowse = await unconfigured.browse(join(sandbox, 'outside'), admin);
    assert.equal(adminBrowse.entries.some(e => e.path === realOutside && e.isGit), true);
    const adminAttach = await unconfigured.prepareDirectory({mode: 'existing', path: realOutside}, admin);
    assert.equal(adminAttach.path, realOutside);

    // 2. Configured projectRoots: member is confined to configured roots.
    const configured = new WorkspaceManager({
      projectRoots: [realConfigured],
      home: realHome,
      runGitInit: async () => { throw new Error('git not installed'); },
    });
    const cfgRoots = await configured.roots(member);
    assert.equal(cfgRoots.configured, true);
    assert.equal(cfgRoots.roots[0].path, realConfigured);
    const createdNoGit = await configured.prepareDirectory({mode: 'new', folderName: 'beta', initGit: true}, member);
    assert.equal(createdNoGit.gitInit, false);
    assert.match(createdNoGit.gitNotice || '', /Git/);
    await assert.rejects(() => configured.prepareDirectory({mode: 'new', parentPath: defaultProjectRoot(realHome), folderName: 'gamma'}, member), /团队项目根目录/);

    // 3. Guest mode locks even admins to guest workspace.
    const guestDir = join(sandbox, 'guest-ws');
    await mkdir(guestDir, {recursive: true});
    const guestMgr = new WorkspaceManager({guestRoot: () => guestDir, home: realHome});
    const guestInfo = await guestMgr.roots(admin);
    assert.equal(guestInfo.guest, true);
    assert.equal(guestInfo.allowOutsideRoots, false);
    await assert.rejects(() => guestMgr.browse(realOutside, admin), (e: any) => e instanceof BridgeError && e.code === 'forbidden');
  } finally {
    await removeTestTemp(sandbox);
  }
});

test('createProjectsHandler registers all enabled services by default, reports partial failure, rolls back on total failure, and enforces opId idempotency', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cmw-ws-coord-'));
  const rootDir = join(sandbox, 'projects');
  await mkdir(rootDir, {recursive: true});
  const realRoot = await realpath(rootDir);
  const ledger = new Ledger(':memory:');

  try {
    let changed = 0;
    const workspace = new WorkspaceManager({
      projectRoots: [realRoot],
      home: sandbox,
      runGitInit: async () => {},
    });
    const calls: string[] = [];
    let failAg = false;
    let failAll = false;

    const handle = createProjectsHandler({
      workspace,
      ledger,
      availableServices: ['codex', 'claude', 'antigravity'],
      registrars: {
        codex: async (_op, input) => {
          calls.push(`codex:${input.name}`);
          if (failAll) throw new BridgeError('runtime_error', 'codex down');
          return {project: {id: 'codex-1', name: input.name, path: input.path}, notice: '桌面端将在下次打开或刷新后显示'};
        },
        claude: async (_op, input) => {
          calls.push(`claude:${input.name}`);
          if (failAll) throw new BridgeError('runtime_error', 'claude down');
          return {project: {id: input.path, name: input.name, path: input.path}};
        },
        antigravity: async (_op, input) => {
          calls.push(`ag:${input.name}`);
          if (failAll || failAg) throw new BridgeError('unavailable', 'Antigravity 未运行');
          return {project: {id: 'file:///demo', projectId: 'uuid-1', name: input.name, path: input.path}};
        },
      },
      onChanged: () => { changed++; },
    });

    // 1. Default registers all 3 enabled services + opId idempotency
    const id1 = opId();
    const res1 = await handle('projects.create', {mode: 'new', name: 'Unified App', folderName: 'unified-app', opId: id1});
    assert.equal(res1.created, true);
    assert.equal(res1.results.codex.ok, true);
    assert.equal(res1.results.claude.ok, true);
    assert.equal(res1.results.antigravity.ok, true);
    assert.equal(changed, 1);

    const replay = await handle('projects.create', {mode: 'new', name: 'Unified App', folderName: 'unified-app', opId: id1});
    assert.deepEqual(replay, res1);
    assert.equal(calls.length, 3, 'replayed opId must not invoke registrars again');

    // 2. Partial failure preserves newly created folder and reports per-service status
    failAg = true;
    const res2 = await handle('projects.create', {mode: 'new', name: 'Partial App', folderName: 'partial-app', opId: opId()});
    assert.equal(res2.results.codex.ok, true);
    assert.equal(res2.results.claude.ok, true);
    assert.equal(res2.results.antigravity.ok, false);
    assert.equal(res2.results.antigravity.error.code, 'unavailable');
    assert.equal((await stat(res2.path)).isDirectory(), true);

    // 3. Total failure on a freshly created folder rolls back (removes) the empty folder
    failAll = true;
    const rolledBackPath = join(realRoot, 'doomed-app');
    const failedNew = await handle('projects.create', {mode: 'new', name: 'Doomed', folderName: 'doomed-app', opId: opId()});
    assert.equal(failedNew.state, 'failed');
    assert.match(failedNew.error.message, /未能创建项目/);
    await assert.rejects(() => stat(rolledBackPath), /ENOENT/);

    // 4. Total failure on an EXISTING folder NEVER deletes the existing folder
    const existingDir = join(realRoot, 'keep-me');
    await mkdir(existingDir, {recursive: true});
    await writeFile(join(existingDir, 'README.md'), 'keep');
    const failedExisting = await handle('projects.create', {mode: 'existing', path: existingDir, name: 'Keep', opId: opId()});
    assert.equal(failedExisting.state, 'failed');
    assert.match(failedExisting.error.message, /未能创建项目/);
    assert.equal((await stat(join(existingDir, 'README.md'))).isFile(), true);

    // 5. Unified projects.update and projects.remove with opId idempotency
    const manageCalls: string[] = [];
    let manageChanges = 0;
    const manageHandle = createProjectsHandler({
      workspace,
      ledger,
      availableServices: ['codex', 'claude'],
      registrars: {},
      updaters: {
        codex: async (_op, input) => {
          manageCalls.push(`update:codex:${input.id}:${input.name}`);
          return {project: {id: input.id || 'p1', name: input.name, path: input.path || existingDir}};
        },
      },
      removers: {
        claude: async input => {
          manageCalls.push(`remove:claude:${input.path}`);
          return {removed: true};
        },
      },
      onChanged: () => { manageChanges++; },
    });
    const updOp = opId();
    const upd1 = await manageHandle('projects.update', {service: 'codex', id: 'p1', path: existingDir, name: 'Renamed', opId: updOp});
    assert.equal(upd1.state, 'accepted');
    assert.equal(upd1.project.name, 'Renamed');
    const upd2 = await manageHandle('projects.update', {service: 'codex', id: 'p1', path: existingDir, name: 'Renamed', opId: updOp});
    assert.deepEqual(upd2, upd1);
    assert.equal(manageCalls.length, 1);

    const rem = await manageHandle('projects.remove', {service: 'claude', path: existingDir, opId: opId()});
    assert.equal(rem.state, 'accepted');
    assert.equal(rem.removed, true);
    assert.equal(manageChanges, 2);
    await assert.rejects(() => manageHandle('projects.update', {service: 'claude', path: existingDir, name: 'X', opId: opId()}), /暂不支持修改/);
  } finally {
    ledger.close();
    await removeTestTemp(sandbox);
  }
});
