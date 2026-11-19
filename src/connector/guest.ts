import {randomUUID} from 'node:crypto';
import {statSync} from 'node:fs';
import {lstat, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {BridgeError, type BridgeService, type Json} from '../shared/types.js';
import type {GuestPaths} from '../shared/config.js';
import {resolveCodex} from './app-server.js';
import {findClaude} from './claude-runtime.js';
import {Desktop} from './desktop.js';

export class NoDesktop extends Desktop {
  override async connect(): Promise<never> {throw new BridgeError('desktop_offline', '借用电脑没有桌面会话');}
  override async follow(): Promise<Json> {return this.connect();}
  override async request(): Promise<Json> {return this.connect();}
}

type Login = {expires?: number; refresh?: boolean; updated?: number};
type LoginReader = (value: Json) => Login | undefined;
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

export const claudeLogin: LoginReader = value => {
  const credentials = value?.claudeAiOauth;
  if (!token(credentials?.accessToken)) return;
  return {expires: typeof credentials.expiresAt === 'number' ? credentials.expiresAt : undefined,
    refresh: token(credentials.refreshToken) && !(credentials.refreshTokenExpiresAt <= Date.now())};
};

async function loginFile(path: string, parse: LoginReader) {
  try {
    const content = await readFile(path);
    const login = parse(JSON.parse(content.toString('utf8')));
    if (login) return {content, login};
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function syncLogin(source: string, target: string, parse: LoginReader, now = Date.now()) {
  const existing = await lstat(target).catch(error => {if (error.code !== 'ENOENT') throw error;});
  if (existing && !existing.isFile()) throw new Error('访客登录文件必须是普通文件');
  const current = await loginFile(target, parse);
  const expired = (login: Login) => login.expires !== undefined && login.expires <= now;
  if (current && !expired(current.login)) return true;
  const owner = await loginFile(source, parse);
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

function binary(find: () => string | undefined) {
  try {
    const path = find();
    return path && statSync(path, {throwIfNoEntry: false})?.isFile() ? path : undefined;
  } catch {return undefined;}
}

export async function preflight(paths: GuestPaths) {
  for (const path of [paths.root, paths.codexHome, paths.claudeConfig, paths.workspace]) {
    await mkdir(path, {recursive: true});
    if (!(await lstat(path)).isDirectory()) throw new Error('访客目录必须是普通文件夹');
  }
  const codexBin = binary(resolveCodex), claudeBin = binary(findClaude);
  const apps = [
    {id: 'codex', label: 'Codex', bin: codexBin, parse: codexLogin, filename: 'auth.json',
      owner: process.env.CODEX_HOME || join(homedir(), '.codex'), target: paths.codexHome},
    {id: 'claude', label: 'Claude Code', bin: claudeBin, parse: claudeLogin, filename: '.credentials.json',
      owner: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), target: paths.claudeConfig},
  ] as const;
  const services: BridgeService[] = [], messages: string[] = [];
  for (const app of apps) {
    let status = '未找到可执行文件，请先安装';
    if (app.bin) {
      try {
        const ready = await syncLogin(join(app.owner, app.filename), join(app.target, app.filename), app.parse);
        if (ready) {services.push(app.id);status = '可用';}
        else status = `找不到可用的 ${app.filename}，请在电脑上登录`;
      } catch {status = '无法准备访客登录文件，请检查文件和目录权限';}
    }
    messages.push(`${app.label}：${status}`);
  }
  return {services, messages};
}

export function useGuestHomes(paths: GuestPaths) {
  for (const key of ['CODEX_PROFILE', 'CODEX_LEGACY_BIN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY',
    'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_TOKEN_FILE', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[key];
  process.env.CODEX_HOME = paths.codexHome;
  process.env.CLAUDE_CONFIG_DIR = paths.claudeConfig;
}
