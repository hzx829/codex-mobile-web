import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {BridgeError, type Json} from '../shared/types.js';

/**
 * A Claude Code project is a folder. Its settings are Claude Code's own files, so the terminal,
 * the desktop app and phone sessions all see the same thing:
 * - instructions: CLAUDE.md (or .claude/CLAUDE.md) in the folder
 * - MCP servers: .mcp.json in the folder, approved in .claude/settings.local.json
 * - memory: Claude Code's auto memory, ~/.claude/projects/<folder key>/memory/MEMORY.md (read only here)
 */
export type ProjectSettings = {
  folder: string; claudeMd: string; instructions: string | null; mcpFile: string; mcpServers: string;
  memoryDir: string; memoryIndex: string; memoryFiles: string[]; revision: string;
};

const MAX_INSTRUCTIONS = 200_000, MAX_MCP_JSON = 64_000, MAX_MEMORY_INDEX = 20_000, MAX_MEMORY_FILES = 200;

/** The folder key Claude Code uses under ~/.claude/projects; long paths are shortened there, so only short ones are guessed. */
export function projectKey(folder: string) {
  const key = folder.replace(/[^a-zA-Z0-9]/g, '-');
  return key.length <= 200 ? key : '';
}

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code || '');
async function optional(path: string) {
  try {return await readFile(path, 'utf8');} catch (error) {if (missing(error)) return null;throw readError(error);}
}
function readError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EACCES' || code === 'EPERM' ? new BridgeError('forbidden', '连接器没有权限读取这个项目的设置文件') : error;
}
async function exists(path: string) {return stat(path).then(info => info.isFile(), () => false);}
async function atomicWrite(path: string, content: string) {
  await mkdir(dirname(path), {recursive: true});
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, path);
}
const hash = (...parts: (string | null)[]) => createHash('sha256').update(parts.map(part => part ?? '\0missing').join('\0\0')).digest('hex').slice(0, 32);

/** CLAUDE.md in the folder, or .claude/CLAUDE.md when only that one exists. */
async function claudeMdPath(folder: string) {
  const root = join(folder, 'CLAUDE.md'), nested = join(folder, '.claude', 'CLAUDE.md');
  return !(await exists(root)) && await exists(nested) ? nested : root;
}

