import {randomBytes} from 'node:crypto';
import {readFile, rename, writeFile} from 'node:fs/promises';
import {isAbsolute, join, win32} from 'node:path';
import {BridgeError, type Json} from '../shared/types.js';

/** A Cowork-style project: folders, standing instructions, memory and MCP servers for Claude Code sessions. */
export type ClaudeProject = {
  id: string; name: string; folders: string[]; instructions: string; memoryDir: string;
  mcpServers: Record<string, Json>; sessionIds: string[]; coworkSpaceId?: string;
};
/** What a session started in a project gets from it. */
export type ProjectLaunch = {cwd: string; additionalDirectories: string[]; append: string; mcpServers: Record<string, Json>};

export const PROJECT_ID = /^p_[0-9a-f]{16}$/;
const MAX_PROJECTS = 200, MAX_FOLDERS = 16, MAX_SESSIONS = 5000;
const MAX_INSTRUCTIONS = 20_000, MAX_MEMORY_INDEX = 20_000, MAX_MCP_JSON = 32_000;

const absolute = (path: string) => isAbsolute(path) || win32.isAbsolute(path);
function text(value: unknown, label: string, max: number, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.includes('\0')) throw new BridgeError('invalid', `${label}无效`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new BridgeError('invalid', `请填写${label}`);
  if (trimmed.length > max) throw new BridgeError('invalid', `${label}过长`);
  return trimmed;
}
function folder(value: unknown, label: string) {
  const path = text(value, label, 4096, true);
  if (!absolute(path) || /^[\\/]{2}/.test(path)) throw new BridgeError('invalid', `${label}需要是本机的完整路径`);
  return path;
}
function mcpServers(value: unknown): Record<string, Json> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') {
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

/** Checks phone input for a project; ids and session lists are kept by the store, not the phone. */
export function projectInput(p: Json) {
  const folders = Array.isArray(p.folders) ? p.folders : typeof p.folders === 'string' ? p.folders.split(/\r?\n/) : [];
  const list = [...new Set(folders.filter((item: unknown) => typeof item !== 'string' || item.trim()).map((item: unknown, i: number) => folder(item, `文件夹 ${i + 1}`)))];
  if (!list.length) throw new BridgeError('invalid', '项目至少需要一个文件夹');
  if (list.length > MAX_FOLDERS) throw new BridgeError('invalid', `项目最多 ${MAX_FOLDERS} 个文件夹`);
  const memoryDir = text(p.memoryDir, '记忆目录', 4096);
  if (memoryDir) folder(memoryDir, '记忆目录');
  return {
    name: text(p.name, '项目名称', 200, true), folders: list, instructions: text(p.instructions, '项目说明', MAX_INSTRUCTIONS),
    memoryDir, mcpServers: mcpServers(p.mcpServers),
  };
}

/** Normalizes one stored project, dropping it when it is unusable rather than failing the whole file. */
function stored(value: unknown): ClaudeProject | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Json;
  if (typeof v.id !== 'string' || !PROJECT_ID.test(v.id)) return null;
  try {
    const input = projectInput(v);
    const sessionIds = Array.isArray(v.sessionIds) ? [...new Set(v.sessionIds.filter((id: unknown): id is string => typeof id === 'string' && id.length <= 64))].slice(-MAX_SESSIONS) : [];
    return {id: v.id, ...input, sessionIds, ...(typeof v.coworkSpaceId === 'string' && v.coworkSpaceId ? {coworkSpaceId: v.coworkSpaceId} : {})};
  } catch {return null;}
}

/**
 * Projects live in the connector's data directory as claude-projects.json.
 * Writes go through a temporary file so a crash never leaves half a file.
 */
