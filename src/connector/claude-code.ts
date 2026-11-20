import {readdir, readFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeError, MAX_FRAME, textRequired, type Json, type TurnView} from '../shared/types.js';
import {downloadProjectFile, projectDirectory, readProjectFile} from './project.js';
import {imageBytes, validateImages} from '../shared/images.js';
import type {Ledger} from './ledger.js';
import {ClaudeRuntime, PERMISSION_MODES, type ClaudeResponse, type PermissionMode, type QueryFn} from './claude-runtime.js';
import {claudeArtifactTitles, claudePatches, claudeTurns, type ClaudeMessage} from './claude-transcript.js';
import type {ArtifactViewer} from './claude-artifacts.js';
import {instructionsInput, mcpServersInput, projectKey, readProjectSettings, saveProjectSettings} from './claude-projects.js';

const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** How a message sent during a running turn is delivered, as in Codex: after the turn, into it, or at once. */
const SEND_MODES = ['queue', 'steer', 'now'] as const;
type SendMode = typeof SEND_MODES[number];
function sendMode(value: unknown): SendMode {
  if (value === undefined || value === null || value === '') return 'queue';
  if (!SEND_MODES.includes(value as SendMode)) throw new BridgeError('invalid', '发送方式无效');
  return value as SendMode;
}
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
  /** Bumped when a session's queue changes, so watching phones see it without a transcript write. */
  private queueVersions = new Map<string, number>();
  private queueTimer: NodeJS.Timeout;
  private closed = false;
  /** Transcript versions this connector wrote itself (a rename), which must not look like a terminal at work. */
  private ownWrites = new Map<string, bigint>();
  readonly runtime: ClaudeRuntime;
  /** Shows claude.ai Artifacts through this computer; unset where the connector has no browser profile. */
  artifacts?: ArtifactViewer;
  constructor(private ledger?: Ledger, private root = claudeConfigDir(), private sessions: () => Promise<ClaudeSessions> = sdkSessions,
    private now = Date.now, runtime?: ClaudeRuntime) {
    this.runtime = runtime || new ClaudeRuntime(sdkQuery);
    this.runtime.on('change', (id: string) => {this.catalog = undefined;if (id) setImmediate(() => this.drainSoon(id));});
    // Also picks up messages left queued across a connector restart, or behind a session that was busy elsewhere.
    this.queueTimer = setInterval(() => {
      try {if (!this.closed) for (const id of new Set(this.queue?.queued().map(message => message.threadId))) this.drainSoon(id);} catch {}
    }, 1500);
    this.queueTimer.unref?.();
  }
  private get queue() {return this.ledger?.claudeQueue;}
  get busy() {return this.runtime.busy || Boolean(this.queue?.queued().length);}
  close() {this.closed = true;clearInterval(this.queueTimer);this.runtime.close();this.artifacts?.close();}

  private drainSoon(id: string) {if (!this.closed) this.drain(id).catch(() => {});}
  private queueChanged(id: string) {this.queueVersions.set(id, (this.queueVersions.get(id) || 0) + 1);}

  /**
   * Sends the first queued message once the session's turn has ended, one per turn, as Codex does. A message that
   * failed or whose delivery is uncertain stops the queue until the phone removes it.
   */
  private async drain(id: string) {
    const queue = this.queue, head = queue?.queued(id)[0];
    if (!queue || !head || head.state !== 'queued' || this.sending.has(id)) return;
    let session = this.runtime.get(id);
    if (session && (session.running || session.requests.size || session.inbox.closed)) return;
    this.sending.add(id);
    try {
      const {text, images = [], model, permissionMode: mode} = head.payload;
      if (!session) {
        const info = await this.info(id).catch(() => undefined);
        // Wait while the terminal or IDE may be running it; never start a second writer.
        if (!info || (await this.revision(id).catch(() => ({external: true}))).external || queue.queued(id)[0]?.id !== head.id) return;
      }
      queue.sending(head.id);this.queueChanged(id);
      try {
        if (!session || session.closed) {
          const {cwd = ''} = await this.info(id);
          session = await this.runtime.start({cwd: await projectDirectory(cwd), resume: id, model, permissionMode: mode});
        } else await this.runtime.configure(session, model, mode);
        this.runtime.send(session, text, images);
        queue.finishQueued(head.id, {conversationId: id, submitted: true});
      } catch (error) {
        queue.finishQueued(head.id, {}, error instanceof BridgeError ? error : new BridgeError('unexpected', '排队消息发送结果待核实，不会自动重发', true));
      }
      this.queueChanged(id);
    } finally {this.sending.delete(id);}
  }

  /** All sessions, newest first, cached briefly: projects and search both need the whole catalog. */
  private async all(force = false) {
    if (!force && this.catalog && this.now() - this.catalog.at < 30_000) return this.catalog.sessions;
    const sessions = (await (await this.sessions()).listSessions()).filter(info => !info.archived)
      .sort((a, b) => b.lastModified - a.lastModified);
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
      if (await stat(path).then(info => info.isFile(), () => false)) {this.paths.set(id, path);return path;}
    }
    throw new BridgeError('missing', '这台电脑上找不到这条 Claude Code 会话');
  }

  private async revision(id: string) {
    const live = this.runtime.get(id);
    const path = await this.transcript(id).catch(error => {if (live) return '';throw error;});
    const info = path ? await stat(path, {bigint: true}).catch(() => {this.paths.delete(id);return null;}) : null;
    if (!info && !live) throw new BridgeError('missing', 'Claude Code 会话已移动或删除，请刷新列表');
    const external = !live && info !== null && this.now() - Number(info.mtimeMs) < ACTIVE_MS && this.ownWrites.get(id) !== info.mtimeNs;
    return {revision: `${info?.mtimeNs ?? ''}:${info?.size ?? ''}:${live ? live.version : external ? 'external' : '-'}:${this.queueVersions.get(id) || 0}`, external, exists: Boolean(info)};
  }

  private async info(id: string) {
    const info = await (await this.sessions()).getSessionInfo(id);
    if (!info) throw new BridgeError('missing', '这台电脑上找不到这条 Claude Code 会话');
    return info;
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
    const [info, messages] = current.exists ? await Promise.all([live ? sessions.getSessionInfo(id) : this.info(id), sessions.getSessionMessages(id, {includeSystemMessages: true})]) : [undefined, []];
    // A session this connector runs reports its real state; others are judged by recent transcript writes.
    const external = !live && current.external;
    const running = live ? live.running : external;
    // Edits keep their diffs only in the raw transcript; read it alongside the SDK's messages.
    const raw = current.exists ? await this.transcript(id).then(path => readFile(path, 'utf8'), () => '') : '';
    const turns = claudeTurns(messages, running, claudePatches(raw, info?.cwd || live?.cwd || ''), claudeArtifactTitles(raw));
    await this.nameSavedPages(turns);
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
      queuedMessages: (this.queue?.queued(id) || []).map(message => ({id: message.id, text: message.payload.text || '',
        imageCount: message.payload.images?.length || 0, imageBytes: (message.payload.images || []).reduce((sum: number, url: string) => sum + imageBytes(url), 0),
        state: message.state, error: message.error})),
      turns: recent.reverse(), truncated: recent.length < turns.length, contextUsage,
      notice: external ? '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后，才能在手机上继续。' : '',
    };
  }

  /** Pages the transcript leaves unnamed take the name of a snapshot already saved on this computer. */
  private async nameSavedPages(turns: TurnView[]) {
    const unnamed = turns.flatMap(turn => turn.pages || []).filter(page => !page.title);
    if (!unnamed.length || !this.artifacts) return;
    const titles = await this.artifacts.savedTitles(unnamed.map(page => page.url)).catch(() => new Map<string, string>());
    for (const page of unnamed) page.title = titles.get(page.url) || '';
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
      const project = p.project ? textRequired(p.project, '项目', 4096) : '';
      const search = p.search ? textRequired(p.search, '搜索内容', 200).toLowerCase() : '';
      const all = await this.all(p.refresh === true && !offset);
      const matches = all.filter(info => (!project || info.cwd === project) && (!search || title(info).toLowerCase().includes(search)));
      const page = matches.slice(offset, offset + PAGE);
      const projects = !offset && !search
        ? [...new Set(all.map(info => info.cwd).filter((cwd): cwd is string => Boolean(cwd)))].map(path => ({id: path, path})) : undefined;
      const now = this.now();
      return {data: page.map(info => ({id: info.sessionId, title: title(info), cwd: info.cwd || '', updatedAt: info.lastModified,
        running: this.runtime.get(info.sessionId)?.running ?? now - info.lastModified < ACTIVE_MS})), hasMore: matches.length > offset + PAGE, projects};
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
    if (action === 'claude.models') return {models: await this.runtime.supportedModels(p.cwd ? await projectDirectory(textRequired(p.cwd, '目录', 4096)) : homedir())};
    if (action === 'claude.project.get') {
      const requested = textRequired(p.folder, '项目文件夹', 4096), folder = await projectDirectory(requested);
      return {project: await readProjectSettings(folder, await this.projectRoot(folder, requested))};
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
      const input = message(p), model = optionalModel(p.model), mode = permissionMode(p.permissionMode), delivery = sendMode(p.mode);
      return this.mutate(p, {action, id, text: input.text, images: fingerprint(input.images), model, mode, delivery, confirmIdle: p.confirmIdle === true}, async () => {
        if (this.sending.has(id)) throw new BridgeError('busy', '这条会话已有一条消息正在提交，请稍后再试');
        this.sending.add(id);
        try {
          let session = this.runtime.get(id);
          // Behind a running turn, or behind messages already waiting, a plain send waits its turn on this computer.
          if (delivery === 'queue' && this.queue && (session?.running || session?.requests.size || this.queue.queued(id).length)) {
            await this.info(id);
            this.queue.enqueue(textRequired(p.opId, '操作标识', 100), id, {text: input.text, images: input.images, model, permissionMode: mode});
            this.queueChanged(id);
            return {conversationId: id, kind: 'queued'};
          }
          if (!session) {
            const {cwd = ''} = await this.info(id);
            const directory = await projectDirectory(cwd);
            if ((await this.revision(id)).external && p.confirmIdle !== true)
              throw new BridgeError('active', '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后再继续。');
            session = await this.runtime.start({cwd: directory, resume: id, model, permissionMode: mode});
          } else await this.runtime.configure(session, model, mode);
          const running = session.running;
          this.runtime.send(session, input.text, input.images, delivery === 'steer' ? 'next' : delivery === 'now' ? 'now' : undefined);
          return {submitted: true, kind: running ? delivery === 'now' ? 'sent_now' : 'steer_accepted' : 'turn_accepted'};
        } finally {this.sending.delete(id);}
      });
    }
    if (action === 'claude.steerQueued' || action === 'claude.withdrawQueued' || action === 'claude.cancelQueued') {
      const queuedId = textRequired(p.queuedId, '排队消息', 100), queue = this.queue;
      return this.mutate(p, {action, id, queuedId}, async () => {
        if (!queue) throw new BridgeError('unavailable', '连接器未启用操作记录');
        if (action !== 'claude.steerQueued') {
          const message = queue.cancelQueued(id, queuedId);
          this.queueChanged(id);
          return action === 'claude.withdrawQueued'
            ? {queuedId, kind: 'queue_withdrawn', message: {text: message.text || '', images: message.images || [], model: message.model, permissionMode: message.permissionMode}}
            : {queuedId, kind: 'queue_cancelled'};
        }
        // Into the running turn with that turn's settings, as Codex's steer does.
        const message = queue.queued(id).find(item => item.id === queuedId), session = this.runtime.get(id);
        if (!message) throw new BridgeError('changed', '消息已经发送或移出队列，请刷新');
        if (message.state !== 'queued') throw new BridgeError('active', '这条消息暂不能追加，请核实发送状态');
        if (!session?.running || session.inbox.closed) throw new BridgeError('changed', '当前没有正在运行的任务，消息会按顺序发送');
        if (this.sending.has(id)) throw new BridgeError('busy', '这条会话已有一条消息正在提交，请稍后再试');
        this.sending.add(id);
        try {
          queue.sending(queuedId);
          try {this.runtime.send(session, message.payload.text, message.payload.images || [], 'next');}
          catch (error) {
            const failure = error instanceof BridgeError ? error : new BridgeError('unexpected', '追加结果待核实，不会自动重发', true);
            queue.finishQueued(queuedId, {}, failure);throw failure;
          }
          queue.finishQueued(queuedId, {conversationId: id, submitted: true, kind: 'steer_accepted'});
          return {queuedId, kind: 'steer_accepted'};
        } finally {this.sending.delete(id);this.queueChanged(id);}
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
      if (this.queue?.queued(id).length) throw new BridgeError('active', '请先处理排队消息再归档');
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
