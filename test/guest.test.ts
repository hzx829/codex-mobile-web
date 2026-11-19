import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, toNamespacedPath} from 'node:path';
import {test} from 'node:test';
import {Control} from '../src/connector/control.js';
import {claudeEnv} from '../src/connector/claude-runtime.js';
import {claudeLogin, codexLogin, GUEST_ENTRYPOINT, NoDesktop, syncLogin} from '../src/connector/guest.js';
import {htmlEntry, openHtmlResource} from '../src/connector/html-preview.js';
import {Ledger} from '../src/connector/ledger.js';
import {assertInsideWorkspace, createGuestProject, downloadProjectFile, projectDirectory, readProjectFile, setWorkspace, workspaceProjects} from '../src/connector/project.js';
import {removeTestTemp} from '../scripts/test-temp.js';

test('guest uses its own login copy and can restore an invalid copy from the owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-guest-login-'));
  const source = join(root, 'source.json'), target = join(root, 'guest.json');
  try {
    assert.equal(await syncLogin(source, target, codexLogin), false);
    const initial = JSON.stringify({tokens: {access_token: 'fixture', refresh_token: 'fixture-refresh'}});
    const ownerUpdated = JSON.stringify({tokens: {access_token: 'owner-updated'}});
    await writeFile(source, initial);
    assert.equal(await syncLogin(source, target, codexLogin), true);
    assert.equal(await readFile(target, 'utf8'), initial);
    await writeFile(source, ownerUpdated);
    assert.equal(await syncLogin(source, target, codexLogin), true);
    assert.equal(await readFile(target, 'utf8'), initial);
    await writeFile(target, 'incomplete');
    assert.equal(await syncLogin(source, target, codexLogin), true);
    assert.equal(await readFile(target, 'utf8'), ownerUpdated);
    await writeFile(source, JSON.stringify({claudeAiOauth: {accessToken: 'fresh', expiresAt: 200}}));
    await writeFile(target, JSON.stringify({claudeAiOauth: {accessToken: 'old', expiresAt: 100}}));
    assert.equal(await syncLogin(source, target, claudeLogin, 150), true);
    assert.equal(await readFile(target, 'utf8'), await readFile(source, 'utf8'));
  } finally {await removeTestTemp(root);}
});

test('guest project operations stay inside the canonical workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-guest-projects-'));
  const workspace = join(root, 'workspace'), outside = join(root, 'workspace2');
  try {
    await mkdir(workspace);await mkdir(outside);
    await setWorkspace(workspace);
    assert.equal(await projectDirectory(workspace), workspace);
    if (process.platform === 'win32') assert.doesNotThrow(() => assertInsideWorkspace(toNamespacedPath(workspace.toUpperCase())));
    const project = await createGuestProject(' 示例 ');
    assert.deepEqual(await createGuestProject('示例'), project);
    for (const name of ['..', 'a/b', 'a\\b', 'a.', 'COM1.txt', 'NUL', 'a:stream', 'x'.repeat(81)])
      await assert.rejects(createGuestProject(name), {code: 'invalid'});
    await symlink(outside, join(project.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(outside, 'demo.html'), '<h1>outside</h1>');
    await writeFile(join(outside, 'style.css'), 'html{}');
    const internal = join(project.path, 'index.html');
    await writeFile(internal, '<h1>inside</h1>');
    assert.equal(await htmlEntry(internal), internal);
    const file = await readProjectFile(project.path, 'index.html');
    assert.equal(file.text, '<h1>inside</h1>');
    assert.equal(Buffer.from((await downloadProjectFile(project.path, 'index.html', file.revision, 0)).data, 'base64').toString(), file.text);
    await assert.rejects(projectDirectory(join(project.path, 'linked')), {code: 'forbidden'});
    await assert.rejects(projectDirectory(join(workspace, '..', 'workspace2')), {code: 'forbidden'});
    await assert.rejects(readProjectFile(project.path, 'linked/demo.html'), {code: 'forbidden'});
    await assert.rejects(downloadProjectFile(project.path, join(outside, 'demo.html'), file.revision, 0), {code: 'forbidden'});
    await assert.rejects(htmlEntry(join(project.path, 'linked', 'demo.html')), {code: 'forbidden'});
    await assert.rejects(openHtmlResource(internal, '/linked/style.css'), {code: 'forbidden'});
    assert.deepEqual(await workspaceProjects([outside, project.path]), [{...project, name: '示例'}]);
  } finally {await setWorkspace();await removeTestTemp(root);}
});

test('Codex guest turns use the connector runtime across a resume', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cmw-guest-runtime-'));
  class Runtime extends EventEmitter {
    requests = new Map();
    calls: string[] = [];
    active = false;
    async start() {}
    async rpc(method: string) {
      this.calls.push(method);
      if (method === 'turn/start') this.active = true;
      return {turn: {id: 'turn'}, thread: {id: 'guest-thread', cwd, turns: this.active ? [{id: 'turn', status: 'inProgress', items: []}] : []}};
    }
    close() {}
  }
  const runtime = new Runtime();
  const desktop = new NoDesktop();
  const control = new Control(new Ledger(':memory:'), runtime as any, desktop);
  const request = (action: 'session.create' | 'turn.send' | 'turn.stop', payload: object) =>
    control.handle({id: randomUUID(), action, payload: {opId: `${Date.now()}:${randomUUID()}`, ...payload}});
  try {
    await setWorkspace(cwd);
    await control.start();
    assert.equal((await request('session.create', {cwd})).state, 'accepted');
    runtime.emit('offline'); // Release the in-memory thread without losing its history.
    const base = {threadId: 'guest-thread', source: 'connector', generation: control.generation};
    const sent = await request('turn.send', {...base, expectedTurnId: null, text: 'fixture'});
    assert.equal(sent.state, 'accepted');
    assert.equal((await request('turn.stop', {...base, expectedTurnId: 'turn'})).state, 'accepted');
    for (const method of ['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']) assert.ok(runtime.calls.includes(method), method);
    assert.equal(desktop.socket, null);
  } finally {control.close();await setWorkspace();await removeTestTemp(cwd);}
});

test('guest Claude sessions are hidden from the owner and the owner desktop is never reached', async () => {
  const env = claudeEnv(GUEST_ENTRYPOINT, {CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'owner-session', PATH: 'x'});
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts', "the owner's `claude --resume` list hides sdk-ts sessions");
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined, "a guest session is never recorded as a child of the owner's session");
  const desktop = new NoDesktop();
  await desktop.refreshThread('thread');
  await assert.rejects(desktop.connect(), /借用电脑/);
});
