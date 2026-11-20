import {createHash, randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {lstat, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {BridgeError, type BridgeService, type Json} from '../shared/types.js';
import type {GuestPaths} from '../shared/config.js';
import {resolveCodex} from './app-server.js';
import {findClaude} from './claude-runtime.js';
import {Desktop} from './desktop.js';
import {ownerHomes, readText, replaceFile, syncClaudeSettings, syncCodexSettings, type OwnerHomes} from './guest-settings.js';

export class NoDesktop extends Desktop {
  override async connect(): Promise<never> {throw new BridgeError('desktop_offline', '借用电脑没有桌面会话');}
  override async follow(): Promise<Json> {return this.connect();}
  override async request(): Promise<Json> {return this.connect();}
  override async refreshThread(_threadId: string) {}
}

/**
 * Guest sessions are recorded as `sdk-ts`, which the owner's `claude --resume` list hides. The
 * separate CLAUDE_CONFIG_DIR is what keeps them apart; this is a second layer if one ever lands in
 * the owner's ~/.claude.
 */
export const GUEST_ENTRYPOINT = 'sdk-ts';

type Login = {expires?: number; refresh?: boolean; updated?: number};
type LoginReader = (value: Json, now?: number) => Login | undefined;
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export const codexLogin: LoginReader = value => {
  const credentials = value?.tokens;
  if (!token(credentials?.access_token)) return token(value?.OPENAI_API_KEY) ? {} : undefined;
  let expires: number | undefined;
  try {
    const exp = JSON.parse(Buffer.from(credentials.access_token.split('.')[1], 'base64url').toString()).exp;
    if (typeof exp === 'number') expires = exp * 1000;
  } catch { /* Opaque tokens can still be used by the runtime. */ }
  return {expires, refresh: token(credentials.refresh_token), updated: Date.parse(value.last_refresh)};
};

export const claudeLogin: LoginReader = (value, now = Date.now()) => {
  const credentials = value?.claudeAiOauth;
  if (!token(credentials?.accessToken)) return;
  return {expires: typeof credentials.expiresAt === 'number' ? credentials.expiresAt : undefined,
    refresh: token(credentials.refreshToken) && !(credentials.refreshTokenExpiresAt <= now)};
};

async function loginFile(path: string, parse: LoginReader, now = Date.now()) {
  try {
    const content = await readFile(path);
    const login = parse(JSON.parse(content.toString('utf8').replace(/^﻿/, '')), now);
    if (login) return {content, login};
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function syncLogin(source: string, target: string, parse: LoginReader, now = Date.now()) {
  const existing = await lstat(target).catch(error => {if (error.code !== 'ENOENT') throw error;});
  if (existing && !existing.isFile()) throw new Error('访客登录文件必须是普通文件');
  const current = await loginFile(target, parse, now);
  const expired = (login: Login) => login.expires !== undefined && login.expires <= now;
  if (current && !expired(current.login)) return true;
  const owner = await loginFile(source, parse, now);
  const newer = current && owner && (
    (!expired(owner.login) && expired(current.login)) ||
    (owner.login.updated ?? 0) > (current.login.updated ?? 0) ||
    (owner.login.expires ?? 0) > (current.login.expires ?? 0)
  );
  if (current?.login.refresh && !newer) return true;
  if (!owner || (expired(owner.login) && !owner.login.refresh)) return false;
  const temp = join(dirname(target), `.login-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, owner.content, {mode: 0o600, flag: 'wx'});
    await rename(temp, target);
  } finally {await rm(temp, {force: true});}
  return true;
}

// ---- Returning the guest's refreshed login to the owner ----

type AppId = 'codex' | 'claude';
type LoginApp = {id: AppId; label: string; parse: LoginReader; owner: string; guest: string};
function loginApps(paths: GuestPaths, owner: OwnerHomes): LoginApp[] {
  return [
    {id: 'codex', label: 'Codex', parse: codexLogin, owner: join(owner.codex, 'auth.json'), guest: join(paths.codexHome, 'auth.json')},
    {id: 'claude', label: 'Claude Code', parse: claudeLogin, owner: join(owner.claude, '.credentials.json'), guest: join(paths.claudeConfig, '.credentials.json')},
  ];
}

/** Fingerprints of the owner's login files as the guest last saw them, to tell whether the owner signed in again since. */
type SyncState = Partial<Record<AppId, string>>;
const fingerprint = (content: Buffer) => createHash('sha256').update(content).digest('hex');
const statePath = (paths: GuestPaths) => join(paths.root, 'login-sync.json');
async function readState(paths: GuestPaths): Promise<SyncState> {
  try {
    const value = JSON.parse(await readText(statePath(paths)) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {return {};}
}
const ownerBytes = (path: string) => readFile(path).catch(error => {if (error.code !== 'ENOENT') throw error;return undefined;});

/**
 * The owner isn't using the apps while the computer is lent. Both copies started as the same login, and when
 * the guest's app refreshes it, the owner's copy may stop working. Writing the refreshed copy back keeps the
 * owner signed in. If the owner's file changed since the guest copied it, the owner signed in again: keep theirs.
 */
export async function returnLogins(paths: GuestPaths, owner = ownerHomes()) {
  const state = await readState(paths), before = JSON.stringify(state), messages: string[] = [];
  let failed = false;
  for (const app of loginApps(paths, owner)) {
    try {
      const guest = await loginFile(app.guest, app.parse);
      if (!guest) continue;
      const current = await ownerBytes(app.owner);
      if (current?.equals(guest.content)) {state[app.id] = fingerprint(current);continue;}
      if (!state[app.id]) continue;
      if (!current || fingerprint(current) !== state[app.id]) {
        messages.push(`${app.label}：这台电脑在借用期间重新登录过，保留它自己的登录`);
        delete state[app.id];
        continue;
      }
      await replaceFile(app.owner, guest.content);
      state[app.id] = fingerprint(guest.content);
      messages.push(`${app.label}：已把借用期间更新的登录写回这台电脑`);
    } catch (error) {
      failed = true;
      messages.push(`${app.label}：登录写回失败（${(error as NodeJS.ErrnoException).code || (error as Error).message}）。请关闭 ${app.label} 后再停止一次。`);
    }
  }
  if (JSON.stringify(state) !== before) await replaceFile(statePath(paths), JSON.stringify(state) + '\n');
  return {messages, failed};
}

/** Remembers the owner's file when both copies hold the same login. */
async function recordCopy(paths: GuestPaths, app: LoginApp) {
  const [current, guest] = await Promise.all([ownerBytes(app.owner), ownerBytes(app.guest)]);
  if (!current || !guest?.equals(current)) return;
  const state = await readState(paths);
  if (state[app.id] === fingerprint(current)) return;
  state[app.id] = fingerprint(current);
  await replaceFile(statePath(paths), JSON.stringify(state) + '\n');
}

// ---- Start-up checks ----

function binary(find: () => string | undefined) {
  try {
    const path = find();
    return path && statSync(path, {throwIfNoEntry: false})?.isFile() ? path : undefined;
  } catch {return undefined;}
}

const SIGN_IN: Record<AppId, string> = {
  codex: '这台电脑还没有登录 Codex。请打开 Codex 登录一次，再重新启动。',
  claude: '这台电脑还没有登录 Claude Code。请在终端运行 claude 并登录一次，再重新启动。',
};

/**
 * Prepares the guest folders: returns a refreshed login to the owner, copies the owner's login and
 * connection settings, and reports which apps can be offered. Whether they really reach their service
 * is tested after the connector starts (see guest-checks.ts).
 */
export async function preflight(paths: GuestPaths, owner = ownerHomes(), env: NodeJS.ProcessEnv = process.env) {
  for (const path of [paths.root, paths.codexHome, paths.claudeConfig, paths.workspace]) {
    await mkdir(path, {recursive: true});
    if (!(await lstat(path)).isDirectory()) throw new Error('访客目录必须是普通文件夹');
  }
  const services: BridgeService[] = [], messages: string[] = [];
  messages.push(...(await returnLogins(paths, owner)).messages);
  const bins: Record<AppId, string | undefined> = {codex: binary(resolveCodex), claude: binary(findClaude)};
  for (const app of loginApps(paths, owner)) {
    if (!bins[app.id]) {messages.push(`${app.label}：没有找到，请先安装 ${app.label}`);continue;}
    try {
      const login = await syncLogin(app.owner, app.guest, app.parse);
      if (login) await recordCopy(paths, app);
      let other = false;
      if (app.id === 'codex') {
        const {provider} = await syncCodexSettings(owner.codex, paths.codexHome);
        other = Boolean(provider && provider !== 'openai') || token(env.OPENAI_API_KEY) || token(env.CODEX_API_KEY);
      } else other = (await syncClaudeSettings(owner, paths.claudeConfig, env)).otherLogin;
      if (login || other) {services.push(app.id);messages.push(`${app.label}：已找到登录和设置`);}
      else messages.push(`${app.label}：${SIGN_IN[app.id]}`);
    } catch {messages.push(`${app.label}：无法准备访客登录和设置，请检查文件和文件夹权限`);}
  }
  return {services, messages};
}

export function useGuestHomes(paths: GuestPaths) {
  // The owner's own variables (proxy, API key, endpoint) stay: the guest uses the owner's account and network.
  // Variables that would point Codex at the owner's own data or desktop app are dropped.
  for (const key of ['CODEX_PROFILE', 'CODEX_LEGACY_BIN', 'CODEX_SQLITE_HOME', 'CODEX_IPC_PATH']) delete process.env[key];
  process.env.CODEX_HOME = paths.codexHome;
  process.env.CLAUDE_CONFIG_DIR = paths.claudeConfig;
}
