import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GUEST_ENTRYPOINT, NoDesktop, applyGuestEnv, guestPaths, noAntigravity, prepareGuest, syncLogin} from '../src/connector/guest.js';
import {claudeEnv} from '../src/connector/claude-runtime.js';
import {ServiceRouter} from '../src/connector/services.js';
import {BridgeError} from '../src/shared/types.js';

function temp() {return mkdtempSync(join(tmpdir(), 'guest-'));}

test('guest sign-in is copied from the host once and never overwritten', () => {
  const root = temp();
  try {
    const home = join(root, 'host'), paths = guestPaths(join(root, 'guest'));
    assert.deepEqual(prepareGuest(paths, home), {codex: false, claude: false}, 'a host that is not signed in leaves both apps off');
    for (const dir of [paths.codexHome, paths.claudeConfig, paths.workspace]) assert.ok(existsSync(dir));
    mkdirSync(join(home, '.codex'), {recursive: true});mkdirSync(join(home, '.claude'), {recursive: true});
    writeFileSync(join(home, '.codex', 'auth.json'), 'host-codex');
    writeFileSync(join(home, '.claude', '.credentials.json'), 'host-claude');
    assert.deepEqual(syncLogin(paths, home), {codex: true, claude: true});
    assert.equal(readFileSync(join(paths.codexHome, 'auth.json'), 'utf8'), 'host-codex');
    assert.equal(readFileSync(join(paths.claudeConfig, '.credentials.json'), 'utf8'), 'host-claude');
    // The guest copy refreshes on its own; a later start keeps it.
    writeFileSync(join(paths.codexHome, 'auth.json'), 'guest-refreshed');
    writeFileSync(join(home, '.codex', 'auth.json'), 'host-refreshed');
    syncLogin(paths, home);
    assert.equal(readFileSync(join(paths.codexHome, 'auth.json'), 'utf8'), 'guest-refreshed');
    assert.equal(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'), 'host-refreshed', 'the host file is never written');
  } finally {rmSync(root, {recursive: true, force: true});}
});

test('guest environment points Codex and Claude Code at the guest directories only', () => {
  const paths = guestPaths(join(tmpdir(), 'pkg', 'guest'));
  const env: NodeJS.ProcessEnv = {PATH: 'x', CODEX_HOME: 'C:\\host\\.codex', CODEX_SQLITE_HOME: 'C:\\host\\.codex', CODEX_IPC_PATH: '\\\\.\\pipe\\x', CODEX_PROFILE: 'work', CLAUDE_CONFIG_DIR: 'C:\\host\\.claude'};
  applyGuestEnv(paths, env);
  assert.deepEqual(env, {PATH: 'x', CODEX_HOME: paths.codexHome, CLAUDE_CONFIG_DIR: paths.claudeConfig});
  const claude = claudeEnv(GUEST_ENTRYPOINT, {...env, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop'});
  assert.equal(claude.CLAUDE_CONFIG_DIR, paths.claudeConfig, 'Claude Code records guest sessions in the guest directory');
  assert.equal(claude.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts', 'and as sdk-ts, which the host terminal list hides');
  assert.equal(claude.CLAUDECODE, undefined);
});

test('a guest computer never reaches the host desktop or Antigravity', async () => {
  const desktop = new NoDesktop();
  const offline = (error: BridgeError) => error.code === 'desktop_offline';
  await assert.rejects(desktop.connect(), offline);
  await assert.rejects(desktop.follow('thread'), offline);
  await assert.rejects(desktop.request('thread-owner-discovery', {}), offline);
  await desktop.refreshThread('thread');
  assert.equal(desktop.clientId, '');
  const router = new ServiceRouter([noAntigravity], async () => ({}));
  await assert.rejects(router.handle({id: '1', action: 'antigravity.list', payload: {}}), (error: BridgeError) => error.code === 'unsupported');
});
