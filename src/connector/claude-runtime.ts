import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, join} from 'node:path';
import type {Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import {BridgeError, type Json} from '../shared/types.js';
import type {ClaudeBaseline} from './usage-meter.js';

export type QueryFn = (params: {prompt: AsyncIterable<SDKUserMessage>; options?: Options}) => Query;
// 'auto' is the desktop app's mode in which a classifier approves each call; a session it ran in keeps it here.
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type ClaudeQuestion = {question: string; header: string; multiSelect: boolean; options: {label: string; description: string}[]};
/** What the phone sees for a pending approval; never includes the resolver or raw permission suggestions. */
export type ClaudeRequestView = {
  id: string; kind: 'permission' | 'question' | 'plan'; tool: string; title: string; detail: string;
  canRemember: boolean; questions?: ClaudeQuestion[];
  /** Where "remember" saves the rule, so the phone can name it: this session, this project or every project. */
  rememberScope?: 'session' | 'project' | 'user';
  /** A plan: the modes it can be carried out in, the suggested one first. Older connectors leave it out. */
  implementModes?: PermissionMode[];
};
/** `mode`: the mode an approved plan is carried out in; one of the request's `implementModes`. */
export type ClaudeResponse = {decision: 'allow' | 'allowSession' | 'deny'; answers?: Record<string, string>; message?: string; mode?: PermissionMode};

/**
 * The modes a plan can be carried out in, as Claude Code's own plan prompt offers them: accepting edits
 * (suggested) or approving each one, plus the hands-off mode the session ran in before it began planning.
 */
export function implementModes(before: PermissionMode | undefined, canBypass: boolean): PermissionMode[] {
  const modes: PermissionMode[] = ['acceptEdits', 'default'];
  if (before === 'auto' || (before === 'bypassPermissions' && canBypass)) modes.push(before);
  return modes;
}

/** The broadest place the suggested permission updates would be written. */
function rememberScope(suggestions: PermissionUpdate[] | undefined): ClaudeRequestView['rememberScope'] {
  if (!suggestions?.length) return undefined;
  const places = suggestions.map(update => update.destination);
  return places.includes('userSettings') ? 'user' : places.some(place => place === 'projectSettings' || place === 'localSettings') ? 'project' : 'session';
}

type Pending = {view: ClaudeRequestView; input: Record<string, unknown>; suggestions?: PermissionUpdate[]; resolve: (result: PermissionResult) => void};

/** Finds the user's Claude Code so the connector does not depend on the SDK's bundled binary. */
export function findClaude(env: NodeJS.ProcessEnv = process.env, exists = existsSync, platform = process.platform): string | undefined {
  if (env.CLAUDE_CODE_BIN) return env.CLAUDE_CODE_BIN;
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  const home = env.USERPROFILE || env.HOME || homedir();
  const candidates = [...(env.PATH || '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean).map(dir => join(dir, name)), join(home, '.local', 'bin', name)];
  return candidates.find(path => exists(path));
}

/**
 * The entrypoint phone sessions are recorded with. The terminal's `claude --resume` list hides
 * `sdk-*` sessions (the SDK's default `sdk-ts`, and `cli`, which claude.exe rewrites to `sdk-cli`
 * in SDK mode). A name claude.exe does not know is kept as is, listed, and changes no behaviour,
 * unlike borrowing `claude-desktop` or `claude-vscode`.
 */
export const DEFAULT_ENTRYPOINT = 'codex-mobile-web';

/**
 * Variables a parent Claude Code session sets for its own children. A connector started from inside
 * a Claude Code session (the desktop app, a terminal) inherits them, and its sessions would then be
 * recorded as that host's child sessions with its entrypoint.
 */
const HOST_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS', 'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION'];

/** Environment for the Claude Code process: the connector's own, without a parent session's markers. */
export function claudeEnv(entrypoint = DEFAULT_ENTRYPOINT, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {...base};
  for (const name of HOST_SESSION_VARS) delete env[name];
  env.CLAUDE_CODE_ENTRYPOINT = entrypoint || DEFAULT_ENTRYPOINT;
  return env;
}

/** An async queue the SDK reads user messages from, so one Claude Code process serves many turns. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting?: (value: IteratorResult<SDKUserMessage>) => void;
  closed = false;
  push(message: SDKUserMessage) {
    if (this.closed) throw new BridgeError('offline', 'Claude Code 会话已结束，请重新发送');
    if (this.waiting) {const resolve = this.waiting;this.waiting = undefined;resolve({value: message, done: false});}
    else this.items.push(message);
  }
  close() {this.closed = true;this.waiting?.({value: undefined, done: true});this.waiting = undefined;}
  get size() {return this.items.length;}
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {next: () => {
      const item = this.items.shift();
      if (item) return Promise.resolve({value: item, done: false});
      if (this.closed) return Promise.resolve({value: undefined, done: true});
      return new Promise(resolve => {this.waiting = resolve;});
    }};
  }
}

export class LiveSession {
  id = '';
  version = 0;
  running = false;
  error = '';
  requests = new Map<string, Pending>();
  idleTimer?: NodeJS.Timeout;
  closed = false;
  interrupting = false;
  hint = '';
  /** Claude Code's guess at the user's next prompt, after the latest turn; '' once another turn starts. */
  suggestion = '';
  /** Context window size, read once from Claude Code. */
  window?: number | null;
  /** Started with permission to skip prompts, so it can switch into "bypassPermissions" later. */
  canBypass = false;
  /** The mode the session left when the phone switched it to planning, offered again when the plan is approved. */
  beforePlan?: PermissionMode;
  /** The operation that started the running turn, so its tokens go to whoever sent it. */
  turnOpId?: string;
  /** A 'now' message that may end the running turn and start its own; it starts the next turn when it does. */
  nowOpId?: string;
  /** Where this session's running token total starts; see recordClaudeTurn. */
  usageBaseline: ClaudeBaseline = 'zero';
  /** The effort the phone chose, or what Claude Code reports; '' while it runs at the model's own default. */
  effort: ClaudeEffort | '' = '';
  constructor(public cwd: string, public query: Query, public inbox: Inbox, public model: string, public permissionMode: PermissionMode) {}
  get pending() {return [...this.requests.values()].map(request => request.view);}
}

const str = (value: unknown) => typeof value === 'string' ? value : '';
function inputSummary(tool: string, input: Record<string, unknown>) {
  if (typeof input.command === 'string') return input.command;
  const path = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (path) return path;
  if (typeof input.url === 'string') return input.url;
  const text = JSON.stringify(input, null, 2);
  return text.length > 2000 ? text.slice(0, 2000) + '\n…' : text || tool;
}
function questions(input: Record<string, unknown>): ClaudeQuestion[] | undefined {
  if (!Array.isArray(input.questions)) return undefined;
  const list = input.questions.flatMap((item: any) => typeof item?.question === 'string' && Array.isArray(item.options) ? [{
    question: item.question, header: str(item.header), multiSelect: item.multiSelect === true,
    options: item.options.flatMap((option: any) => typeof option?.label === 'string' ? [{label: option.label, description: str(option.description)}] : []),
  }] : []);
  return list.length ? list : undefined;
}

export function userMessage(text: string, images: string[], priority?: 'now' | 'next' | 'later'): SDKUserMessage {
  const content: any[] = images.map(url => {
    const [, mediaType, data] = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(url) || [];
    return {type: 'image', source: {type: 'base64', media_type: mediaType, data}};
  });
  if (text) content.push({type: 'text', text});
  return {type: 'user', message: {role: 'user', content}, parent_tool_use_id: null, origin: {kind: 'human'}, ...(priority ? {priority} : {})} as SDKUserMessage;
}

/**
 * Runs Claude Code sessions for the phone through the Agent SDK. One process per controlled session;
 * it is released after a quiet period so the terminal or IDE can resume the same session.
 */
export class ClaudeRuntime extends EventEmitter {
  private live = new Map<string, LiveSession>();
  private models?: {at: number; list: Json[]};
  constructor(private load: () => Promise<QueryFn>, private executable = () => findClaude(), private idleMs = 5 * 60_000,
    private entrypoint = DEFAULT_ENTRYPOINT,
    /** The mode a session runs in when the phone does not choose one. */
    readonly defaultMode: PermissionMode = 'default') {super();}

  /** The entrypoint this connector's own Claude Code processes are recorded with. */
  get ownEntrypoint() {return this.entrypoint || DEFAULT_ENTRYPOINT;}
  get(id: string) {return this.live.get(id);}
  get busy() {return [...this.live.values()].some(session => session.running || session.requests.size || session.inbox.size);}

  private touch(session: LiveSession) {
    session.version++;
    clearTimeout(session.idleTimer);
    if (!session.running && !session.requests.size && !session.inbox.size && !session.closed) {
      session.idleTimer = setTimeout(() => this.release(session), this.idleMs);
      session.idleTimer.unref?.();
    }
    this.emit('change', session.id);
  }

  /** Project settings (CLAUDE.md, .mcp.json, .claude/settings.json, memory) come from the folder, as in the terminal. */
  /** `resumeAt`: continue from this transcript entry, dropping what came after it (an edited message). */
  async start(options: {cwd: string; resume?: string; resumeAt?: string; model?: string; effort?: ClaudeEffort; permissionMode?: PermissionMode}): Promise<LiveSession> {
    if (options.resume) {const existing = this.live.get(options.resume);if (existing) return existing;}
    const query = await this.load();
    const inbox = new Inbox();
    const mode = options.permissionMode || this.defaultMode;
    // With skipping as the default, every session may switch into it (and back) while it runs.
    const canBypass = mode === 'bypassPermissions' || this.defaultMode === 'bypassPermissions';
    let session!: LiveSession;
    const executable = this.executable();
    const hint = executable ? '' : '没有找到电脑上的 claude 程序；请安装 Claude Code，或在连接器配置中设置 claudeBin。';
    let q: Query;
    try {q = query({prompt: inbox, options: {
      cwd: options.cwd, ...(options.resume ? {resume: options.resume} : {}), ...(options.resume && options.resumeAt ? {resumeSessionAt: options.resumeAt} : {}), ...(options.model ? {model: options.model} : {}),
      ...(options.effort ? {effort: options.effort} : {}),
      permissionMode: mode, ...(canBypass ? {allowDangerouslySkipPermissions: true} : {}),
      ...(executable ? {pathToClaudeCodeExecutable: executable} : {}),
      env: claudeEnv(this.entrypoint),
      systemPrompt: {type: 'preset', preset: 'claude_code'},
      canUseTool: (tool, input, context) => this.ask(session, tool, input, context),
      // After each turn Claude Code predicts the user's next prompt, offered in the composer as Claude Code's own input does.
      promptSuggestions: true,
      stderr: () => {}, // Native diagnostics can contain credentials; never forward them.
    }});} catch (error) {
      throw new BridgeError('unavailable', `Claude Code 无法启动：${(error as Error)?.message || '未知错误'}${hint ? '。' + hint : ''}`);
    }
    session = new LiveSession(options.cwd, q, inbox, options.model || '', mode);session.canBypass = canBypass;
    session.effort = options.effort || '';
    session.hint = hint;
    if (options.resume) {session.id = options.resume;this.live.set(options.resume, session);}
    // Resuming from an earlier message drops later turns, so the saved total no longer applies.
    session.usageBaseline = options.resume ? options.resumeAt ? 'unknown' : 'cursor' : 'zero';
    void this.consume(session);
    return session;
  }

  /** Resolves once Claude Code reports the session ID of a newly created session. */
  waitForId(session: LiveSession, timeout = 35_000): Promise<string> {
    if (session.id) return Promise.resolve(session.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {cleanup();reject(new BridgeError('timeout', 'Claude Code 启动超时，请在电脑核实', true));}, timeout);
      const done = () => {
        if (session.id) {cleanup();resolve(session.id);}
        else if (session.closed) {cleanup();reject(new BridgeError('runtime_error', session.error || 'Claude Code 未能启动，请检查电脑上的安装和登录'));}
      };
      const cleanup = () => {clearTimeout(timer);this.off('change', done);this.off('closed', done);};
      this.on('change', done);this.on('closed', done);
      done();
    });
  }

  private async consume(session: LiveSession) {
    try {
      for await (const message of session.query as AsyncIterable<SDKMessage>) {
        if (session.closed) break;
        const m = message as Json;
        if (m.session_id && !session.id) {session.id = m.session_id;this.live.set(session.id, session);}
        if (m.type === 'system' && m.subtype === 'init') {
          if (typeof m.model === 'string') session.model = m.model;
          if (CLAUDE_EFFORTS.includes(m.effort)) session.effort = m.effort;
          if (PERMISSION_MODES.includes(m.permissionMode)) session.permissionMode = m.permissionMode;
        } else if (m.type === 'system' && m.subtype === 'session_state_changed') {
          session.running = m.state !== 'idle' || session.inbox.size > 0;
        } else if (m.type === 'result') {
          // Each result ends a turn; 'turn' listeners record its tokens against the sender of the turn.
          const opId = session.turnOpId;session.turnOpId = session.nowOpId;session.nowOpId = undefined;
          if (session.id) {try {this.emit('turn', session, m, opId);} catch { /* Usage records never stop the session. */ }}
          session.usageBaseline = 'cursor';
          session.running = session.inbox.size > 0;
          session.error = m.subtype === 'success' || session.interrupting ? '' : (Array.isArray(m.errors) ? m.errors.join('\n') : '') || 'Claude Code 本轮出错';
          session.interrupting = false;
        } else if (m.type === 'assistant' || m.type === 'user' || m.type === 'stream_event') {
          session.running = true;
        } else if (m.type === 'prompt_suggestion' && typeof m.suggestion === 'string') {
          // It follows the turn's result; a turn started since makes it stale.
          if (session.running) continue;
          session.suggestion = m.suggestion.trim().slice(0, 1000);
        } else continue;
        this.touch(session);
      }
    } catch (error) {
      session.error = `Claude Code 已退出${(error as Error)?.message ? '：' + (error as Error).message.slice(0, 500) : ''}${session.hint ? '。' + session.hint : ''}`;
    } finally {
      this.closeSession(session);
    }
  }

  private closeSession(session: LiveSession) {
    if (session.closed) return;
    session.closed = true;session.running = false;
    clearTimeout(session.idleTimer);
    for (const request of session.requests.values()) request.resolve({behavior: 'deny', message: 'Claude Code 会话已结束'});
    session.requests.clear();
    session.inbox.close();
    if (session.id && this.live.get(session.id) === session) this.live.delete(session.id);
    session.version++;
    this.emit('change', session.id);this.emit('closed', session.id);
  }

  /** Ends the process so another client (terminal, IDE) may resume the session. */
  /** Ends an idle session's process now, so it can be started again from an earlier point. */
  async shutdown(session: LiveSession) {
    if (session.running || session.requests.size || session.inbox.size) throw new BridgeError('active', 'Claude Code 正在处理这条会话，请等它结束');
    session.inbox.close();
    try {session.query.close();} catch {}
    this.closeSession(session);
  }

  /** Context window use of a session this connector runs, as Claude Code reports it. */
  async contextWindow(session: LiveSession): Promise<number | null> {
    if (session.closed) return null;
    if (session.window !== undefined) return session.window;
    try {
      const usage = await Promise.race([session.query.getContextUsage(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]);
      session.window = Number(usage.maxTokens) || null;
    } catch {session.window = null;}
    return session.window;
  }

  release(session: LiveSession) {
    if (session.running || session.requests.size || session.inbox.size) return;
    session.inbox.close();
    setTimeout(() => {if (!session.closed) {try {session.query.close();} catch {}this.closeSession(session);}}, 10_000).unref?.();
  }

  private ask(session: LiveSession, tool: string, input: Record<string, unknown>, context: {signal: AbortSignal; suggestions?: PermissionUpdate[]; title?: string; description?: string; displayName?: string; decisionReason?: string}): Promise<PermissionResult> {
    if (session.closed || context.signal.aborted) return Promise.resolve({behavior: 'deny', message: '已取消'});
    const id = randomUUID();
    const asked = tool === 'AskUserQuestion' ? questions(input) : undefined;
    const kind: ClaudeRequestView['kind'] = asked ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission';
    const view: ClaudeRequestView = {
      id, kind, tool,
      title: kind === 'question' ? 'Claude 有问题要问你' : kind === 'plan' ? 'Claude 已完成计划，是否开始执行？' : context.title || `Claude 想使用 ${context.displayName || tool}`,
      detail: kind === 'plan' ? str(input.plan) : kind === 'question' ? '' : [context.description, inputSummary(tool, input), context.decisionReason].filter(Boolean).join('\n\n'),
      canRemember: kind === 'permission' && Boolean(context.suggestions?.length), ...(asked ? {questions: asked} : {}),
      ...(kind === 'permission' && context.suggestions?.length ? {rememberScope: rememberScope(context.suggestions)} : {}),
      ...(kind === 'plan' ? {implementModes: implementModes(session.beforePlan, session.canBypass)} : {}),
    };
    return new Promise(resolve => {
      const finish = (result: PermissionResult) => {
        if (!session.requests.delete(id)) return;
        context.signal.removeEventListener('abort', aborted);
        resolve(result);this.touch(session);
      };
      const aborted = () => finish({behavior: 'deny', message: '已取消'});
      session.requests.set(id, {view, input, suggestions: context.suggestions, resolve: finish});
      context.signal.addEventListener('abort', aborted, {once: true});
      this.touch(session);
    });
  }

  async respond(session: LiveSession, requestId: string, response: ClaudeResponse) {
    const request = session.requests.get(requestId);
    if (!request) throw new BridgeError('expired', '该请求已经处理或失效，请刷新');
    if (response.decision === 'deny') {
      request.resolve({behavior: 'deny', message: response.message?.slice(0, 2000) || '用户在手机上拒绝了这项操作'});
      return;
    }
    if (request.view.kind === 'question') {
      const answers: Record<string, string> = {};
      for (const question of request.view.questions || []) {
        const answer = response.answers?.[question.question];
        if (typeof answer !== 'string' || !answer.trim()) throw new BridgeError('invalid', '请回答全部问题');
        answers[question.question] = answer.slice(0, 2000);
      }
      request.resolve({behavior: 'allow', updatedInput: {...request.input, answers}});
      return;
    }
    const mode = request.view.kind === 'plan' ? response.mode : undefined;
    if (mode) {
      if (!request.view.implementModes?.includes(mode)) throw new BridgeError('invalid', '无法按这个模式执行计划');
      // Set before the plan is released, as Claude Code's own prompt does, so its first step already runs in the mode.
      await session.query.setPermissionMode(mode);
      session.permissionMode = mode;session.beforePlan = undefined;
      if (!session.requests.has(requestId)) return;
      request.resolve({behavior: 'allow', updatedInput: request.input, updatedPermissions: [{type: 'setMode', mode, destination: 'session'}]});
      return;
    }
    request.resolve({behavior: 'allow', updatedInput: request.input,
      ...(response.decision === 'allowSession' && request.suggestions?.length ? {updatedPermissions: request.suggestions} : {})});
  }

  /**
   * `priority` applies only while a turn runs: 'next' joins it once its current tool calls finish, 'now' moves
   * movable work to the background (or interrupts) and joins at once, 'later' waits for the turn to end.
   */
  send(session: LiveSession, text: string, images: string[], priority?: 'now' | 'next' | 'later', opId?: string) {
    if (!session.running && opId) session.turnOpId = opId;
    else if (session.running && priority === 'now' && opId) session.nowOpId = opId;
    session.inbox.push(userMessage(text, images, session.running ? priority : undefined));
    session.running = true;session.error = '';session.suggestion = '';
    this.touch(session);
  }

  async interrupt(session: LiveSession) {
    if (!session.running) throw new BridgeError('changed', '当前没有正在运行的任务');
    session.interrupting = true;
    try {await session.query.interrupt();}
    catch (error) {session.interrupting = false;throw error;}
  }

  async configure(session: LiveSession, model?: string, permissionMode?: PermissionMode, effort?: ClaudeEffort) {
    if (session.inbox.closed) throw new BridgeError('offline', 'Claude Code 会话正在释放，请稍后重试');
    if (permissionMode === 'bypassPermissions' && permissionMode !== session.permissionMode && !session.canBypass)
      throw new BridgeError('invalid', '“跳过权限确认”只能在新建或重新接入会话时选择');
    if (model && model !== session.model) {await session.query.setModel(model);session.model = model;}
    // After the model, so the level is judged against the model it will run on.
    if (effort && effort !== session.effort) {await session.query.applyFlagSettings({effortLevel: effort});session.effort = effort;}
    if (permissionMode &&permissionMode !== session.permissionMode) {
      await session.query.setPermissionMode(permissionMode);
      if (permissionMode === 'plan') session.beforePlan = session.permissionMode;
      session.permissionMode = permissionMode;
    }
  }

  /** Model choices from Claude Code itself; uses a running session or a short-lived idle process. */
  async supportedModels(cwd: string): Promise<Json[]> {
    if (this.models && Date.now() - this.models.at < 10 * 60_000) return this.models.list;
    const running = [...this.live.values()].find(session => !session.closed);
    let probe: Query | undefined, inbox: Inbox | undefined;
    try {
      let source = running?.query;
      if (!source) {
        inbox = new Inbox();
        const executable = this.executable();
        probe = (await this.load())({prompt: inbox, options: {cwd, env: claudeEnv(this.entrypoint), ...(executable ? {pathToClaudeCodeExecutable: executable} : {}), stderr: () => {}}});
        source = probe;
      }
      const list = (await source.supportedModels()).map(model => ({id: model.value, label: model.displayName, description: model.description,
        // Sessions report the full model ID; the list offers aliases such as "opus".
        ...(model.resolvedModel ? {resolvedModel: model.resolvedModel} : {}),
        efforts: model.supportsEffort ? (model.supportedEffortLevels || []).filter(level => CLAUDE_EFFORTS.includes(level)) : []}));
      this.models = {at: Date.now(), list};
      return list;
    } catch (error) {
      throw error instanceof BridgeError ? error : new BridgeError('unavailable', '无法读取 Claude Code 的模型列表，请检查电脑上的安装和登录');
    } finally {inbox?.close();try {probe?.close();} catch {}}
  }

  /**
   * Starts Claude Code briefly so it renews an expired claude.ai login itself, as it does before
   * any request; dictation then reads the renewed login. Nothing is sent to a model.
   */
  async renewLogin(cwd = homedir()): Promise<void> {
    const inbox = new Inbox(), executable = this.executable();
    let probe: Query | undefined, timer: NodeJS.Timeout | undefined;
    try {
      probe = (await this.load())({prompt: inbox, options: {cwd, env: claudeEnv(this.entrypoint), ...(executable ? {pathToClaudeCodeExecutable: executable} : {}), stderr: () => {}}});
      await Promise.race([probe.supportedModels(), new Promise(resolve => {timer = setTimeout(resolve, 20_000);})]);
    } finally {clearTimeout(timer);inbox.close();try {probe?.close();} catch {}}
  }

  close() {for (const session of [...this.live.values()]) {try {session.query.close();} catch {}this.closeSession(session);}}
}
