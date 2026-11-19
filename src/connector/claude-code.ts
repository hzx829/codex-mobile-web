import {readdir, readFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeError, MAX_FRAME, textRequired, type Json} from '../shared/types.js';
import {checkProjectPath, downloadProjectFile, guestWorkspace, projectDirectory, readProjectFile, workspaceProjects} from './project.js';
import {validateImages} from '../shared/images.js';
import type {Ledger} from './ledger.js';
import {ClaudeRuntime, PERMISSION_MODES, type ClaudeResponse, type PermissionMode, type QueryFn} from './claude-runtime.js';
import {claudePatches, claudeTurns, type ClaudeMessage} from './claude-transcript.js';
import type {ArtifactViewer} from './claude-artifacts.js';
import {instructionsInput, mcpServersInput, projectKey, readProjectSettings, saveProjectSettings} from './claude-projects.js';

const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PAGE = 50;
const MAX_TURNS = 60;
/** A transcript written to this recently is treated as an active terminal or IDE session. */
const ACTIVE_MS = 20_000;

type SessionInfo = {sessionId: string; summary: string; customTitle?: string; lastModified: number; fileSize?: number; cwd?: string; archived?: boolean};
/** The subset of the Agent SDK used here; injectable so tests run without real transcripts. */
export type ClaudeSessions = {
  listSessions(options?: {dir?: string; limit?: number; offset?: number}): Promise<SessionInfo[]>;
  getSessionInfo(id: string): Promise<SessionInfo | undefined>;
  getSessionMessages(id: string, options?: {includeSystemMessages?: boolean}): Promise<ClaudeMessage[]>;
  forkSession(id: string, options?: {upToMessageId?: string; title?: string}): Promise<{sessionId: string}>;
  renameSession(id: string, title: string): Promise<void>;
  archiveSession(id: string): Promise<void>;
};

async function sdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new BridgeError('unavailable', '连接器缺少 Claude Agent SDK，请更新连接器');
  }
}
const sdkSessions = async () => await sdk() as unknown as ClaudeSessions;
export const sdkQuery = async () => (await sdk()).query as QueryFn;

function permissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new BridgeError('invalid', '权限模式无效');
  return value as PermissionMode;
}
const optionalModel = (value: unknown) => value === undefined || value === null || value === '' ? undefined : textRequired(value, '模型', 200);
function message(p: Json) {
  const images = p.images === undefined ? [] : validateImages(p.images);
  const text = typeof p.text === 'string' ? p.text.trim() : '';
  if (text.length > 100_000 || text.includes('\0')) throw new BridgeError('invalid', '消息过长或包含无效字符');
  if (!text && !images.length) throw new BridgeError('invalid', '请输入消息或添加图片');
  return {text, images};
}
/** Ledger payloads keep the request identity, not the image bytes. */
const fingerprint = (images: string[]) => images.map(url => createHash('sha256').update(url).digest('hex'));

