import {randomUUID} from 'node:crypto';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import type {Json} from '../shared/types.js';

/**
 * Connection settings copied from the owner's Codex and Claude Code into the guest folders on every start.
 * Only what decides how the apps reach their service (proxy, API endpoint, provider, default model) is copied;
 * sessions, memory, MCP servers and other personal settings stay with the owner.
 */

/** Where the owner's apps keep their files. Read before the guest folders replace these variables. */
export function ownerHomes(env: NodeJS.ProcessEnv = process.env) {
  return {
    codex: env.CODEX_HOME || join(homedir(), '.codex'),
    claude: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    claudeJson: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'),
  };
}
export type OwnerHomes = ReturnType<typeof ownerHomes>;

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code || '');
export async function readText(path: string) {
  try {return (await readFile(path, 'utf8')).replace(/^﻿/, '');} catch (error) {if (missing(error)) return undefined;throw error;}
}
/** Replaces a file in one step so a crash never leaves half a login or settings file. */
export async function replaceFile(path: string, content: string | Buffer) {
  const temp = join(dirname(path), `.guest-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, {mode: 0o600, flag: 'wx'});
    await rename(temp, path);
  } finally {await rm(temp, {force: true});}
}
async function readJson(path: string): Promise<Json | undefined> {
  const text = await readText(path);
  if (text === undefined || !text.trim()) return undefined;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {return undefined;}
}

// ---- Claude Code ----

const CLAUDE_SETTINGS = ['env', 'apiKeyHelper', 'forceLoginMethod', 'model', 'awsAuthRefresh', 'awsCredentialExport'];
const CLAUDE_ACCOUNT = ['primaryApiKey', 'oauthAccount'];
/** Variables that let Claude Code sign in without `.credentials.json`. */
const CLAUDE_LOGIN_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const filled = (value: unknown) => typeof value === 'string' ? value.length > 0 : value !== undefined && value !== null;

/**
 * Mirrors the owner's connection settings into the guest `settings.json` and copies the account fields
 * of `.claude.json`. Returns whether the owner signs in some other way than `.credentials.json`.
 */
export async function syncClaudeSettings(owner: Pick<OwnerHomes, 'claude' | 'claudeJson'>, guestDir: string, env: NodeJS.ProcessEnv = process.env) {
  const ownerSettings = await readJson(join(owner.claude, 'settings.json')) || {};
  const guestPath = join(guestDir, 'settings.json');
  const guestText = await readText(guestPath);
  const guest = await readJson(guestPath) || {};
  const next: Json = {...guest};
  for (const key of CLAUDE_SETTINGS) {
    if (filled(ownerSettings[key])) next[key] = ownerSettings[key];
    else delete next[key];
  }
  const settings = JSON.stringify(next, null, 2) + '\n';
  if (settings !== guestText && (guestText !== undefined || Object.keys(next).length)) await replaceFile(guestPath, settings);

  const ownerAccount = await readJson(owner.claudeJson) || {};
  const accountPath = join(guestDir, '.claude.json');
  const account = await readJson(accountPath) || {};
  const updates = CLAUDE_ACCOUNT.filter(key => filled(ownerAccount[key]) && JSON.stringify(account[key]) !== JSON.stringify(ownerAccount[key]));
  if (updates.length) {
    for (const key of updates) account[key] = ownerAccount[key];
    await replaceFile(accountPath, JSON.stringify(account, null, 2) + '\n');
  }

  const ownerEnv = ownerSettings.env && typeof ownerSettings.env === 'object' ? ownerSettings.env : {};
  const otherLogin = CLAUDE_LOGIN_ENV.some(key => filled(env[key]) || filled(ownerEnv[key])) ||
    filled(ownerSettings.apiKeyHelper) || filled(ownerAccount.primaryApiKey);
  return {otherLogin};
}

// ---- Codex ----

const CODEX_KEYS = new Set(['model_provider', 'model', 'model_reasoning_effort', 'preferred_auth_method', 'forced_login_method',
  'disable_response_storage', 'model_context_window', 'model_max_output_tokens', 'model_auto_compact_token_limit']);
export const SYNC_START = '# >>> 访客模式：从这台电脑的 Codex 设置同步，每次启动自动更新，请勿修改';
export const SYNC_END = '# <<< 访客模式同步结束';

type Table = {name: string; lines: string[]};
const HEADER = /^\s*\[(\[)?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const KEY = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/;
/** `profiles."a b"` and `profiles . 'a b'` name the same table. */
const tableName = (raw: string) => raw.replace(/\s*\.\s*/g, '.').replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b);

/**
 * Splits TOML into the top-level lines and its tables. Only used to pick a few single-line keys
 * and whole `[model_providers.*]` tables, which are copied verbatim.
 */
function splitToml(text: string) {
  const top: string[] = [], tables: Table[] = [];
  let current: Table | undefined;
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {current = {name: tableName(header[2]), lines: [line]};tables.push(current);continue;}
    (current ? current.lines : top).push(line);
  }
  return {top, tables};
}
/** Single-line `key = value` pairs; multi-line values are never among the copied keys. */
function scalars(lines: string[]) {
  const values = new Map<string, string>();
  for (const line of lines) {
    const match = KEY.exec(line);
    if (match && match[2] && !/^(\[|\{|"""|''')/.test(match[2])) values.set(match[1], line.trim());
  }
  return values;
}
const unquote = (value: string) => value.replace(/\s+#.*$/, '').trim().replace(/^"(.*)"$|^'(.*)'$/, (_, a, b) => a ?? b);

export function stripSynced(text: string) {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === SYNC_START) {inside = true;continue;}
    if (inside) {if (line.trim() === SYNC_END) inside = false;continue;}
    out.push(line);
  }
  return out.join('\n');
}

/** The guest `config.toml` with the owner's provider settings in marked blocks; the guest's own lines win. */
export function mergeCodexConfig(owner: string, guest: string) {
  const source = splitToml(owner);
  const picked = new Map([...scalars(source.top)].filter(([key]) => CODEX_KEYS.has(key)));
  // A selected profile overrides the top-level values, as it does in Codex.
  const profile = scalars(source.top).get('profile');
  if (profile) {
    const name = 'profiles.' + unquote(profile.split('=').slice(1).join('='));
    for (const table of source.tables.filter(table => table.name === name))
      for (const [key, line] of scalars(table.lines.slice(1))) if (CODEX_KEYS.has(key)) picked.set(key, line);
  }
  const rest = stripSynced(guest).replace(/^(\s*\n)+/, '').replace(/\s+$/, '');
  const own = splitToml(rest);
  const ownKeys = scalars(own.top), ownTables = new Set(own.tables.map(table => table.name));
  const top = [...picked].filter(([key]) => !ownKeys.has(key)).map(([, line]) => line);
  const providers = source.tables.filter(table => table.name.startsWith('model_providers.') && !ownTables.has(table.name))
    .map(table => table.lines.join('\n').replace(/\s+$/, ''));
  const parts = [
    top.length ? [SYNC_START, ...top, SYNC_END].join('\n') : '',
    rest,
    providers.length ? [SYNC_START, providers.join('\n\n'), SYNC_END].join('\n') : '',
  ].filter(Boolean);
  const provider = picked.get('model_provider') ?? ownKeys.get('model_provider');
  return {text: parts.length ? parts.join('\n\n') + '\n' : '', provider: provider ? unquote(provider.split('=').slice(1).join('=')) : undefined};
}

/** Copies the owner's provider settings into the guest `config.toml`. Returns the provider Codex will use. */
export async function syncCodexSettings(ownerDir: string, guestDir: string) {
  const owner = await readText(join(ownerDir, 'config.toml')) ?? '';
  const path = join(guestDir, 'config.toml');
  const guest = await readText(path);
  const {text, provider} = mergeCodexConfig(owner, guest ?? '');
  if (text !== (guest ?? '') && (guest !== undefined || text)) await replaceFile(path, text);
  return {provider};
}