/** Checks the phone's MCP text: an object keyed by server name, each with a command or url. */
export function mcpServersInput(value: unknown): Record<string, Json> {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return {};
  if (typeof value === 'string') {
    if (value.length > MAX_MCP_JSON) throw new BridgeError('invalid', 'MCP 配置过长');
    try {value = JSON.parse(value);} catch {throw new BridgeError('invalid', 'MCP 配置不是有效的 JSON');}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('invalid', 'MCP 配置需要是以服务器名为键的对象');
  if (JSON.stringify(value).length > MAX_MCP_JSON) throw new BridgeError('invalid', 'MCP 配置过长');
  for (const [name, server] of Object.entries(value)) {
    if (!/^[\w.-]{1,64}$/.test(name)) throw new BridgeError('invalid', `MCP 服务器名称无效：${name.slice(0, 64)}`);
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new BridgeError('invalid', `MCP 服务器 ${name} 的配置无效`);
    const s = server as Json;
    if (typeof s.command !== 'string' && typeof s.url !== 'string') throw new BridgeError('invalid', `MCP 服务器 ${name} 需要 command 或 url`);
  }
  return value as Record<string, Json>;
}

function parseJson(text: string | null, label: string): Json {
  if (text === null || !text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new BridgeError('invalid', `${label} 不是有效的 JSON，请在电脑上修正后再改`);
}

/** Reads a folder's Claude Code settings. `memoryRoot` is the folder's directory under ~/.claude/projects, if known. */
export async function readProjectSettings(folder: string, memoryRoot: string): Promise<ProjectSettings> {
  const claudeMd = await claudeMdPath(folder), mcpFile = join(folder, '.mcp.json');
  const [instructions, mcp] = await Promise.all([optional(claudeMd), optional(mcpFile)]);
  let mcpServers = '';
  if (mcp !== null && mcp.trim()) {
    try {
      const servers = JSON.parse(mcp)?.mcpServers;
      mcpServers = servers && typeof servers === 'object' && Object.keys(servers).length ? JSON.stringify(servers, null, 2) : '';
    } catch {mcpServers = mcp;} // Shown as is, so the phone can see and fix it.
  }
  const memoryDir = memoryRoot ? join(memoryRoot, 'memory') : '';
  let memoryIndex = '', memoryFiles: string[] = [];
  if (memoryDir) {
    memoryIndex = (await optional(join(memoryDir, 'MEMORY.md')).catch(() => null)) || '';
    if (memoryIndex.length > MAX_MEMORY_INDEX) memoryIndex = memoryIndex.slice(0, MAX_MEMORY_INDEX) + '\n…';
    memoryFiles = (await readdir(memoryDir).catch(() => [] as string[])).filter(name => name.endsWith('.md') && name !== 'MEMORY.md').sort().slice(0, MAX_MEMORY_FILES);
  }
  return {
    folder, claudeMd, instructions: instructions !== null && instructions.length > MAX_INSTRUCTIONS ? null : instructions || '',
    mcpFile, mcpServers, memoryDir, memoryIndex, memoryFiles, revision: hash(instructions, mcp),
  };
}

/**
 * Writes CLAUDE.md and .mcp.json when they differ, refusing if either changed on the computer since `revision`.
 * `instructions: null` leaves CLAUDE.md alone (it is too long to edit on a phone); `mcpServers: null` leaves .mcp.json alone.
 * New .mcp.json servers are approved in .claude/settings.local.json, as approving them in the terminal would.
 */
export async function saveProjectSettings(folder: string, input: {instructions: string | null; mcpServers: Record<string, Json> | null; revision: string}) {
  const claudeMd = await claudeMdPath(folder), mcpFile = join(folder, '.mcp.json');
  const [instructions, mcp] = await Promise.all([optional(claudeMd), optional(mcpFile)]);
  if (hash(instructions, mcp) !== input.revision) throw new BridgeError('changed', '项目设置在电脑上被改过，请重新打开后再改');
  if (input.instructions !== null) {
    // Keep the file's line endings so an untouched CLAUDE.md is not rewritten.
    const eol = instructions?.includes('\r\n') ? '\r\n' : '\n';
    const text = input.instructions.replace(/\n/g, eol);
    if (text !== (instructions ?? '') && (instructions !== null || text.trim())) await atomicWrite(claudeMd, text && !text.endsWith(eol) ? text + eol : text);
  }
  if (!input.mcpServers) return {saved: true};
  let current: Json = {};
  try {current = parseJson(mcp, '.mcp.json');} catch {current = {};} // An unreadable file was shown to the phone as text and is replaced.
  const before = current.mcpServers && typeof current.mcpServers === 'object' ? current.mcpServers : {};
  if (JSON.stringify(before) !== JSON.stringify(input.mcpServers) && (mcp !== null || Object.keys(input.mcpServers).length)) {
    await atomicWrite(mcpFile, JSON.stringify({...current, mcpServers: input.mcpServers}, null, 2) + '\n');
    const added = Object.keys(input.mcpServers).filter(name => !(name in before));
    if (added.length) {
      const localFile = join(folder, '.claude', 'settings.local.json');
      const local = parseJson(await optional(localFile), '.claude/settings.local.json');
      const enabled: string[] = Array.isArray(local.enabledMcpjsonServers) ? local.enabledMcpjsonServers.filter((name: unknown) => typeof name === 'string') : [];
      const disabled = new Set(Array.isArray(local.disabledMcpjsonServers) ? local.disabledMcpjsonServers : []);
      const next = [...new Set([...enabled, ...added.filter(name => !disabled.has(name))])];
      if (next.length !== enabled.length) await atomicWrite(localFile, JSON.stringify({...local, enabledMcpjsonServers: next}, null, 2) + '\n');
    }
  }
  return {saved: true};
}

/** Instructions from the phone: plain text, '' clears, null keeps the file as it is. */
export function instructionsInput(value: unknown): string | null {
  if (value === null) return null;
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.includes('\0')) throw new BridgeError('invalid', '项目说明无效');
  if (value.length > MAX_INSTRUCTIONS) throw new BridgeError('invalid', '项目说明过长，请在电脑上编辑');
  return value.replace(/\r\n/g, '\n');
}