export function claudeConfigDir(env = process.env) {return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');}
const title = (info: SessionInfo) => (info.customTitle || info.summary || '').trim() || '未命名会话';

export class ClaudeCodeBridge {
  private watchers = 0;
  private catalog?: {at: number; sessions: SessionInfo[]};
  private paths = new Map<string, string>();
  private sending = new Set<string>();
  /** Transcript versions this connector wrote itself (a rename), which must not look like a terminal at work. */
  private ownWrites = new Map<string, bigint>();
  readonly runtime: ClaudeRuntime;
  /** Shows claude.ai Artifacts through this computer; unset where the connector has no browser profile. */
  artifacts?: ArtifactViewer;
  constructor(private ledger?: Ledger, private root = claudeConfigDir(), private sessions: () => Promise<ClaudeSessions> = sdkSessions,
    private now = Date.now, runtime?: ClaudeRuntime) {
    this.runtime = runtime || new ClaudeRuntime(sdkQuery);
    this.runtime.on('change', () => {this.catalog = undefined;});
  }
  get busy() {return this.runtime.busy;}
  close() {this.runtime.close();this.artifacts?.close();}

  /** All sessions, newest first, cached briefly: projects and search both need the whole catalog. */
  private async all(force = false) {
    if (!force && this.catalog && this.now() - this.catalog.at < 30_000) return this.catalog.sessions;
    let sessions = (await (await this.sessions()).listSessions()).filter(info => !info.archived)
      .sort((a, b) => b.lastModified - a.lastModified);
    if (guestWorkspace()) {
      const paths = new Map<string, Promise<string | undefined>>();
      for (const info of sessions) {
        if (info.cwd && !paths.has(info.cwd)) paths.set(info.cwd, projectDirectory(info.cwd).catch(() => undefined));
      }
      const checked = await Promise.all(sessions.map(async info => {
        const cwd = await paths.get(info.cwd || '');
        return cwd ? {...info, cwd} : null;
      }));
      sessions = checked.filter(info => info !== null);
    }
    this.catalog = {at: this.now(), sessions};
    return sessions;
  }

  /** Locates the transcript file so watching only needs a stat, not a parse. */
  private async transcript(id: string) {
    const known = this.paths.get(id);
    if (known) return known;
    const projects = join(this.root, 'projects');
    for (const dir of await readdir(projects).catch(() => [] as string[])) {
      const path = join(projects, dir, id + '.jsonl');
      if (guestWorkspace()) await checkProjectPath(path, this.root);
      if (await stat(path).then(info => info.isFile(), () => false)) {this.paths.set(id, path);return path;}
    }
    throw new BridgeError('missing', '这台电脑上找不到这条 Claude Code 会话');
  }

  private async revision(id: string) {
    const live = this.runtime.get(id);
    const path = await this.transcript(id).catch(error => {if (live) return '';throw error;});
    if (path && guestWorkspace()) await checkProjectPath(path, this.root);
    const info = path ? await stat(path, {bigint: true}).catch(() => {this.paths.delete(id);return null;}) : null;
    if (!info && !live) throw new BridgeError('missing', 'Claude Code 会话已移动或删除，请刷新列表');
    const external = !guestWorkspace() && !live && info !== null && this.now() - Number(info.mtimeMs) < ACTIVE_MS && this.ownWrites.get(id) !== info.mtimeNs;
    return {revision: `${info?.mtimeNs ?? ''}:${info?.size ?? ''}:${live ? live.version : external ? 'external' : '-'}`, external, exists: Boolean(info)};
  }

  private async info(id: string) {
    const info = await (await this.sessions()).getSessionInfo(id);
    if (!info) throw new BridgeError('missing', '这台电脑上找不到这条 Claude Code 会话');
    return guestWorkspace() ? {...info, cwd: await projectDirectory(info.cwd || '')} : info;
  }

  private async read(id: string, known?: string): Promise<Json> {
    let current = await this.revision(id);
    if (known && known === current.revision) {
      if (this.watchers >= 32) throw new BridgeError('busy', '观察请求较多，请稍后重试');
      this.watchers++;
      try {
        const deadline = this.now() + 15_000;
        while (known === current.revision && this.now() < deadline) {
          await delay(600);
          current = await this.revision(id);
        }
      } finally {this.watchers--;}
      if (known === current.revision) return {unchanged: true};
    }
    const live = this.runtime.get(id);
    const sessions = await this.sessions();
    // Right after a session starts its transcript can exist before the SDK can describe it; a live session just shows no messages yet.
    if (live && guestWorkspace()) await projectDirectory(live.cwd);
    const readMessages = () => sessions.getSessionMessages(id, {includeSystemMessages: true});
    const [info, messages] = !current.exists ? [undefined, []] :
      guestWorkspace() && !live ? [await this.info(id), await readMessages()] :
      await Promise.all([live ? sessions.getSessionInfo(id) : this.info(id), readMessages()]);
    // A session this connector runs reports its real state; others are judged by recent transcript writes.
    const external = !live && current.external;
    const running = live ? live.running : external;
    // Edits keep their diffs only in the raw transcript; read it alongside the SDK's messages.
    const raw = current.exists ? await this.transcript(id).then(path => readFile(path, 'utf8'), () => '') : '';
    const turns = claudeTurns(messages, running, claudePatches(raw, info?.cwd || live?.cwd || ''));
    const usage = (messages.findLast(entry => entry.type === 'assistant' && (entry.message as Json | undefined)?.usage)?.message as Json | undefined)?.usage;
    const usedTokens = usage ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0) : 0;
    const contextUsage = usedTokens ? {usedTokens, windowTokens: live ? await this.runtime.contextWindow(live) : null} : null;
    const model = (messages.findLast(entry => typeof (entry.message as Json | undefined)?.model === 'string')?.message as Json | undefined)?.model;
    const recent = [];
    let budget = MAX_FRAME - 1024 * 1024;
    for (const turn of turns.slice(-MAX_TURNS).reverse()) {
      budget -= Buffer.byteLength(JSON.stringify(turn)) + 1;
      if (budget < 0) break;
      recent.push(turn);
    }
    if (turns.length && !recent.length) throw new BridgeError('too_large', 'Claude Code 最新一轮过长，请在电脑上查看');
    return {
      id, title: info ? title(info) : '新会话', cwd: info?.cwd || live?.cwd || '', model: live?.model || model || '', revision: current.revision, running,
      controlled: Boolean(live), external, permissionMode: live?.permissionMode || '', requests: live?.pending || [], error: live?.error || '',
      queued: Boolean(live && live.inbox.size),
      turns: recent.reverse(), truncated: recent.length < turns.length, contextUsage,
      notice: external ? '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后，才能在手机上继续。' : '',
    };
  }

  /** The folder's directory under ~/.claude/projects (its memory lives there): where its sessions are, or Claude Code's key for it. */
  private async projectRoot(folder: string, requested: string) {
    const same = (a = '', b = '') => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    const match = (await this.all().catch(() => [] as SessionInfo[])).find(info => same(info.cwd, requested) || same(info.cwd, folder));
    const path = match ? await this.transcript(match.sessionId).catch(() => '') : '';
    if (path) return dirname(path);
    const key = projectKey(folder);
    return key ? join(this.root, 'projects', key) : '';
  }

  private mutate(p: Json, payload: Json, run: () => Promise<Json>) {
    if (!this.ledger) throw new BridgeError('unavailable', '连接器未启用操作记录');
    return this.ledger.run(textRequired(p.opId, '操作标识', 100), payload, run);
  }

  async handle(action: string, p: Json): Promise<Json> {
    if (action === 'claude.list') {
      const offset = Number.isSafeInteger(p.offset) && p.offset >= 0 ? p.offset : 0;
      // Projects are folders, as in Claude Code itself: sessions are grouped by their working directory.
      const requested = p.project ? textRequired(p.project, '项目', 4096) : '';
      const project = requested && guestWorkspace() ? await projectDirectory(requested) : requested;
      const search = p.search ? textRequired(p.search, '搜索内容', 200).toLowerCase() : '';
      const all = await this.all(p.refresh === true && !offset);
      const matches = all.filter(info => (!project || info.cwd === project) && (!search || title(info).toLowerCase().includes(search)));
      const page = matches.slice(offset, offset + PAGE);
      const paths = [...new Set(all.map(info => info.cwd).filter((cwd): cwd is string => Boolean(cwd)))];
      const projects = !offset && !search
        ? guestWorkspace() ? (await workspaceProjects(paths)).map(item => ({...item, id: item.path})) : paths.map(path => ({id: path, path}))
        : undefined;
      const now = this.now();
      return {data: page.map(info => ({id: info.sessionId, title: title(info), cwd: info.cwd || '', updatedAt: info.lastModified,
        running: this.runtime.get(info.sessionId)?.running ?? (!guestWorkspace() && now - info.lastModified < ACTIVE_MS)})), hasMore: matches.length > offset + PAGE, projects};
    }
    if (action === 'claude.operation') {
      if (!this.ledger) throw new BridgeError('unavailable', '连接器未启用操作记录');
      return this.ledger.read(textRequired(p.opId, '操作标识', 100));
    }
    if (action.startsWith('claude.artifact.')) {
      if (!this.artifacts) throw new BridgeError('unsupported', '这个连接器没有启用 claude.ai 页面中转');
      if (action === 'claude.artifact.snapshot') return this.artifacts.snapshot(p);
      if (action === 'claude.artifact.download') return this.artifacts.download(p);
      if (action === 'claude.artifact.login') return this.artifacts.signIn(p);
    }
    if (action === 'claude.models') return {models: await this.runtime.supportedModels(p.cwd ? await projectDirectory(textRequired(p.cwd, '目录', 4096)) : guestWorkspace() || homedir())};
    if (action === 'claude.project.get') {
      const requested = textRequired(p.folder, '项目文件夹', 4096), folder = await projectDirectory(requested);
      return {project: await readProjectSettings(folder, await this.projectRoot(folder, requested), guestWorkspace() ? this.root : undefined)};
    }
    if (action === 'claude.project.save') {
      const folder = await projectDirectory(textRequired(p.folder, '项目文件夹', 4096));
      const instructions = instructionsInput(p.instructions), revision = textRequired(p.revision, '设置版本', 64);
      const mcpServers = p.mcpServers === null || p.mcpServers === undefined ? null : mcpServersInput(p.mcpServers);
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
      return this.mutate(p, {action, folder, revision, instructions: digest(instructions), mcpServers: digest(mcpServers)},
        () => saveProjectSettings(folder, {instructions, mcpServers, revision}));
    }
    if (action === 'claude.create') {
      const cwd = await projectDirectory(textRequired(p.cwd, '项目目录', 4096));
      const input = message(p), model = optionalModel(p.model), mode = permissionMode(p.permissionMode);
      return this.mutate(p, {action, cwd, text: input.text, images: fingerprint(input.images), model, mode}, async () => {
        const session = await this.runtime.start({cwd, model, permissionMode: mode});
        this.runtime.send(session, input.text, input.images);
        return {conversationId: await this.runtime.waitForId(session)};
      });
    }
    const id = textRequired(p.conversationId, '会话', 36);
    if (!sessionId.test(id)) throw new BridgeError('invalid', 'Claude Code 会话 ID 无效');
    if (action === 'claude.read') return this.read(id);
    if (action === 'claude.watch') return this.read(id, textRequired(p.revision, '会话版本', 200));
    if (action === 'claude.file.read' || action === 'claude.file.download') {
      const path = textRequired(p.path, '文件路径', 4096);
      if (/^[\\/]{2}/.test(path)) throw new BridgeError('invalid', '请选择本机文件');
      const {cwd = ''} = await this.info(id);
      return action === 'claude.file.read' ? readProjectFile(cwd, path)
        : downloadProjectFile(cwd, path, textRequired(p.revision, '文件版本', 64), p.offset);
    }
    if (action === 'claude.send') {
      const input = message(p), model = optionalModel(p.model), mode = permissionMode(p.permissionMode), steer = p.mode === 'steer';
      return this.mutate(p, {action, id, text: input.text, images: fingerprint(input.images), model, mode, steer, confirmIdle: p.confirmIdle === true}, async () => {
        if (this.sending.has(id)) throw new BridgeError('busy', '这条会话已有一条消息正在提交，请稍后再试');
        this.sending.add(id);
        try {
          let session = this.runtime.get(id);
          if (!session) {
            const {cwd = ''} = await this.info(id);
            const directory = await projectDirectory(cwd);
            if ((await this.revision(id)).external && p.confirmIdle !== true)
              throw new BridgeError('active', '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后再继续。');
            session = await this.runtime.start({cwd: directory, resume: id, model, permissionMode: mode});
          } else {
            if (guestWorkspace()) await projectDirectory(session.cwd);
            await this.runtime.configure(session, model, mode);
          }
          this.runtime.send(session, input.text, input.images, steer);
          return {submitted: true};
        } finally {this.sending.delete(id);}
      });
    }
    if (action === 'claude.edit') {
      // Codex-style edit: the session continues from the turn before this message; it and everything after are dropped.
      const turnId = textRequired(p.turnId, '消息', 100), input = message(p), model = optionalModel(p.model), mode = permissionMode(p.permissionMode);
      return this.mutate(p, {action, id, turnId, text: input.text, images: fingerprint(input.images), model, mode, confirmIdle: p.confirmIdle === true}, async () => {
        if (this.sending.has(id)) throw new BridgeError('busy', '这条会话已有一条消息正在提交，请稍后再试');
        this.sending.add(id);
        try {
          const {cwd = ''} = await this.info(id);
          const turns = claudeTurns(await (await this.sessions()).getSessionMessages(id, {includeSystemMessages: true}));
          const index = turns.findIndex(turn => turn.id === turnId);
          if (index < 0 || turns[index].items[0]?.role !== 'user') throw new BridgeError('changed', '找不到这条消息，请刷新会话后重试');
          const anchor = turns[index - 1]?.anchor;
          if (!anchor) throw new BridgeError('invalid', '第一条消息不能改写。可以在会话菜单里“复制会话”，或新建会话');
          const live = this.runtime.get(id);
          if (live) await this.runtime.shutdown(live);
          else if ((await this.revision(id)).external && p.confirmIdle !== true)
            throw new BridgeError('active', '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后再继续。');
          const session = await this.runtime.start({cwd: await projectDirectory(cwd), resume: id, resumeAt: anchor, model, permissionMode: mode});
          this.runtime.send(session, input.text, input.images);
          return {submitted: true};
        } finally {this.sending.delete(id);}
      });
    }
    if (action === 'claude.fork') {
      // Without a message ID the whole session is copied; with one, the copy ends at that turn.
      const upTo = p.upToMessageId === undefined || p.upToMessageId === null || p.upToMessageId === '' ? undefined : textRequired(p.upToMessageId, '分叉位置', 100);
      return this.mutate(p, {action, id, upTo}, async () => {
        const info = await this.info(id), sessions = await this.sessions();
        if (upTo && !(await sessions.getSessionMessages(id, {includeSystemMessages: true})).some(entry => entry.uuid === upTo))
          throw new BridgeError('changed', '找不到这一轮，请刷新会话后重试');
        if (!upTo && (this.runtime.get(id)?.running || (await this.revision(id)).external))
          throw new BridgeError('active', '这条会话正在运行，请等它结束后再复制，或从已完成的一轮分叉');
        const {sessionId: forked} = await sessions.forkSession(id, {upToMessageId: upTo, title: `${title(info)}（${upTo ? '分叉' : '副本'}）`.slice(0, 200)});
        this.catalog = undefined;
        return {conversationId: forked};
      });
    }
    if (action === 'claude.rename') {
      const name = textRequired(p.title, '会话名称', 200);
      return this.mutate(p, {action, id, name}, async () => {
        await this.info(id);
        const before = await this.revision(id);
        await (await this.sessions()).renameSession(id, name);
        this.catalog = undefined;
        if (!before.external) {
          const info = await stat(await this.transcript(id), {bigint: true}).catch(() => null);
          if (info) this.ownWrites.set(id, info.mtimeNs);
        }
        return {title: name};
      });
    }
    if (action === 'claude.archive') return this.mutate(p, {action, id}, async () => {
      await this.info(id);
      const live = this.runtime.get(id);
      if (live?.running || live?.requests.size || (await this.revision(id)).external) throw new BridgeError('active', '这条会话正在运行，请等它结束后再归档');
      if (live) this.runtime.release(live);
      await (await this.sessions()).archiveSession(id);
      this.catalog = undefined;
      return {archived: true};
    });
    const session = this.runtime.get(id);
    if (action === 'claude.stop') return this.mutate(p, {action, id}, async () => {
      if (!session) throw new BridgeError('changed', '这条会话不在手机控制下');
      await this.runtime.interrupt(session);
      return {stopRequested: true};
    });
    if (action === 'claude.respond') {
      const requestId = textRequired(p.requestId, '请求', 40);
      const decision = p.decision;
      if (decision !== 'allow' && decision !== 'allowSession' && decision !== 'deny') throw new BridgeError('invalid', '回应无效');
      const answers = p.answers && typeof p.answers === 'object' ? Object.fromEntries(Object.entries(p.answers).filter(([, value]) => typeof value === 'string')) as Record<string, string> : undefined;
      const response: ClaudeResponse = {decision, answers, message: typeof p.message === 'string' ? p.message : undefined};
      return this.mutate(p, {action, id, requestId, response}, async () => {
        if (!session) throw new BridgeError('expired', '这条会话已不在手机控制下，请刷新');
        this.runtime.respond(session, requestId, response);
        return {responded: true};
      });
    }
    throw new BridgeError('unsupported', '这个连接器版本暂不支持此 Claude Code 操作');
  }
}
