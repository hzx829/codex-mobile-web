import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {WebSocket} from 'ws';
import {createRelay} from '../src/server/relay.js';
import {removeTestTemp} from './test-temp.js';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('Usage: npm run test:guest-package -- release/guest-….zip');
const archive = resolve(process.argv[2]);
const checksum = (await readFile(archive + '.sha256', 'utf8')).split(/\s/)[0];
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), checksum);
const temp = await mkdtemp(join(tmpdir(), 'cmw-guest-package-'));
const output = join(temp, '中文 解压目录'), owner = join(temp, 'owner');
const ownerCodex = join(owner, '.codex'), ownerClaude = join(owner, '.claude');
const primary = randomBytes(32).toString('base64url');
let relay: ReturnType<typeof createRelay> | undefined, socket: WebSocket | undefined;
const run = promisify(execFile);
let launcher: ((action: string) => Promise<unknown>) | undefined;
try {
  await mkdir(output);await mkdir(ownerCodex, {recursive: true});await mkdir(ownerClaude);
  execFileSync('tar.exe', ['-xf', archive, '-C', output], {windowsHide: true});
  const roots = await readdir(output);
  assert.equal(roots.length, 1);
  const home = join(output, roots[0]), local = join(home, '.local'), configPath = join(local, 'config.json');
  assert.deepEqual((await readdir(home)).filter(name => name.endsWith('.cmd')).sort(), ['停止.cmd', '启动.cmd', '清除访客数据.cmd'].sort());
  assert.deepEqual(await readdir(local), ['config.json']);
  await assert.rejects(stat(join(home, 'guest')), {code: 'ENOENT'});
  await assert.rejects(stat(join(home, 'node_modules')), {code: 'ENOENT'});
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.mode, 'connector');assert.equal(config.guest, true);
  assert.match(config.machineId, /^guest-[0-9a-f]{12}$/);
  assert.equal(config.token.length, 43);
  assert.notEqual(config.token, primary);
  assert.ok(config.machineName && config.relayUrl);

  relay = createRelay(primary, undefined, 0, [{machineId: config.machineId, token: config.token}]);
  relay.server.listen(0, '127.0.0.1');await once(relay.server, 'listening');
  const address = relay.server.address();
  assert.ok(address && typeof address === 'object');
  config.relayUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(configPath, JSON.stringify(config));

  const env: NodeJS.ProcessEnv = {...process.env, USERPROFILE: owner, HOME: owner, CODEX_HOME: ownerCodex,
    CLAUDE_CONFIG_DIR: ownerClaude, CODEX_BIN: process.execPath, CLAUDE_CODE_BIN: process.execPath};
  for (const key of ['BRIDGE_CONFIG', 'BRIDGE_TOKEN', 'BRIDGE_DATA', 'RELAY_URL']) delete env[key];
  const claudeLogin = JSON.stringify({claudeAiOauth: {accessToken: 'fixture'}});
  await writeFile(join(ownerCodex, 'auth.json'), JSON.stringify({tokens: {access_token: 'fixture'}}));
  await writeFile(join(ownerClaude, '.credentials.json'), claudeLogin);
  await assert.rejects(run(join(home, 'runtime', 'node.exe'), ['build/connector.mjs', '--preflight'], {
    cwd: home, env: {...env, CODEX_BIN: join(owner, 'missing-codex.exe'), CLAUDE_CODE_BIN: join(owner, 'missing-claude.exe')}, windowsHide: true,
  }), {code: 1});
  const preflight = await run(join(home, 'runtime', 'node.exe'), ['build/connector.mjs', '--preflight'], {cwd: home, env, windowsHide: true});
  assert.match(preflight.stdout, /Codex：可用/);
  assert.match(preflight.stdout, /Claude Code：可用/);
  await assert.rejects(stat(join(local, 'operations.sqlite')), {code: 'ENOENT'});

  // No model process is started: Codex is unavailable and Claude is only asked for session metadata.
  env.CODEX_BIN = join(owner, 'not-installed.exe');
  const ps = join(home, 'scripts', 'windows', 'guest.ps1');
  const psArgs = (action: string) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-Action', action, '-NoStatus'];
  launcher = action => run('powershell.exe', psArgs(action), {cwd: home, env, windowsHide: true, timeout: 20000});
  const ws = socket = new WebSocket(config.relayUrl.replace(/^http/, 'ws') + '/ws', {handshakeTimeout: 5000});
  await once(ws, 'open');
  function frame(predicate: (value: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {ws.off('message', listen);reject(Error('Guest relay frame timeout'));}, 12000);
      const listen = (raw: Buffer) => {
        const value = JSON.parse(raw.toString());
        if (predicate(value)) {clearTimeout(timer);ws.off('message', listen);resolve(value);}
      };
      ws.on('message', listen);
    });
  }
  function send(value: object) {ws.send(JSON.stringify(value));}
  const ready = frame(m => m.type === 'ready');
  send({type: 'hello', role: 'phone', token: primary});
  await ready;
  function connected() {return frame(m => m.type === 'machines' && m.data.some((p: any) => p.id === config.machineId));}
  async function request(action: string, payload = {}) {
    const id = randomUUID(), response = frame(m => m.type === 'response' && m.id === id);
    send({type: 'request', machineId: config.machineId, id, action, payload});
    return response;
  }
  const online = connected();
  await Promise.all([launcher('Start'), online]);
  assert.deepEqual((await online).data, [{id: config.machineId, name: config.machineName, guest: true, services: ['claude']}]);
  assert.equal((await request('info')).error.code, 'unavailable');
  assert.equal((await request('antigravity.list')).error.code, 'unsupported');
  const pidFile = join(local, 'connector.pid'), pid = await readFile(pidFile, 'utf8');
  await launcher('Start');
  assert.equal(await readFile(pidFile, 'utf8'), pid);
  const project = (await request('project.create', {name: '测试项目', opId: `${Date.now()}:${randomUUID()}`})).result;
  assert.equal(project.state, 'accepted');
  async function transcript(root: string, cwd: string) {
    const projectDir = join(root, 'projects', 'fixture'), sessionId = randomUUID();
    await mkdir(projectDir, {recursive: true});
    await writeFile(join(projectDir, sessionId + '.jsonl'), JSON.stringify({type: 'user', uuid: randomUUID(),
      parentUuid: null, sessionId, cwd, timestamp: new Date().toISOString(), message: {role: 'user', content: 'fixture'}}) + '\n');
    return sessionId;
  }
  const claudeConfig = join(home, 'guest', 'claude-config');
  const guestSession = await transcript(claudeConfig, project.path);
  const outsideSession = await transcript(claudeConfig, owner);
  const ownerSession = await transcript(ownerClaude, project.path);
  const claude = (await request('claude.list')).result;
  assert.deepEqual(claude.projects.map((item: any) => item.path), [project.path]);
  assert.deepEqual(claude.data.map((item: any) => item.id), [guestSession]);
  assert.equal((await request('claude.read', {conversationId: outsideSession})).error.code, 'forbidden');
  assert.equal((await request('claude.read', {conversationId: ownerSession})).error.code, 'missing');
  assert.equal((await request('claude.read', {conversationId: guestSession})).result.turns[0].items[0].text, 'fixture');
  assert.equal((await request('preview.start', {threadId: 'fixture', filePath: join(owner, 'outside.html')})).error.code, 'forbidden');

  const disconnected = frame(m => m.type === 'machines' && m.data.length === 0);
  await Promise.all([launcher('Stop'), disconnected]);
  await assert.rejects(stat(pidFile), {code: 'ENOENT'});
  const reconnected = connected();
  await Promise.all([launcher('Start'), reconnected]);
  assert.deepEqual((await request('claude.list')).result.projects.map((item: any) => item.path), [project.path]);
  await symlink(owner, join(project.path, 'owner-link'), 'junction');
  execFileSync('powershell.exe', psArgs('Clear'), {cwd: home, env, windowsHide: true, input: 'YES\r\n', timeout: 20000});
  await assert.rejects(stat(join(home, 'guest')), {code: 'ENOENT'});
  await assert.rejects(stat(join(local, 'operations.sqlite')), {code: 'ENOENT'});
  await stat(configPath);
  assert.equal(await readFile(join(ownerClaude, '.credentials.json'), 'utf8'), claudeLogin);
  console.log('Guest package verified: ZIP, scoped relay auth, preflight, project creation, preview guard, duplicate start, restart and clear.');
} finally {
  socket?.terminate();
  if (launcher) await launcher('Stop').catch(() => {});
  if (relay) await relay.close();
  await removeTestTemp(temp);
}