export class ProjectStore {
  private cache?: ClaudeProject[];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  async list(): Promise<ClaudeProject[]> {
    if (this.cache) return this.cache;
    let raw: Json = {};
    try {raw = JSON.parse(await readFile(this.file, 'utf8'));} catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new BridgeError('unavailable', '项目文件 claude-projects.json 无法读取，请在电脑检查');
    }
    const seen = new Set<string>();
    this.cache = (Array.isArray(raw.projects) ? raw.projects : []).map(stored)
      .filter((p: ClaudeProject | null): p is ClaudeProject => Boolean(p) && !seen.has(p!.id) && Boolean(seen.add(p!.id)));
    return this.cache!;
  }
  async get(id: string) {
    const project = (await this.list()).find(p => p.id === id);
    if (!project) throw new BridgeError('missing', '项目不存在或已删除');
    return project;
  }
  async ofSession(sessionId: string) {return (await this.list()).find(p => p.sessionIds.includes(sessionId));}

  /** Serializes read-modify-write so concurrent requests never lose each other's changes. */
  private change<T>(edit: (projects: ClaudeProject[]) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const projects = [...await this.list()].map(p => ({...p, sessionIds: [...p.sessionIds]}));
      const result = await edit(projects);
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({projects}, null, 2) + '\n', 'utf8');
      await rename(temp, this.file);
      this.cache = projects;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  create(input: ReturnType<typeof projectInput> & {coworkSpaceId?: string}) {
    return this.change(projects => {
      if (projects.length >= MAX_PROJECTS) throw new BridgeError('invalid', `最多 ${MAX_PROJECTS} 个项目`);
      const project: ClaudeProject = {id: 'p_' + randomBytes(8).toString('hex'), ...input, sessionIds: []};
      projects.push(project);
      return project;
    });
  }
  update(id: string, input: ReturnType<typeof projectInput>) {
    return this.change(projects => {
      const project = projects.find(p => p.id === id);
      if (!project) throw new BridgeError('missing', '项目不存在或已删除');
      Object.assign(project, input);
      return project;
    });
  }
  remove(id: string) {
    return this.change(projects => {
      const index = projects.findIndex(p => p.id === id);
      if (index < 0) throw new BridgeError('missing', '项目不存在或已删除');
      projects.splice(index, 1);
      return true;
    });
  }
  /** Registers a session with exactly one project. */
  addSession(id: string, sessionId: string) {
    return this.change(projects => {
      for (const p of projects) p.sessionIds = p.sessionIds.filter(s => s !== sessionId);
      const project = projects.find(p => p.id === id);
      if (!project) throw new BridgeError('missing', '项目不存在或已删除');
      project.sessionIds = [...project.sessionIds, sessionId].slice(-MAX_SESSIONS);
      return project;
    });
  }
}

/** Reads the memory index (MEMORY.md) so new sessions know which memories exist. */
export async function memoryIndex(dir: string) {
  if (!dir) return '';
  const content = await readFile(join(dir, 'MEMORY.md'), 'utf8').catch(() => '');
  return content.length > MAX_MEMORY_INDEX ? content.slice(0, MAX_MEMORY_INDEX) + '\n…' : content;
}

/** Builds the session options a project contributes: folders, appended prompt and MCP servers. */
export async function projectLaunch(project: ClaudeProject, readMemory = memoryIndex): Promise<ProjectLaunch> {
  const parts = [`# 项目：${project.name}`];
  if (project.folders.length > 1) parts.push(`项目文件夹：\n${project.folders.map(f => `- ${f}`).join('\n')}`);
  if (project.instructions) parts.push(`## 项目说明\n${project.instructions}`);
  if (project.memoryDir) {
    const index = (await readMemory(project.memoryDir)).trim();
    parts.push(`## 项目记忆\n记忆目录：${project.memoryDir}。需要时读取其中的文件；有值得长期记住的内容时写入该目录，并更新 MEMORY.md 索引。` +
      (index ? `\n\n当前索引（MEMORY.md）：\n${index}` : ''));
  }
  return {cwd: project.folders[0], additionalDirectories: project.folders.slice(1), append: parts.join('\n\n'), mcpServers: project.mcpServers};
}
