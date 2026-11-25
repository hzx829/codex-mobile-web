import {readdir, readFile, stat, writeFile} from 'node:fs/promises';
import {step, stepSync} from './trace.js';
import type {ThreadSource} from './thread-hub.js';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeError, MAX_FRAME, textRequired, type Json, type TurnView} from '../shared/types.js';
import {projectPathKey} from '../shared/project-paths.js';
import {checkProjectPath, downloadProjectFile, openProjectDownload, guestWorkspace, projectDirectory, readProjectFile, workspaceProjects} from './project.js';
import {imageBytes, validateImages} from '../shared/images.js';
import type {Ledger} from './ledger.js';
import {MAX_ATTACHMENTS, type FileAttachment} from '../shared/attachments.js';
import {attachmentIds, requestFiles, scopedUpload, withAttachmentLinks} from './attachments.js';
import {CLAUDE_EFFORTS, ClaudeRuntime, PERMISSION_MODES, type ClaudeEffort, type ClaudeResponse, type LiveSession, type PermissionMode, type QueryFn} from './claude-runtime.js';
import {claudeArtifactTitles, claudeEarlierMessages, claudePatches, claudeRecordedSettings, claudeTranscriptCwd, claudeTurns, lastExchange, type ClaudeMessage, type Exchange} from './claude-transcript.js';
import type {ArtifactViewer} from './claude-artifacts.js';
import {entryTimestamp, holderName, readPeerStatuses, type PeerStatus} from './claude-progress.js';
import {instructionsInput, mcpServersInput, projectKey, readProjectSettings, saveProjectSettings} from './claude-projects.js';
import {claudeUserText, sendersByText} from './message-senders.js';

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
/** How long a finished streaming block is shown while the transcript has not caught up. */
const STREAM_SETTLE_MS = 3000;
/** The most earlier turns one read adds above the ones the phone already shows. */
const MAX_EARLIER = 100;
/** Which turns a read returns: the latest ones, back to the turn `from` when the phone already shows it, plus `earlier` before that. */
type ReadWindow = {from?: string; earlier?: number};
type Revision = Awaited<ReturnType<ClaudeCodeBridge['revision']>>;
function readWindow(p: Json): ReadWindow {
  const from = p.from === undefined || p.from === null || p.from === '' ? undefined : textRequired(p.from, '起始轮次', 100);
  const earlier = p.earlier === undefined || p.earlier === null ? 0 : Number(p.earlier);
  if (!Number.isInteger(earlier) || earlier < 0) throw new BridgeError('invalid', '加载范围无效');
  return {from, earlier: Math.min(earlier, MAX_EARLIER)};
}
/** A transcript written to this recently is treated as an active terminal or IDE session. */
const ACTIVE_MS = 20_000;
/** The file system's clock and this process's can differ a little; a write this soon after the connector's own is still its own. */
const RELEASE_SLACK_MS = 1000;

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
/**
 * A session open in another program runs the phone's messages in this connector's own process; that program keeps its own
 * copy of the conversation and does not reload it (Claude Code's cross-session messages arrive as a peer's, not the user's).
 */
const heldNotice = (app: string) => `这条会话在${app}里开着。手机发的消息由连接器在另一个进程里运行，${app}不会显示，那边的 Claude 也看不到。回到电脑上继续前，请重启${app}或重新打开这条会话，否则那边会接着旧的内容写下去。`;
type SessionSettings = {model: string; effort: ClaudeEffort | ''; permissionMode: PermissionMode | ''};
type ChosenSettings = {model?: string; effort?: ClaudeEffort; permissionMode?: PermissionMode};
/**
 * The settings a session runs with: what Claude Code reports while this connector runs it, else what the transcript last
 * recorded (a session run in the terminal or the desktop app). The session view and every resume read them here.
 */
function sessionSettings(live: LiveSession | undefined, transcript: string): SessionSettings {
  const recorded = claudeRecordedSettings(transcript);
  const effort = live?.effort || recorded.effort, mode = live?.permissionMode || recorded.permissionMode;
  return {model: live?.model || recorded.model,
    effort: CLAUDE_EFFORTS.includes(effort as ClaudeEffort) ? effort as ClaudeEffort : '',
    permissionMode: PERMISSION_MODES.includes(mode as PermissionMode) ? mode as PermissionMode : ''};
}
function optionalEffort(value: unknown): ClaudeEffort | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!CLAUDE_EFFORTS.includes(value as ClaudeEffort)) throw new BridgeError('invalid', '思考程度无效');
  return value as ClaudeEffort;
}
const optionalModel = (value: unknown) => value === undefined || value === null || value === '' ? undefined : textRequired(value, '模型', 200);
function message(p: Json) {
  const images = p.images === undefined ? [] : validateImages(p.images), files = requestFiles(p.files);
  const text = typeof p.text === 'string' ? p.text.trim() : '';
  if (text.length > 100_000 || text.includes('\0')) throw new BridgeError('invalid', '消息过长或包含无效字符');
  if (!text && !images.length && !files.length) throw new BridgeError('invalid', '请输入消息或添加附件');
  if (images.length + files.length > MAX_ATTACHMENTS) throw new BridgeError('invalid', `图片和文件合计最多添加 ${MAX_ATTACHMENTS} 个`);
  return {text, images, files};
}
const newScope = (cwd: string) => `claude-new:${cwd}`, sessionScope = (id: string) => `claude:${id}`;
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
  private queueListeners: ((id: string) => void)[] = [];
  private states = new Map<string, {revision: string; value: Promise<{head: Json; turns: TurnView[]}>}>();
  private queueTimer: NodeJS.Timeout;
  private closed = false;
  /**
   * When this connector last wrote each session's transcript itself, with no process left holding it: a fork it just made,
   * or a session its own process let go, which saves the session's closing entries as it exits.
   */
  private ownUntil = new Map<string, number>();
  /** Where each recently written transcript's conversation stands, by file version. */
  private exchanges = new Map<string, {version: string; value: Promise<Exchange | undefined | null>}>();
  private peers?: {at: number; value: Promise<Map<string, PeerStatus>>};
  /** Claude Code's guess at the next prompt, by session, with the turn it follows; it outlives the released process. */
  private suggestions = new Map<string, {text: string; turn: string}>();
  /** What a session said before its latest compaction, by session and that compaction's boundary: it never changes. */
  private compacted = new Map<string, {boundary: string; messages: ClaudeMessage[]}>();
  readonly runtime: ClaudeRuntime;
  /** Shows claude.ai Artifacts through this computer; unset where the connector has no browser profile. */
  artifacts?: ArtifactViewer;
  constructor(private ledger?: Ledger, private root = claudeConfigDir(), private sessions: () => Promise<ClaudeSessions> = sdkSessions,
    private now = Date.now, runtime?: ClaudeRuntime) {
    this.runtime = runtime || new ClaudeRuntime(sdkQuery);
    this.runtime.on('change', (id: string) => {this.catalog = undefined;if (id) setImmediate(() => this.drainSoon(id));});
    this.runtime.on('closed', (id: string) => {if (id) this.ownUntil.set(id, this.now());});
    // Also picks up messages left queued across a connector restart, or behind a session that was busy elsewhere.
    this.queueTimer = setInterval(() => {
      try {if (!this.closed) for (const id of new Set(this.queue?.queued().map(message => message.threadId))) this.drainSoon(id);} catch {}
    }, 1500);
    this.queueTimer.unref?.();
  }
  private get queue() {return this.ledger?.claudeQueue;}
  get busy() {return this.runtime.busy || Boolean(this.queue?.queued().length);}
  activeTasks(): {service: 'claude'; threadId: string; actorName?: string; queued?: boolean}[] {
    const seen = new Set<string>(), tasks: {service: 'claude'; threadId: string; actorName?: string; queued?: boolean}[] = [];
    for (const session of this.runtime.activeSessions()) {
      seen.add(session.threadId);
      const actor = session.opId ? this.ledger?.actor(session.opId)?.name : undefined;
      tasks.push({service: 'claude', threadId: session.threadId, ...actor ? {actorName: actor} : {}});
    }
    for (const item of this.queue?.queued() || []) {
      if (seen.has(item.threadId)) continue;
      seen.add(item.threadId);
      const actor = this.ledger?.actor(item.opId)?.name;
      tasks.push({service: 'claude', threadId: item.threadId, queued: true, ...actor ? {actorName: actor} : {}});
    }
    return tasks;
  }
  close() {this.closed = true;clearInterval(this.queueTimer);this.runtime.close();this.artifacts?.close();}

  private drainSoon(id: string) {if (!this.closed) this.drain(id).catch(() => {});}
  private queueChanged(id: string) {this.queueVersions.set(id, (this.queueVersions.get(id) || 0) + 1);for (const listener of this.queueListeners) listener(id);}

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
      const {text, images = [], model, effort, permissionMode: mode} = head.payload;
      if (!session) {
        const info = await this.info(id).catch(() => undefined);
        // Wait while the terminal or IDE may be running it; never start a second writer.
        if (!info || (await this.revision(id).catch(() => ({external: true}))).external || queue.queued(id)[0]?.id !== head.id) return;
      }
      queue.sending(head.id);this.queueChanged(id);
      try {
        if (!session || session.closed) {
          const {cwd = ''} = await this.info(id);
          const directory = await projectDirectory(cwd);
          session = await this.runtime.start({cwd: directory, resume: id, ...await this.resumeSettings(id, directory, {model, effort, permissionMode: mode}, session)});
        } else {
          if (guestWorkspace()) await projectDirectory(session.cwd);
          await this.runtime.configure(session, model, mode, effort);
        }
        this.runtime.send(session, text, images, undefined, head.id);
        this.ledger?.recordSender({service: 'claude', threadId: id, opId: head.id, kind: 'text', text});
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
    let sessions = await Promise.all((await (await this.sessions()).listSessions()).filter(info => !info.archived)
      .sort((a, b) => b.lastModified - a.lastModified).map(info => this.withCwd(info)));
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
    const elsewhere = !guestWorkspace() && !live && info !== null;
    // The process holding it (the desktop app, a terminal) reports whether a turn is under way, however long a call takes;
    // without that report, a turn left open in the transcript and logged to just now is the only sign.
    // Another program with the session open, even idle: it keeps its own copy of the conversation and never sees what
    // this connector's processes add, so the phone is told.
    const holder = !guestWorkspace() && info !== null ? (await this.peerStatuses()).get(id) : undefined;
    const peer = elsewhere ? holder : undefined;
    const external = elsewhere && (peer ? peer.status !== 'idle' : await this.writtenElsewhere(id, path, info!));
    const marker = live ? live.version : external ? peer?.status || 'external' : '-';
    return {revision: `${info?.mtimeNs ?? ''}:${info?.size ?? ''}:${marker}:${this.queueVersions.get(id) || 0}:${holder?.pid ?? ''}`, external,
      peer: external ? peer : undefined, holder, exists: Boolean(info)};
  }

  /**
   * The only sign of a terminal or IDE at work when no process reports holding the session: its transcript shows a turn
   * left open and logged to just now. A write alone is not enough: titles, modes, costs, renames and archiving are written
   * by many hands, a turn's end among them; and nothing this connector wrote itself (a fork, what its own process saves
   * on its way out) counts.
   */
  private async writtenElsewhere(id: string, path: string, file: {mtimeMs: bigint | number; mtimeNs?: bigint; size: bigint | number}) {
    const now = this.now(), mtimeMs = Number(file.mtimeMs), own = this.ownUntil.get(id);
    if (now - mtimeMs >= ACTIVE_MS || (own !== undefined && mtimeMs <= own + RELEASE_SLACK_MS)) return false;
    const version = `${file.mtimeNs ?? mtimeMs}:${file.size}`;
    let cached = this.exchanges.get(path);
    if (cached?.version !== version) {
      cached = {version, value: lastExchange(path).catch(() => null)};
      this.exchanges.delete(path);this.exchanges.set(path, cached);
      if (this.exchanges.size > 64) this.exchanges.delete(this.exchanges.keys().next().value!);
    }
    const last = await cached.value;
    // Unreadable, or no step near the end: the write is the only sign left.
    if (last === null) return true;
    return last !== undefined && last.open && now - last.at < ACTIVE_MS;
  }

  /** As in {@link writtenElsewhere}, for a session listed by its last-modified time. */
  private async listedElsewhere(info: SessionInfo) {
    if (this.now() - info.lastModified >= ACTIVE_MS) return false;
    const path = await this.transcript(info.sessionId).catch(() => '');
    const file = path ? await stat(path, {bigint: true}).catch(() => null) : null;
    return file ? this.writtenElsewhere(info.sessionId, path, file) : false;
  }

  /** Claude Code's own reports of the sessions its processes hold, read at most twice a second. */
  private peerStatuses() {
    if (!this.peers || this.now() - this.peers.at > 500) this.peers = {at: this.now(), value: readPeerStatuses(this.root, undefined, this.runtime.ownEntrypoint).catch(() => new Map())};
    return this.peers.value;
  }

  private raw(id: string) {return this.transcript(id).then(path => readFile(path, 'utf8'), () => '');}

  /**
   * What a resumed session starts with: what the phone chose, else what the session last ran with, so continuing it here
   * never quietly changes its model, effort or permission mode.
   */
  private async resumeSettings(id: string, cwd: string, chosen: ChosenSettings, live?: LiveSession): Promise<ChosenSettings> {
    const current = sessionSettings(live, await this.raw(id));
    return {model: chosen.model || await this.keptModel(current.model, cwd),
      effort: chosen.effort || current.effort || undefined, permissionMode: chosen.permissionMode || current.permissionMode || undefined};
  }

  /**
   * Claude Code resumes on its default model. The session's own model is named only where the default resolves to another
   * one, so a default alias such as "opus[1m]" that resolves to it stays in use.
   */
  private async keptModel(model: string, cwd: string): Promise<string | undefined> {
    if (!model) return undefined;
    const models = await this.runtime.supportedModels(cwd).catch(() => [] as Json[]);
    const fallback = models.find(item => item.id === 'default')?.resolvedModel, base = (value: string) => value.replace(/\[[^\]]*\]$/, '');
    return typeof fallback === 'string' && fallback && base(fallback) !== base(model) ? model : undefined;
  }

  /** The SDK finds no folder when the first prompt's images push it past what it reads; the whole transcript names it. */
  private async withCwd(info: SessionInfo): Promise<SessionInfo> {
    if (info.cwd) return info;
    const cwd = claudeTranscriptCwd(await this.raw(info.sessionId));
    return cwd ? {...info, cwd} : info;
  }

  private async info(id: string) {
    const found = await (await this.sessions()).getSessionInfo(id);
    if (!found) throw new BridgeError('missing', '这台电脑上找不到这条 Claude Code 会话');
    const info = await this.withCwd(found);
    return guestWorkspace() ? {...info, cwd: await projectDirectory(info.cwd || '')} : info;
  }

  /** The SDK's messages since the latest compaction, preceded by what came before it. `earlier`: how many of them are from before. */
  private withEarlier(id: string, messages: ClaudeMessage[], raw: string) {
    const boundary = messages[0]?.type === 'system' ? messages[0].uuid : '';
    if (!boundary) return {all: messages, earlier: 0};
    let saved = this.compacted.get(id);
    if (saved?.boundary !== boundary) {
      saved = {boundary, messages: claudeEarlierMessages(raw, messages)};
      this.compacted.delete(id);
      this.compacted.set(id, saved);
      if (this.compacted.size > 8) this.compacted.delete(this.compacted.keys().next().value!);
    }
    return {all: saved.messages.length ? [...saved.messages, ...messages] : messages, earlier: saved.messages.length};
  }

  private async read(id: string, known?: string, window: ReadWindow = {}): Promise<Json> {
    let current = await step('revision', () => this.revision(id));
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
    const {head, turns} = await this.state(id, current);
    const recent = [];
    let budget = MAX_FRAME - 1024 * 1024;
    const anchor = window.from ? turns.findIndex(turn => turn.id === window.from) : -1;
    const start = Math.max(0, Math.min(turns.length - MAX_TURNS, anchor < 0 ? Infinity : anchor) - (window.earlier || 0));
    for (const turn of turns.slice(start).reverse()) {
      budget -= Buffer.byteLength(JSON.stringify(turn)) + 1;
      if (budget < 0) break;
      recent.push(turn);
    }
    if (turns.length && !recent.length) throw new BridgeError('too_large', 'Claude Code 最新一轮过长，请在电脑上查看');
    return {...head, revision: current.revision, turns: recent.reverse(), truncated: recent.length < turns.length};
  }

  /**
   * Everything the phone sees of a session, with all its turns. Built again only when the session's revision moved, so
   * reads and subscriptions at the same revision share it, and its turns are the same objects (src/connector/thread-hub.ts).
   */
  private state(id: string, current: Revision): Promise<{head: Json; turns: TurnView[]}> {
    const cached = this.states.get(id);
    if (cached?.revision === current.revision) return cached.value;
    const value = this.build(id, current);
    this.states.delete(id);this.states.set(id, {revision: current.revision, value});
    if (this.states.size > 8) this.states.delete(this.states.keys().next().value!);
    value.catch(() => {if (this.states.get(id)?.value === value) this.states.delete(id);});
    return value;
  }

  private async build(id: string, current: Revision): Promise<{head: Json; turns: TurnView[]}> {
    const live = this.runtime.get(id);
    const sessions = await this.sessions();
    // Right after a session starts its transcript can exist before the SDK can describe it; a live session just shows no messages yet.
    if (live && guestWorkspace()) await projectDirectory(live.cwd);
    const readMessages = () => sessions.getSessionMessages(id, {includeSystemMessages: true});
    const [info, messages] = await step('messages', async () => !current.exists ? [undefined, []] :
      guestWorkspace() && !live ? [await this.info(id), await readMessages()] :
      await Promise.all([live ? sessions.getSessionInfo(id) : this.info(id), readMessages()]));
    // A session this connector runs reports its real state; others are judged by recent transcript writes.
    const external = !live && current.external;
    const running = live ? live.running : external;
    // Edits keep their diffs only in the raw transcript; read it alongside the SDK's messages.
    const raw = current.exists ? await step('raw', () => this.raw(id)) : '';
    // The SDK starts at the latest compaction; the transcript still holds what came before, which the phone can scroll back to.
    const {all, earlier} = stepSync('earlier', () => this.withEarlier(id, messages, raw));
    const before = new Set(all.slice(0, earlier).map(entry => entry.uuid));
    const patches = stepSync('patches', () => claudePatches(raw, info?.cwd || live?.cwd || '')), titles = stepSync('titles', () => claudeArtifactTitles(raw));
    const turns = stepSync('turns', () => claudeTurns(all, running, patches, titles, uuid => entryTimestamp(raw, uuid)));
    // Messages sent from the phone carry their sender, matched by the exact text the connector sent.
    const records = this.ledger?.senders('claude', id) || [];
    // Edits and forks resume from the SDK's branch, which starts at the latest compaction.
    if (before.size) for (const turn of turns) if (turn.anchor && before.has(turn.anchor)) turn.canFork = false;
    if (records.length) {
      const senders = sendersByText(all.flatMap(entry => {const text = claudeUserText(entry);return text === undefined || !entry.uuid ? [] : [{id: entry.uuid, text}];}), records);
      for (const turn of turns) for (const item of turn.items) {const sender = senders.get(item.id);if (sender) item.sender = sender;}
    }
    await this.nameSavedPages(turns);
    // Offered only while the turn it follows is still the latest, wherever the session went on since.
    const latest = turns.at(-1)?.id || '';
    if (live?.suggestion) this.suggestions.set(id, {text: live.suggestion, turn: latest});
    else if (live?.running) this.suggestions.delete(id);
    const guess = this.suggestions.get(id), suggestion = !running && guess?.turn === latest ? guess.text : '';
    const usage = (messages.findLast(entry => entry.type === 'assistant' && (entry.message as Json | undefined)?.usage)?.message as Json | undefined)?.usage;
    const usedTokens = usage ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0) : 0;
    const contextUsage = usedTokens ? {usedTokens, windowTokens: live ? await this.runtime.contextWindow(live) : null} : null;
    const settings = sessionSettings(live, raw);
    const head = {
      id, title: info ? title(info) : '新会话', cwd: info?.cwd || live?.cwd || '', model: settings.model, effort: settings.effort, running,
      controlled: Boolean(live), external, permissionMode: settings.permissionMode,
      // 'busy' or 'waiting' as the process holding it reports; 'recent' when only recent transcript writes suggest it.
      externalStatus: external ? current.peer?.status || 'recent' : '', ...(current.peer?.waitingFor ? {waitingFor: current.peer.waitingFor} : {}),
      // The program that has the session open on the computer; what the phone adds runs in another process it never shows.
      ...(current.holder ? {heldBy: {app: holderName(current.holder.entrypoint), pid: current.holder.pid}} : {}),
      defaultPermissionMode: this.runtime.defaultMode, canBypass: Boolean(live?.canBypass), requests: live?.pending || [], error: live?.error || '',
      queuedMessages: (this.queue?.queued(id) || []).map(message => ({id: message.id, text: message.payload.text || '',
        imageCount: message.payload.images?.length || 0, imageBytes: (message.payload.images || []).reduce((sum: number, url: string) => sum + imageBytes(url), 0),
        state: message.state, error: message.error})),
      contextUsage, suggestion,
      notice: !external ? current.holder ? heldNotice(holderName(current.holder.entrypoint)) : ''
        : current.peer?.status === 'waiting' ? `电脑上的 Claude Code 正在等待电脑上的操作${current.peer.waitingFor ? `（${current.peer.waitingFor}）` : ''}。`
        : current.peer && this.queue ? `${holderName(current.peer.entrypoint)}正在运行这条会话。手机发送的消息会排队，等那边这一轮结束后发送；${holderName(current.peer.entrypoint)}不会显示这些消息。`
        : '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后，才能在手机上继续。',
    };
    return {head, turns};
  }

  /**
   * The running turn with the text block Claude is writing now (LiveSession.streaming) added after what the transcript
   * holds, until the transcript has it too or a few seconds after its message ended.
   */
  private withStreaming(id: string, turns: TurnView[]): TurnView[] {
    const streaming = this.runtime.get(id)?.streaming, last = turns.at(-1);
    if (!streaming?.text.trim() || !last || last.status !== 'inProgress') return turns;
    if (streaming.done && Date.now() - streaming.at > STREAM_SETTLE_MS) return turns;
    const tail = streaming.text.trim().slice(-60);
    if (last.items.some(item => item.role === 'assistant' && item.text.includes(tail))) return turns;
    const item = {id: `stream:${streaming.message}:${streaming.block}`, type: 'agentMessage', role: 'assistant', text: streaming.text};
    return [...turns.slice(0, -1), {...last, items: [...last.items, item]}];
  }

  /** What the subscription hub (src/connector/thread-hub.ts) follows: a session's turns, pushed as they change. */
  readonly syncSource: ThreadSource = {
    // Words being written change only the streaming part, not the revision the session is read again at.
    version: async id => `${(await this.revision(id)).revision}:${this.runtime.get(id)?.streamVersion ?? 0}`,
    state: async id => {const {head, turns} = await this.state(id, await this.revision(id));return {head, entries: this.withStreaming(id, turns)};},
    watch: poke => {
      this.runtime.on('stream', (id: string) => {if (id) poke(id);});
      this.runtime.on('change', (id: string) => {if (id) poke(id);});
      this.queueListeners.push(poke);
    },
  };

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
  /** The message text Claude receives: with links to the files uploaded into the project. */
  private async attach(scope: string, text: string, files: FileAttachment[]) {
    if (!files.length) return text;
    if (!this.ledger) throw new BridgeError('unavailable', '连接器未启用操作记录');
    return withAttachmentLinks(this.ledger, scope, text, files);
  }

  /** Registers a folder so empty Claude Code projects appear immediately before their first session. */
  async registerProject(_opId: string, input: {name: string; path: string; initClaudeMd?: string}): Promise<{project: {id: string; name: string; path: string}}> {
    const path = await projectDirectory(input.path);
    const name = textRequired(input.name, '项目名称', 80);
    this.ledger?.registerClaudeProject(path, name);
    if (typeof input.initClaudeMd === 'string' && input.initClaudeMd.trim()) {
      const rootMd = join(path, 'CLAUDE.md'), nestedMd = join(path, '.claude', 'CLAUDE.md');
      const hasMd = await stat(rootMd).then(s => s.isFile(), () => false) || await stat(nestedMd).then(s => s.isFile(), () => false);
      if (!hasMd) {
        const text = instructionsInput(input.initClaudeMd);
        if (text) await writeFile(rootMd, text.endsWith('\n') ? text : text + '\n', {encoding: 'utf8', flag: 'wx'}).catch(() => {});
      }
    }
    this.catalog = undefined;
    return {project: {id: path, name, path}};
  }

  /** Renames a Claude Code project in the connector's registry (folder and sessions remain untouched). */
  async updateProject(input: {id?: string; path?: string; name: string}): Promise<{project: {id: string; name: string; path: string}}> {
    if (guestWorkspace()) throw new BridgeError('unsupported', '借用电脑暂不支持修改项目');
    const rawPath = (typeof input.path === 'string' && input.path.trim()) || (typeof input.id === 'string' && input.id.trim()) || '';
    const path = await projectDirectory(textRequired(rawPath, '项目目录', 4096));
    const name = textRequired(input.name, '项目名称', 80);
    this.ledger?.registerClaudeProject(path, name);
    this.catalog = undefined;
    return {project: {id: path, name, path}};
  }

  /** Removes/hides a Claude Code project from the sidebar list (folder and sessions remain untouched). */
  async removeProject(input: {id?: string; path?: string}): Promise<{removed: true; notice?: string}> {
    if (guestWorkspace()) throw new BridgeError('unsupported', '借用电脑暂不支持移除项目');
    const rawPath = (typeof input.path === 'string' && input.path.trim()) || (typeof input.id === 'string' && input.id.trim()) || '';
    const path = textRequired(rawPath, '项目目录', 4096);
    this.ledger?.removeClaudeProject(path);
    this.catalog = undefined;
    return {removed: true, notice: '已从 Claude Code 项目列表移除（文件夹与会话均已保留）'};
  }

  private async listedProjects(sessionPaths: string[]): Promise<{id: string; path: string; name?: string}[]> {
    if (guestWorkspace()) {
      return (await workspaceProjects(sessionPaths)).map(item => ({...item, id: item.path}));
    }
    const hidden = this.ledger?.hiddenProjects('claude') || new Set<string>();
    const registered = this.ledger?.claudeProjects() || [];
    const alive: {id: string; path: string; name?: string}[] = [];
    const seen = new Set<string>();
    for (const item of registered) {
      const key = projectPathKey(item.path);
      if (hidden.has(key)) continue;
      const ok = await stat(item.path).then(info => info.isDirectory(), () => false);
      if (!ok) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      alive.push({id: item.path, path: item.path, ...(item.name ? {name: item.name} : {})});
    }
    for (const path of sessionPaths) {
      const key = projectPathKey(path);
      if (hidden.has(key) || seen.has(key)) continue;
      seen.add(key);
      alive.push({id: path, path});
    }
    return alive;
  }

  async handle(action: string, p: Json): Promise<Json> {
    if (action === 'claude.list') {
      const offset = Number.isSafeInteger(p.offset) && p.offset >= 0 ? p.offset : 0;
      // Projects are folders, as in Claude Code itself: sessions are grouped by their working directory.
      const requested = p.project ? textRequired(p.project, '项目', 4096) : '';
      const project = requested && guestWorkspace() ? await projectDirectory(requested) : requested;
      const search = p.search ? textRequired(p.search, '搜索内容', 200).toLowerCase() : '';
      const all = await this.all(p.refresh === true && !offset);
      const matches = all.filter(info => (!project || (info.cwd && projectPathKey(info.cwd) === projectPathKey(project))) && (!search || title(info).toLowerCase().includes(search)));
      const page = matches.slice(offset, offset + PAGE);
      const paths = [...new Set(all.map(info => info.cwd).filter((cwd): cwd is string => Boolean(cwd)))];
      const projects = !offset && !search ? await this.listedProjects(paths) : undefined;
      const peers = guestWorkspace() ? new Map<string, PeerStatus>() : await this.peerStatuses();
      const elsewhere = async (info: SessionInfo) => {const peer = peers.get(info.sessionId);return peer ? peer.status !== 'idle' : !guestWorkspace() && await this.listedElsewhere(info);};
      const data = await Promise.all(page.map(async info => ({id: info.sessionId, title: title(info), cwd: info.cwd || '', updatedAt: info.lastModified,
        running: this.runtime.get(info.sessionId)?.running ?? await elsewhere(info)})));
      return {data, hasMore: matches.length > offset + PAGE, projects,
        defaultPermissionMode: this.runtime.defaultMode};
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
      const input = message(p), model = optionalModel(p.model), effort = optionalEffort(p.effort), mode = permissionMode(p.permissionMode);
      const files = input.files.length ? {files: attachmentIds(input.files)} : {};
      return this.mutate(p, {action, cwd, text: input.text, images: fingerprint(input.images), ...files, model, ...(effort ? {effort} : {}), mode}, async () => {
        const text = await this.attach(newScope(cwd), input.text, input.files);
        const session = await this.runtime.start({cwd, model, effort, permissionMode: mode});
        this.runtime.send(session, text, input.images, undefined, p.opId);
        const conversationId = await this.runtime.waitForId(session);
        this.ledger?.recordSender({service: 'claude', threadId: conversationId, opId: p.opId, kind: 'text', text});
        return {conversationId};
      });
    }
    if (action === 'claude.file.uploadStart' || action === 'claude.file.uploadChunk') {
      if (!this.ledger) throw new BridgeError('unavailable', '连接器未启用操作记录');
      const stage = action === 'claude.file.uploadChunk' ? 'chunk' : 'start';
      // Before a conversation exists, its files belong to the project it will start in.
      if (p.conversationId === undefined) {
        const cwd = await projectDirectory(textRequired(p.cwd, '项目目录', 4096));
        return scopedUpload(this.ledger, stage, newScope(cwd), async () => cwd, p);
      }
      const id = textRequired(p.conversationId, '会话', 36);
      if (!sessionId.test(id)) throw new BridgeError('invalid', 'Claude Code 会话 ID 无效');
      return scopedUpload(this.ledger, stage, sessionScope(id), async () => projectDirectory((await this.info(id)).cwd || ''), p);
    }
    const id = textRequired(p.conversationId, '会话', 36);
    if (!sessionId.test(id)) throw new BridgeError('invalid', 'Claude Code 会话 ID 无效');
    if (action === 'claude.read') return this.read(id, undefined, readWindow(p));
    if (action === 'claude.watch') return this.read(id, textRequired(p.revision, '会话版本', 200), readWindow(p));
    if (action === 'claude.file.read' || action === 'claude.file.download') {
      const path = textRequired(p.path, '文件路径', 4096);
      if (/^[\\/]{2}/.test(path)) throw new BridgeError('invalid', '请选择本机文件');
      const {cwd = ''} = await this.info(id);
      return action === 'claude.file.read' ? readProjectFile(cwd, path)
        : p.stream === true ? openProjectDownload(cwd, path, textRequired(p.revision, '文件版本', 64), p.range) as unknown as Promise<Json>
        : downloadProjectFile(cwd, path, textRequired(p.revision, '文件版本', 64), p.offset);
    }
    if (action === 'claude.send') {
      const input = message(p), model = optionalModel(p.model), effort = optionalEffort(p.effort), mode = permissionMode(p.permissionMode), delivery = sendMode(p.mode);
      const files = input.files.length ? {files: attachmentIds(input.files)} : {};
      return this.mutate(p, {action, id, text: input.text, images: fingerprint(input.images), ...files, model, ...(effort ? {effort} : {}), mode, delivery, confirmIdle: p.confirmIdle === true}, async () => {
        if (this.sending.has(id)) throw new BridgeError('busy', '这条会话已有一条消息正在提交，请稍后再试');
        this.sending.add(id);
        try {
          const text = await this.attach(sessionScope(id), input.text, input.files);
          let session = this.runtime.get(id);
          // Behind a running turn (here, or one the desktop app or a terminal reports under way), or behind messages already
          // waiting, a plain send waits its turn on this computer. Recent writes alone are a guess, which the phone confirms instead.
          const behind = session ? session.running || session.requests.size > 0 : delivery === 'queue' && Boolean(this.queue) && Boolean((await this.revision(id)).peer);
          if (delivery === 'queue' && this.queue && (behind || this.queue.queued(id).length)) {
            await this.info(id);
            this.queue.enqueue(textRequired(p.opId, '操作标识', 100), id, {text, images: input.images, model, ...(effort ? {effort} : {}), permissionMode: mode});
            this.queueChanged(id);
            return {conversationId: id, kind: 'queued'};
          }
          if (!session) {
            const {cwd = ''} = await this.info(id);
            const directory = await projectDirectory(cwd);
            if ((await this.revision(id)).external && p.confirmIdle !== true)
              throw new BridgeError('active', '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后再继续。');
            session = await this.runtime.start({cwd: directory, resume: id, ...await this.resumeSettings(id, directory, {model, effort, permissionMode: mode})});
          } else {
            if (guestWorkspace()) await projectDirectory(session.cwd);
            await this.runtime.configure(session, model, mode, effort);
          }
          const running = session.running;
          this.runtime.send(session, text, input.images, delivery === 'steer' ? 'next' : delivery === 'now' ? 'now' : undefined, p.opId);
          this.ledger?.recordSender({service: 'claude', threadId: id, opId: p.opId, kind: 'text', text});
          return {submitted: true, kind: running ? delivery === 'now' ? 'sent_now' : 'steer_accepted' : 'turn_accepted'};
        } finally {this.sending.delete(id);}
      });
    }
    if (action === 'claude.steerQueued' || action === 'claude.withdrawQueued' || action === 'claude.cancelQueued') {
      const queuedId = textRequired(p.queuedId, '排队消息', 100), queue = this.queue;
      // A queued message joins the running turn ('steer') or interrupts its reply ('now').
      const delivery = action === 'claude.steerQueued' ? sendMode(p.mode ?? 'steer') : undefined;
      if (delivery === 'queue') throw new BridgeError('invalid', '发送方式无效');
      return this.mutate(p, {action, id, queuedId, ...(delivery === 'now' ? {delivery} : {})}, async () => {
        if (!queue) throw new BridgeError('unavailable', '连接器未启用操作记录');
        if (action !== 'claude.steerQueued') {
          const message = queue.cancelQueued(id, queuedId);
          this.queueChanged(id);
          return action === 'claude.withdrawQueued'
            ? {queuedId, kind: 'queue_withdrawn', message: {text: message.text || '', images: message.images || [], model: message.model, effort: message.effort, permissionMode: message.permissionMode}}
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
          if (guestWorkspace()) await projectDirectory(session.cwd);
          queue.sending(queuedId);
          try {this.runtime.send(session, message.payload.text, message.payload.images || [], delivery === 'now' ? 'now' : 'next');this.ledger?.recordSender({service: 'claude', threadId: id, opId: queuedId, kind: 'text', text: message.payload.text || ''});}
          catch (error) {
            const failure = error instanceof BridgeError ? error : new BridgeError('unexpected', '追加结果待核实，不会自动重发', true);
            queue.finishQueued(queuedId, {}, failure);throw failure;
          }
          const kind = delivery === 'now' ? 'sent_now' : 'steer_accepted';
          queue.finishQueued(queuedId, {conversationId: id, submitted: true, kind});
          return {queuedId, kind};
        } finally {this.sending.delete(id);this.queueChanged(id);}
      });
    }
    if (action === 'claude.edit') {
      // Codex-style edit: the session continues from the turn before this message; it and everything after are dropped.
      const turnId = textRequired(p.turnId, '消息', 100), input = message(p), model = optionalModel(p.model), effort = optionalEffort(p.effort), mode = permissionMode(p.permissionMode);
      return this.mutate(p, {action, id, turnId, text: input.text, images: fingerprint(input.images), model, ...(effort ? {effort} : {}), mode, confirmIdle: p.confirmIdle === true}, async () => {
        if (this.sending.has(id)) throw new BridgeError('busy', '这条会话已有一条消息正在提交，请稍后再试');
        this.sending.add(id);
        try {
          const {cwd = ''} = await this.info(id);
          const messages = await (await this.sessions()).getSessionMessages(id, {includeSystemMessages: true});
          const turns = claudeTurns(messages);
          const index = turns.findIndex(turn => turn.id === turnId);
          if (index < 0 && this.withEarlier(id, messages, await this.raw(id)).all.some(entry => entry.uuid === turnId))
            throw new BridgeError('invalid', '整理上下文之前的消息不能改写。可以改写之后的消息，或在会话菜单里“复制会话”');
          if (index < 0 || turns[index].items[0]?.role !== 'user') throw new BridgeError('changed', '找不到这条消息，请刷新会话后重试');
          const anchor = turns[index - 1]?.anchor;
          if (!anchor) throw new BridgeError('invalid', '第一条消息不能改写。可以在会话菜单里“复制会话”，或新建会话');
          const live = this.runtime.get(id);
          if (!live && (await this.revision(id)).external && p.confirmIdle !== true)
            throw new BridgeError('active', '电脑上的 Claude Code 可能正在运行这条会话。确认那边已结束后再继续。');
          // Read before the running session closes: it knows what it runs with.
          const directory = await projectDirectory(cwd), kept = await this.resumeSettings(id, directory, {model, effort, permissionMode: mode}, live);
          if (live) await this.runtime.shutdown(live);
          const session = await this.runtime.start({cwd: directory, resume: id, resumeAt: anchor, ...kept});
          this.runtime.send(session, input.text, input.images, undefined, p.opId);
          this.ledger?.recordSender({service: 'claude', threadId: id, opId: p.opId, kind: 'text', text: input.text});
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
        // The new transcript was just written here, not by a terminal running it.
        this.ownUntil.set(forked, this.now());
        this.catalog = undefined;
        return {conversationId: forked};
      });
    }
    if (action === 'claude.rename') {
      const name = textRequired(p.title, '会话名称', 200);
      return this.mutate(p, {action, id, name}, async () => {
        await this.info(id);
        await (await this.sessions()).renameSession(id, name);
        this.catalog = undefined;
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
      const mode = permissionMode(p.mode);
      const response: ClaudeResponse = {decision, answers, message: typeof p.message === 'string' ? p.message : undefined, ...(mode ? {mode} : {})};
      return this.mutate(p, {action, id, requestId, response}, async () => {
        if (!session) throw new BridgeError('expired', '这条会话已不在手机控制下，请刷新');
        await this.runtime.respond(session, requestId, response);
        return {responded: true};
      });
    }
    throw new BridgeError('unsupported', '这个连接器版本暂不支持此 Claude Code 操作');
  }
}
