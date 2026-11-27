import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {
  isSessionAutonomy,
  isSessionWaitUntil,
  type SessionAutonomy,
  type SessionBackgroundTaskView,
  type SessionPhase,
  type SessionSendResult,
  type SessionStartResult,
  type SessionTurnMessage,
  type SessionWaitBaseline,
  type SessionWaitResult,
  type SessionWaitUntil,
  type UnifiedSessionSnapshot,
  type UnifiedSessionSummary,
} from '../shared/sessions.js';
import {projectPathKey} from '../shared/project-paths.js';
import {
  BridgeError,
  bridgeServices,
  textRequired,
  type AntigravityMessage,
  type AntigravityPermissionMode,
  type ApprovalRequest,
  type BridgeService,
  type Json,
  type TurnView,
} from '../shared/types.js';
import {type AntigravityBridge, deterministicProjectUuid, toAntigravityFileUri} from './antigravity.js';
import type {ClaudeCodeBridge} from './claude-code.js';
import type {PermissionMode as ClaudePermissionMode} from './claude-runtime.js';
import type {Control} from './control.js';
import {assertSafeProjectPath, type SafetyOptions} from './workspace.js';

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const MAX_WAIT_TIMEOUT_MS = 2 * 3600_000;
const DEFAULT_DISPATCH_GRACE_MS = 8_000;
const DEFAULT_WAIT_POLL_MS = 350;
const BASELINE_TTL_MS = 60_000;

export function freshOpId(now = Date.now()): string {
  return `${String(now).padStart(13, '0')}:${randomUUID()}`;
}

export function deriveSubOpId(opId: string, tag: string, now = Date.now()): string {
  const prefix = /^\d{13}:/.test(opId) ? opId.slice(0, 13) : String(now).padStart(13, '0');
  return `${prefix}:${deterministicProjectUuid(`${opId}:${tag}`)}`;
}

function resolveOpId(raw: unknown, now = Date.now()): string {
  if (typeof raw === 'string' && /^\d{13}:[0-9a-f-]{36}$/i.test(raw.trim())) return raw.trim();
  return freshOpId(now);
}

function unwrapLedgerResult(res: Json): Json {
  if (res && (res.state === 'failed' || res.state === 'uncertain') && res.error) {
    throw new BridgeError(
      String(res.error.code || 'computer_error'),
      String(res.error.message || '操作未获确认'),
      res.state === 'uncertain',
    );
  }
  return res;
}

function isBridgeService(value: unknown): value is BridgeService {
  return typeof value === 'string' && (bridgeServices as readonly string[]).includes(value);
}

function parseAutonomy(value: unknown, fallback?: SessionAutonomy): SessionAutonomy | undefined {
  if (value === undefined || value === null || value === '') return fallback;
  if (!isSessionAutonomy(value)) {
    throw new BridgeError('invalid', '权限档位无效（可选：turbo、auto、default、review）');
  }
  return value;
}

function parseSendMode(value: unknown): 'queue' | 'steer' | 'now' {
  if (value === undefined || value === null || value === '') return 'queue';
  if (value === 'queue' || value === 'steer' || value === 'now') return value;
  throw new BridgeError('invalid', '发送方式无效（可选：queue、steer、now）');
}

export function autonomyToAntigravity(autonomy: SessionAutonomy): AntigravityPermissionMode {
  switch (autonomy) {
    case 'turbo': return 'AGENT_PERMISSION_PRESET_TURBO';
    case 'auto': return 'AGENT_PERMISSION_PRESET_AUTO';
    case 'review': return 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW';
    case 'default': return 'AGENT_PERMISSION_PRESET_DEFAULT';
  }
}

function antigravityToAutonomy(mode: unknown): SessionAutonomy | undefined {
  switch (mode) {
    case 'AGENT_PERMISSION_PRESET_TURBO': return 'turbo';
    case 'AGENT_PERMISSION_PRESET_AUTO': return 'auto';
    case 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW': return 'review';
    case 'AGENT_PERMISSION_PRESET_DEFAULT': return 'default';
    default: return undefined;
  }
}

export function autonomyToClaude(autonomy: SessionAutonomy): ClaudePermissionMode | undefined {
  switch (autonomy) {
    case 'turbo': return 'bypassPermissions';
    case 'auto': return 'auto';
    case 'review': return 'default';
    case 'default': return undefined;
  }
}

function claudeToAutonomy(mode: unknown): SessionAutonomy | undefined {
  switch (mode) {
    case 'bypassPermissions': return 'turbo';
    case 'auto':
    case 'acceptEdits': return 'auto';
    case 'default':
    case 'plan': return 'review';
    default: return undefined;
  }
}

export function autonomyToCodex(autonomy: SessionAutonomy): 'never' | 'on-request' | undefined {
  switch (autonomy) {
    case 'turbo':
    case 'auto': return 'never';
    case 'review': return 'on-request';
    case 'default': return undefined;
  }
}

function codexToAutonomy(policy: unknown): SessionAutonomy | undefined {
  if (policy === 'never') return 'turbo';
  if (policy === 'on-request') return 'review';
  return undefined;
}

async function ensureExistingSafeCwd(rawCwd: string, safety?: SafetyOptions): Promise<string> {
  const canonical = await assertSafeProjectPath(rawCwd, safety);
  const info = await stat(canonical).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new BridgeError('invalid', `项目目录不存在或不是文件夹：${rawCwd}`);
  }
  return canonical;
}

function flattenTurns(turns: TurnView[]): {
  recentMessages: SessionTurnMessage[];
  lastUserMessage?: string;
  lastAssistantReply?: string;
} {
  const all: SessionTurnMessage[] = [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if ((item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && item.text.trim()) {
        all.push({id: item.id, role: item.role, text: item.text});
      }
    }
  }
  const lastTurn = turns.at(-1);
  let lastUserMessage: string | undefined;
  let lastAssistantReply: string | undefined;
  if (lastTurn) {
    for (const item of lastTurn.items || []) {
      if (item.role === 'user' && item.text?.trim()) lastUserMessage = item.text;
      if (item.role === 'assistant' && item.text?.trim()) lastAssistantReply = item.text;
    }
  }
  return {
    recentMessages: all.slice(-12),
    ...(lastUserMessage ? {lastUserMessage} : {}),
    ...(lastAssistantReply ? {lastAssistantReply} : {}),
  };
}

function baselineOfSnapshot(snapshot: UnifiedSessionSnapshot, now = Date.now()): SessionWaitBaseline {
  const users = snapshot.recentMessages.filter(m => m.role === 'user');
  const assistants = snapshot.recentMessages.filter(m => m.role === 'assistant');
  return {
    userCount: users.length,
    ...(users.at(-1)?.id ? {lastUserId: users.at(-1)!.id} : {}),
    ...(assistants.at(-1)?.id ? {lastAssistantId: assistants.at(-1)!.id} : {}),
    startedAt: now,
  };
}

export interface SessionDriver {
  readonly service: BridgeService;
  list(opts: {cwd?: string; search?: string; limit: number}): Promise<UnifiedSessionSummary[]>;
  get(sessionId: string): Promise<UnifiedSessionSnapshot>;
  start(opId: string, input: {
    cwd: string;
    prompt: string;
    model?: string;
    effort?: string;
    autonomy: SessionAutonomy;
  }): Promise<{sessionId: string; cwd: string; projectCreated?: boolean; submitted: boolean; uncertain?: boolean}>;
  send(opId: string, input: {
    sessionId: string;
    prompt: string;
    mode: 'queue' | 'steer' | 'now';
    model?: string;
    effort?: string;
    autonomy?: SessionAutonomy;
  }): Promise<{kind: 'turn_accepted' | 'queued' | 'steer_accepted' | 'sent_now'}>;
  respond(opId: string, input: {
    sessionId: string;
    requestId: string;
    decision: 'allow' | 'allowSession' | 'deny';
    answers?: Record<string, string>;
  }): Promise<void>;
  stop(opId: string, input: {sessionId: string; killBackgroundTasks?: boolean}): Promise<void>;
  watch?(listener: (sessionId: string) => void): void;
  refresh?(sessionId: string): void;
}

export class AntigravitySessionDriver implements SessionDriver {
  readonly service = 'antigravity' as const;
  constructor(
    private readonly bridge: AntigravityBridge,
    private readonly safety?: SafetyOptions,
  ) {}

  watch(listener: (sessionId: string) => void) {
    this.bridge.syncSource.watch?.(listener);
  }

  refresh(sessionId: string) {
    this.bridge.syncSource.refresh?.(sessionId);
  }

  async list(opts: {cwd?: string; search?: string; limit: number}): Promise<UnifiedSessionSummary[]> {
    const canonicalCwd = opts.cwd ? await ensureExistingSafeCwd(opts.cwd, this.safety).catch(() => opts.cwd!) : undefined;
    const projectUri = canonicalCwd ? toAntigravityFileUri(canonicalCwd) : undefined;
    const res = await this.bridge.handle('antigravity.list', {
      ...(projectUri ? {project: projectUri} : {}),
      ...(opts.search ? {search: opts.search} : {}),
      offset: 0,
    });
    const rows: Json[] = Array.isArray(res?.data) ? res.data : [];
    return rows.slice(0, opts.limit).map(row => ({
      service: 'antigravity' as const,
      sessionId: String(row.id),
      title: String(row.title || '未命名对话'),
      cwd: canonicalCwd || '',
      running: Boolean(row.running),
      ...(row.background !== undefined ? {background: row.background} : {}),
      updatedAt: Number(row.updatedAt) || 0,
    }));
  }

  async get(sessionId: string): Promise<UnifiedSessionSnapshot> {
    const view = await this.bridge.handle('antigravity.read', {conversationId: sessionId});
    const awaitingDispatch = this.bridge.isTurnAwaitingDispatch(sessionId);
    const rawMessages: AntigravityMessage[] = Array.isArray(view.messages) ? view.messages : [];
    const conversational: SessionTurnMessage[] = rawMessages
      .filter((m): m is AntigravityMessage & {role: 'user' | 'assistant'} =>
        (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && Boolean(m.text.trim()))
      .map(m => ({id: String(m.id), role: m.role, text: m.text}));

    let lastUserIdx = -1;
    for (let i = conversational.length - 1; i >= 0; i--) {
      if (conversational[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    const lastUserMessage = lastUserIdx >= 0 ? conversational[lastUserIdx].text : undefined;
    let lastAssistantReply: string | undefined;
    if (!awaitingDispatch || lastUserIdx <= 0) {
      for (let i = conversational.length - 1; i > lastUserIdx; i--) {
        if (conversational[i].role === 'assistant') {
          lastAssistantReply = conversational[i].text;
          break;
        }
      }
    }

    const requests: ApprovalRequest[] = Array.isArray(view.requests) ? view.requests : [];
    const backgroundTasks: SessionBackgroundTaskView[] = (Array.isArray(view.backgroundTasks) ? view.backgroundTasks : []).map((t: Json) => ({
      id: String(t.id),
      title: String(t.title || '后台任务'),
      ...(typeof t.command === 'string' && t.command ? {command: t.command} : {}),
      ...(typeof t.cwd === 'string' && t.cwd ? {cwd: t.cwd} : {}),
      ...(typeof t.output === 'string' && t.output ? {output: t.output} : {}),
    }));
    const queued: Json[] = Array.isArray(view.queuedMessages) ? view.queuedMessages : [];
    const queueSending = queued.some(q => q?.state === 'sending');
    const queueError = queued.find(q => q?.state === 'failed' || q?.state === 'uncertain')?.error;
    const issueError = view.issue?.kind === 'error'
      ? ([view.issue.message, view.issue.detail].filter(Boolean).join(' — ') || 'Antigravity 执行出错')
      : undefined;
    const error = issueError || (typeof queueError === 'string' && queueError ? queueError : undefined);

    const running = Boolean(view.running || awaitingDispatch || queueSending);
    let phase: SessionPhase;
    if (view.canceling) phase = 'canceling';
    else if (requests.length > 0) phase = 'waiting_approval';
    else if (running) phase = 'running';
    else if (error) phase = 'error';
    else if (backgroundTasks.length > 0 || view.notIdle) phase = 'background_running';
    else phase = 'idle';

    const autonomy = antigravityToAutonomy(view.permissionMode ?? view.defaultPermissionMode);
    return {
      service: 'antigravity',
      sessionId,
      title: String(view.title || '未命名对话'),
      cwd: String(view.cwd || ''),
      phase,
      running,
      canSend: Boolean(view.canSend) && !awaitingDispatch,
      ...(autonomy ? {autonomy} : {}),
      ...(lastUserMessage ? {lastUserMessage} : {}),
      ...(lastAssistantReply ? {lastAssistantReply} : {}),
      recentMessages: conversational.slice(-12),
      requests,
      backgroundTasks,
      queuedCount: queued.length,
      ...(error ? {error} : {}),
    };
  }

  async start(opId: string, input: {
    cwd: string;
    prompt: string;
    model?: string;
    effort?: string;
    autonomy: SessionAutonomy;
  }) {
    const cwd = await ensureExistingSafeCwd(input.cwd, this.safety);
    const ensured = await this.bridge.ensureProject(deriveSubOpId(opId, 'ag-project'), cwd);
    const raw = unwrapLedgerResult(await this.bridge.handle('antigravity.create', {
      opId,
      project: ensured.uri,
      ...(ensured.projectId ? {projectId: ensured.projectId} : {}),
      text: input.prompt,
      ...(input.model ? {model: input.model} : {}),
      permissionMode: autonomyToAntigravity(input.autonomy),
    }));
    const sessionId = textRequired(raw.conversationId, 'Antigravity 会话 ID', 64);
    return {
      sessionId,
      cwd,
      ...(ensured.created ? {projectCreated: true} : {}),
      submitted: raw.submitted !== false,
      ...(raw.uncertain ? {uncertain: true} : {}),
    };
  }

  async send(opId: string, input: {
    sessionId: string;
    prompt: string;
    mode: 'queue' | 'steer' | 'now';
    model?: string;
    effort?: string;
    autonomy?: SessionAutonomy;
  }) {
    const current = await this.bridge.handle('antigravity.read', {conversationId: input.sessionId});
    const payload: Json = {
      opId,
      conversationId: input.sessionId,
      text: input.prompt,
      mode: input.mode,
      ...(input.mode === 'queue' && current.canSend && typeof current.turn === 'string' ? {turn: current.turn} : {}),
      ...(input.model ? {model: input.model} : {}),
      ...(input.autonomy ? {permissionMode: autonomyToAntigravity(input.autonomy)} : {}),
    };
    const raw = unwrapLedgerResult(await this.bridge.handle('antigravity.send', payload));
    const kind = (raw.kind === 'queued' || raw.kind === 'steer_accepted' || raw.kind === 'sent_now')
      ? raw.kind
      : 'turn_accepted';
    return {kind};
  }

  async respond(opId: string, input: {
    sessionId: string;
    requestId: string;
    decision: 'allow' | 'allowSession' | 'deny';
    answers?: Record<string, string>;
  }) {
    unwrapLedgerResult(await this.bridge.handle('antigravity.respond', {
      opId,
      conversationId: input.sessionId,
      requestId: input.requestId,
      decision: input.decision,
      ...(input.answers ? {answers: input.answers} : {}),
    }));
  }

  async stop(opId: string, input: {sessionId: string; killBackgroundTasks?: boolean}) {
    const current = await this.bridge.handle('antigravity.read', {conversationId: input.sessionId});
    unwrapLedgerResult(await this.bridge.handle('antigravity.stop', {
      opId,
      conversationId: input.sessionId,
      turn: current.turn,
      ...(input.killBackgroundTasks ? {killBackgroundTasks: true} : {}),
    }));
  }
}

export class ClaudeSessionDriver implements SessionDriver {
  readonly service = 'claude' as const;
  constructor(
    private readonly bridge: ClaudeCodeBridge,
    private readonly safety?: SafetyOptions,
  ) {}

  watch(listener: (sessionId: string) => void) {
    this.bridge.syncSource.watch?.(listener);
  }

  async list(opts: {cwd?: string; search?: string; limit: number}): Promise<UnifiedSessionSummary[]> {
    const canonicalCwd = opts.cwd ? await ensureExistingSafeCwd(opts.cwd, this.safety).catch(() => opts.cwd!) : undefined;
    const res = await this.bridge.handle('claude.list', {
      ...(canonicalCwd ? {project: canonicalCwd} : {}),
      ...(opts.search ? {search: opts.search} : {}),
      offset: 0,
    });
    const rows: Json[] = Array.isArray(res?.data) ? res.data : [];
    return rows.slice(0, opts.limit).map(row => ({
      service: 'claude' as const,
      sessionId: String(row.id),
      title: String(row.title || '未命名会话'),
      cwd: String(row.cwd || canonicalCwd || ''),
      running: Boolean(row.running),
      ...(row.background ? {background: row.background} : {}),
      updatedAt: Number(row.updatedAt) || 0,
    }));
  }

  async get(sessionId: string): Promise<UnifiedSessionSnapshot> {
    const view = await this.bridge.handle('claude.read', {conversationId: sessionId});
    const turns: TurnView[] = Array.isArray(view.turns) ? view.turns : [];
    const {recentMessages, lastUserMessage, lastAssistantReply} = flattenTurns(turns);
    const requests: ApprovalRequest[] = Array.isArray(view.requests) ? view.requests : [];
    const backgroundTasks: SessionBackgroundTaskView[] = (Array.isArray(view.backgroundTasks) ? view.backgroundTasks : []).map((t: Json) => ({
      id: String(t.id),
      title: String(t.title || '后台任务'),
    }));
    const queued: Json[] = Array.isArray(view.queuedMessages) ? view.queuedMessages : [];
    const queueSending = queued.some(q => q?.state === 'sending');
    const lastTurn = turns.at(-1);
    const error = (typeof view.error === 'string' && view.error)
      || (lastTurn?.status === 'failed' ? (lastTurn.error || 'Claude Code 执行失败') : undefined);
    const running = Boolean(view.running || queueSending);

    let phase: SessionPhase;
    if (requests.length > 0) phase = 'waiting_approval';
    else if (running) phase = 'running';
    else if (error) phase = 'error';
    else if (backgroundTasks.length > 0) phase = 'background_running';
    else phase = 'idle';

    const autonomy = claudeToAutonomy(view.permissionMode || view.defaultPermissionMode);
    return {
      service: 'claude',
      sessionId,
      title: String(view.title || '新会话'),
      cwd: String(view.cwd || ''),
      phase,
      running,
      canSend: !running && requests.length === 0,
      ...(autonomy ? {autonomy} : {}),
      ...(typeof view.model === 'string' && view.model ? {model: view.model} : {}),
      ...(lastUserMessage ? {lastUserMessage} : {}),
      ...(lastAssistantReply ? {lastAssistantReply} : {}),
      recentMessages,
      requests,
      backgroundTasks,
      queuedCount: queued.length,
      ...(error ? {error} : {}),
      ...(typeof view.notice === 'string' && view.notice ? {notice: view.notice} : {}),
    };
  }

  async start(opId: string, input: {
    cwd: string;
    prompt: string;
    model?: string;
    effort?: string;
    autonomy: SessionAutonomy;
  }) {
    const cwd = await ensureExistingSafeCwd(input.cwd, this.safety);
    const permissionMode = autonomyToClaude(input.autonomy);
    const raw = unwrapLedgerResult(await this.bridge.handle('claude.create', {
      opId,
      cwd,
      text: input.prompt,
      ...(input.model ? {model: input.model} : {}),
      ...(input.effort ? {effort: input.effort} : {}),
      ...(permissionMode ? {permissionMode} : {}),
    }));
    const sessionId = textRequired(raw.conversationId, 'Claude Code 会话 ID', 64);
    return {sessionId, cwd, submitted: true};
  }

  async send(opId: string, input: {
    sessionId: string;
    prompt: string;
    mode: 'queue' | 'steer' | 'now';
    model?: string;
    effort?: string;
    autonomy?: SessionAutonomy;
  }) {
    const permissionMode = input.autonomy ? autonomyToClaude(input.autonomy) : undefined;
    const raw = unwrapLedgerResult(await this.bridge.handle('claude.send', {
      opId,
      conversationId: input.sessionId,
      text: input.prompt,
      mode: input.mode,
      confirmIdle: true,
      ...(input.model ? {model: input.model} : {}),
      ...(input.effort ? {effort: input.effort} : {}),
      ...(permissionMode ? {permissionMode} : {}),
    }));
    const kind = (raw.kind === 'queued' || raw.kind === 'steer_accepted' || raw.kind === 'sent_now')
      ? raw.kind
      : 'turn_accepted';
    return {kind};
  }

  async respond(opId: string, input: {
    sessionId: string;
    requestId: string;
    decision: 'allow' | 'allowSession' | 'deny';
    answers?: Record<string, string>;
  }) {
    unwrapLedgerResult(await this.bridge.handle('claude.respond', {
      opId,
      conversationId: input.sessionId,
      requestId: input.requestId,
      decision: input.decision,
      ...(input.answers ? {answers: input.answers} : {}),
    }));
  }

  async stop(opId: string, input: {sessionId: string}) {
    unwrapLedgerResult(await this.bridge.handle('claude.stop', {
      opId,
      conversationId: input.sessionId,
    }));
  }
}

function normalizeCodexRequests(rawRequests: Json[]): ApprovalRequest[] {
  const list: ApprovalRequest[] = [];
  for (const req of rawRequests) {
    if (!req || typeof req !== 'object') continue;
    const id = String(req.id ?? '');
    if (!id) continue;
    if (req.method === 'item/commandExecution/requestApproval') {
      const cmd = Array.isArray(req.params?.command) ? req.params.command.join(' ') : String(req.params?.command || '');
      list.push({
        id,
        kind: 'permission',
        tool: 'command',
        title: '允许运行命令',
        detail: cmd,
        canRemember: true,
        rememberScope: 'session',
      });
    } else if (req.method === 'item/fileChange/requestApproval') {
      list.push({
        id,
        kind: 'permission',
        tool: 'fileChange',
        title: '允许修改文件',
        detail: String(req.params?.reason || ''),
        canRemember: true,
        rememberScope: 'session',
      });
    } else if (req.method === 'item/permissions/requestApproval') {
      list.push({
        id,
        kind: 'permission',
        tool: 'permissions',
        title: '需要权限确认',
        detail: JSON.stringify(req.params?.permissions || {}),
        canRemember: true,
        rememberScope: 'session',
      });
    } else if (req.method === 'item/tool/requestUserInput') {
      const questions: Json[] = Array.isArray(req.params?.questions) ? req.params.questions : [];
      list.push({
        id,
        kind: 'question',
        tool: 'requestUserInput',
        title: 'Codex 需要你的回答',
        detail: '',
        canRemember: false,
        questions: questions.map(q => ({
          question: String(q?.question || q?.id || ''),
          header: String(q?.header || q?.id || ''),
          multiSelect: Boolean(q?.multiSelect),
          options: (Array.isArray(q?.options) ? q.options : []).map((opt: Json) => ({
            label: String(opt?.label || opt?.value || ''),
            description: String(opt?.description || ''),
          })),
        })),
      });
    } else {
      list.push({
        id,
        kind: 'notice',
        tool: String(req.method || 'request'),
        title: 'Codex 正在等待确认',
        detail: '',
        canRemember: false,
      });
    }
  }
  return list;
}

function buildCodexApprovalPayload(
  rawReq: Json,
  decision: 'allow' | 'allowSession' | 'deny',
  answers?: Record<string, string>,
): Json {
  if (rawReq.method === 'item/commandExecution/requestApproval' || rawReq.method === 'item/fileChange/requestApproval') {
    const mapped = decision === 'deny' ? 'decline' : decision === 'allowSession' ? 'acceptForSession' : 'accept';
    return {decision: mapped};
  }
  if (rawReq.method === 'item/permissions/requestApproval') {
    return {allow: decision !== 'deny', scope: decision === 'allowSession' ? 'session' : 'turn'};
  }
  if (rawReq.method === 'item/tool/requestUserInput') {
    const formatted: Json = {};
    for (const q of rawReq.params?.questions || []) {
      const key = String(q?.question || q?.id || '');
      const rawAnswer = answers?.[q?.id] ?? answers?.[key] ?? '';
      const values = rawAnswer.split(',').map(part => part.trim()).filter(Boolean);
      formatted[q.id] = {answers: values.length ? values : [rawAnswer || '']};
    }
    return {answers: formatted};
  }
  return {action: decision === 'deny' ? 'decline' : 'accept'};
}

export class CodexSessionDriver implements SessionDriver {
  readonly service = 'codex' as const;
  constructor(
    private readonly control: Control,
    private readonly safety?: SafetyOptions,
  ) {}

  watch(listener: (sessionId: string) => void) {
    this.control.syncSource.watch?.(listener);
  }

  async list(opts: {cwd?: string; search?: string; limit: number}): Promise<UnifiedSessionSummary[]> {
    const canonicalCwd = opts.cwd ? await ensureExistingSafeCwd(opts.cwd, this.safety).catch(() => opts.cwd!) : undefined;
    const res = await this.control.handle({
      id: randomUUID(),
      action: 'sessions.list',
      payload: {
        ...(canonicalCwd ? {cwd: canonicalCwd} : {}),
        ...(opts.search ? {search: opts.search} : {}),
      },
    });
    const rows: Json[] = Array.isArray(res?.data) ? res.data : [];
    const filtered = canonicalCwd
      ? rows.filter(row => row?.cwd && projectPathKey(String(row.cwd)) === projectPathKey(canonicalCwd))
      : rows;
    return filtered.slice(0, opts.limit).map(row => ({
      service: 'codex' as const,
      sessionId: String(row.id),
      title: String(row.title || row.preview || '未命名会话'),
      cwd: String(row.cwd || canonicalCwd || ''),
      running: row.status?.type === 'active',
      updatedAt: (Number(row.updatedAt) || 0) * (Number(row.updatedAt) < 1e12 ? 1000 : 1),
    }));
  }

  async get(sessionId: string): Promise<UnifiedSessionSnapshot> {
    const view = await this.control.read(sessionId, 20);
    const {recentMessages, lastUserMessage, lastAssistantReply} = flattenTurns(view.turns || []);
    const requests = normalizeCodexRequests(view.requests || []);
    const queued = view.queuedMessages || [];
    const queueSending = queued.some(q => q.state === 'sending');
    const lastTurn = view.turns?.at(-1);
    const error = lastTurn?.status === 'failed' ? (lastTurn.error || 'Codex 执行失败') : undefined;
    const running = Boolean(view.running || view.activeTurnId || queueSending);

    let phase: SessionPhase;
    if (requests.length > 0) phase = 'waiting_approval';
    else if (running) phase = 'running';
    else if (error) phase = 'error';
    else phase = 'idle';

    const autonomy = codexToAutonomy(view.approvalPolicy);
    return {
      service: 'codex',
      sessionId: view.id,
      title: String(view.title || '未命名会话'),
      cwd: String(view.cwd || ''),
      phase,
      running,
      canSend: Boolean(view.canControl && !running && requests.length === 0),
      ...(autonomy ? {autonomy} : {}),
      ...(view.model ? {model: view.model} : {}),
      ...(lastUserMessage ? {lastUserMessage} : {}),
      ...(lastAssistantReply ? {lastAssistantReply} : {}),
      recentMessages,
      requests,
      backgroundTasks: [],
      queuedCount: queued.length,
      ...(error ? {error} : {}),
      ...(view.notice ? {notice: view.notice} : {}),
    };
  }

  async start(opId: string, input: {
    cwd: string;
    prompt: string;
    model?: string;
    effort?: string;
    autonomy: SessionAutonomy;
  }) {
    const cwd = await ensureExistingSafeCwd(input.cwd, this.safety);
    const approvalPolicy = autonomyToCodex(input.autonomy);
    const createOpId = deriveSubOpId(opId, 'codex-create');
    const sendOpId = deriveSubOpId(opId, 'codex-send');
    const created = unwrapLedgerResult(await this.control.handle({
      id: randomUUID(),
      action: 'session.create',
      payload: {
        opId: createOpId,
        cwd,
        ...(input.model ? {model: input.model} : {}),
        ...(approvalPolicy ? {approvalPolicy} : {}),
      },
    }));
    const threadId = textRequired(created.threadId, 'Codex 会话 ID', 120);
    unwrapLedgerResult(await this.control.handle({
      id: randomUUID(),
      action: 'turn.send',
      payload: {
        opId: sendOpId,
        threadId,
        source: 'connector',
        generation: created.generation || this.control.generation,
        expectedTurnId: null,
        text: input.prompt,
        ...(input.model ? {model: input.model} : {}),
        ...(input.effort ? {effort: input.effort} : {}),
        ...(approvalPolicy ? {approvalPolicy} : {}),
      },
    }));
    return {sessionId: threadId, cwd, submitted: true};
  }

  async send(opId: string, input: {
    sessionId: string;
    prompt: string;
    mode: 'queue' | 'steer' | 'now';
    model?: string;
    effort?: string;
    autonomy?: SessionAutonomy;
  }) {
    let session = await this.control.read(input.sessionId, 5);
    if (session.source === 'history' && !session.running) {
      unwrapLedgerResult(await this.control.handle({
        id: randomUUID(),
        action: 'session.resume',
        payload: {
          opId: deriveSubOpId(opId, 'codex-resume'),
          threadId: input.sessionId,
          confirmIdle: true,
        },
      }));
      session = await this.control.read(input.sessionId, 5);
    }
    if (input.mode === 'now' && session.activeTurnId) {
      unwrapLedgerResult(await this.control.handle({
        id: randomUUID(),
        action: 'turn.stop',
        payload: {
          opId: deriveSubOpId(opId, 'codex-stop'),
          threadId: input.sessionId,
          source: session.source,
          generation: this.control.generation,
          expectedTurnId: session.activeTurnId,
        },
      }));
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        session = await this.control.read(input.sessionId, 5);
        if (!session.activeTurnId && !session.running) break;
        await delay(100);
      }
    }
    const approvalPolicy = input.autonomy ? autonomyToCodex(input.autonomy) : undefined;
    const effectiveMode = input.mode === 'steer' && session.activeTurnId
      ? 'steer'
      : input.mode === 'queue' && session.activeTurnId
      ? 'queue'
      : undefined;
    const sent = unwrapLedgerResult(await this.control.handle({
      id: randomUUID(),
      action: 'turn.send',
      payload: {
        opId,
        threadId: input.sessionId,
        source: session.source,
        generation: this.control.generation,
        expectedTurnId: effectiveMode === 'queue' ? null : session.activeTurnId,
        text: input.prompt,
        ...(effectiveMode ? {mode: effectiveMode} : {}),
        ...(input.model ? {model: input.model} : {}),
        ...(input.effort ? {effort: input.effort} : {}),
        ...(approvalPolicy && !session.activeTurnId ? {approvalPolicy} : {}),
      },
    }));
    const kind = (sent.kind === 'queued' || sent.kind === 'steer_accepted')
      ? sent.kind
      : input.mode === 'now' ? 'sent_now' : 'turn_accepted';
    return {kind};
  }

  async respond(opId: string, input: {
    sessionId: string;
    requestId: string;
    decision: 'allow' | 'allowSession' | 'deny';
    answers?: Record<string, string>;
  }) {
    const session = await this.control.read(input.sessionId, 5);
    const rawReq = (session.requests || []).find(r => String(r?.id) === input.requestId);
    if (!rawReq) throw new BridgeError('expired', '该确认请求已不存在或已处理');
    const response = buildCodexApprovalPayload(rawReq, input.decision, input.answers);
    unwrapLedgerResult(await this.control.handle({
      id: randomUUID(),
      action: 'request.respond',
      payload: {
        opId,
        threadId: input.sessionId,
        source: session.source,
        generation: this.control.generation,
        requestId: rawReq.id,
        response,
      },
    }));
  }

  async stop(opId: string, input: {sessionId: string}) {
    const session = await this.control.read(input.sessionId, 5);
    if (!session.activeTurnId) return;
    unwrapLedgerResult(await this.control.handle({
      id: randomUUID(),
      action: 'turn.stop',
      payload: {
        opId,
        threadId: input.sessionId,
        source: session.source,
        generation: this.control.generation,
        expectedTurnId: session.activeTurnId,
      },
    }));
  }
}

export interface SessionHubOptions {
  dispatchGraceMs?: number;
  waitPollMs?: number;
  now?: () => number;
}

/**
 * Unified cross-app Session orchestrator (`agent.session.*`).
 * Normalizes project alignment, default `turbo` autonomy, turn cursors, approval payloads,
 * and event-driven turn completion waiting across Antigravity, Claude Code, and Codex.
 */
export class SessionHub {
  private readonly drivers = new Map<BridgeService, SessionDriver>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly baselines = new Map<string, SessionWaitBaseline>();
  private readonly dispatchGraceMs: number;
  private readonly waitPollMs: number;
  private readonly now: () => number;

  constructor(drivers: SessionDriver[] = [], options: SessionHubOptions = {}) {
    this.dispatchGraceMs = options.dispatchGraceMs ?? DEFAULT_DISPATCH_GRACE_MS;
    this.waitPollMs = options.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
    this.now = options.now ?? Date.now;
    for (const driver of drivers) this.register(driver);
  }

  register(driver: SessionDriver) {
    this.drivers.set(driver.service, driver);
    driver.watch?.(sessionId => this.notify(driver.service, sessionId));
  }

  private driver(rawService: unknown): SessionDriver {
    const service = rawService === undefined || rawService === '' ? 'antigravity' : rawService;
    if (!isBridgeService(service)) {
      throw new BridgeError('invalid', '目标应用无效（可选：antigravity、claude、codex）');
    }
    const found = this.drivers.get(service);
    if (!found) {
      throw new BridgeError('unavailable', `当前电脑未启用或未检测到 ${service} 服务`);
    }
    return found;
  }

  private notify(service: BridgeService, sessionId: string) {
    const set = this.waiters.get(`${service}:${sessionId}`);
    if (!set) return;
    for (const wake of set) wake();
  }

  private rememberBaseline(service: BridgeService, sessionId: string, baseline: SessionWaitBaseline) {
    const key = `${service}:${sessionId}`;
    this.baselines.delete(key);
    this.baselines.set(key, baseline);
    const cutoff = this.now() - BASELINE_TTL_MS;
    for (const [k, v] of this.baselines) {
      if (v.startedAt < cutoff) this.baselines.delete(k);
    }
  }

  private consumeBaseline(service: BridgeService, sessionId: string, explicit?: unknown): SessionWaitBaseline | undefined {
    if (explicit && typeof explicit === 'object') {
      const b = explicit as Partial<SessionWaitBaseline>;
      if (typeof b.startedAt === 'number' && Number.isFinite(b.startedAt)) {
        return {
          userCount: Number(b.userCount) || 0,
          ...(typeof b.lastUserId === 'string' ? {lastUserId: b.lastUserId} : {}),
          ...(typeof b.lastAssistantId === 'string' ? {lastAssistantId: b.lastAssistantId} : {}),
          startedAt: b.startedAt,
        };
      }
    }
    const key = `${service}:${sessionId}`;
    const stored = this.baselines.get(key);
    if (!stored) return undefined;
    if (this.now() - stored.startedAt > BASELINE_TTL_MS) {
      this.baselines.delete(key);
      return undefined;
    }
    return stored;
  }

  async waitFor(
    service: BridgeService,
    sessionId: string,
    opts: {until?: SessionWaitUntil; timeoutMs?: number; baseline?: SessionWaitBaseline} = {},
  ): Promise<SessionWaitResult> {
    const driver = this.driver(service);
    const until: SessionWaitUntil = opts.until ?? 'turn_end';
    const timeoutMs = Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(100, Math.floor(Number(opts.timeoutMs) || DEFAULT_WAIT_TIMEOUT_MS)));
    const startAt = this.now();
    const deadline = startAt + timeoutMs;
    const baseline = opts.baseline;
    const key = `${service}:${sessionId}`;
    let sawActive = false;

    const evaluate = (snap: UnifiedSessionSnapshot): SessionWaitResult | null => {
      const elapsedMs = Math.max(0, this.now() - startAt);
      if (snap.phase === 'waiting_approval') {
        this.baselines.delete(key);
        return {stopReason: 'approval_needed', elapsedMs, session: snap};
      }
      if (snap.phase === 'error') {
        this.baselines.delete(key);
        return {stopReason: 'error', elapsedMs, session: snap};
      }
      if (snap.phase === 'running' || snap.phase === 'canceling') {
        sawActive = true;
        return null;
      }
      // Guard against the sub-second dispatch window right after start/send before the target app updates its status/transcript.
      if (baseline && !sawActive && this.now() - baseline.startedAt < this.dispatchGraceMs) {
        const lastAssistantId = snap.recentMessages.filter(m => m.role === 'assistant').at(-1)?.id;
        if (lastAssistantId === baseline.lastAssistantId) {
          return null;
        }
      }
      if (snap.phase === 'background_running') {
        if (until === 'fully_idle') {
          sawActive = true;
          return null;
        }
        this.baselines.delete(key);
        return {stopReason: 'background_running', elapsedMs, session: snap};
      }
      this.baselines.delete(key);
      return {stopReason: 'completed', elapsedMs, session: snap};
    };

    while (true) {
      driver.refresh?.(sessionId);
      const snap = await driver.get(sessionId);
      const settled = evaluate(snap);
      if (settled) return settled;

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return {stopReason: 'timeout', elapsedMs: Math.max(0, this.now() - startAt), session: snap};
      }

      await new Promise<void>(resolveWake => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters.get(key)?.delete(finish);
          if (this.waiters.get(key)?.size === 0) this.waiters.delete(key);
          resolveWake();
        };
        let set = this.waiters.get(key);
        if (!set) {
          set = new Set();
          this.waiters.set(key, set);
        }
        set.add(finish);
        const timer = setTimeout(finish, Math.min(this.waitPollMs, remaining));
        timer.unref?.();
      });
    }
  }

  async handle(action: string, p: Json = {}): Promise<Json> {
    if (action === 'agent.session.list') {
      const limit = Math.min(100, Math.max(1, Math.floor(Number(p.limit) || 25)));
      const cwd = typeof p.cwd === 'string' && p.cwd.trim() ? p.cwd.trim() : undefined;
      const search = typeof p.search === 'string' && p.search.trim() ? p.search.trim() : undefined;
      if (p.service !== undefined && p.service !== '' && p.service !== 'all') {
        const driver = this.driver(p.service);
        const sessions = await driver.list({cwd, search, limit});
        return {sessions, results: {[driver.service]: {ok: true, count: sessions.length}}};
      }
      const results: Record<string, {ok: boolean; count: number; error?: string}> = {};
      const batches = await Promise.all([...this.drivers.values()].map(async drv => {
        try {
          const items = await drv.list({cwd, search, limit});
          results[drv.service] = {ok: true, count: items.length};
          return items;
        } catch (error) {
          results[drv.service] = {ok: false, count: 0, error: (error as Error)?.message || '读取失败'};
          return [] as UnifiedSessionSummary[];
        }
      }));
      const sessions = batches.flat().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
      return {sessions, results};
    }

    if (action === 'agent.session.get') {
      const driver = this.driver(p.service);
      const sessionId = textRequired(p.sessionId, '会话 ID', 120);
      return await driver.get(sessionId) as unknown as Json;
    }

    if (action === 'agent.session.start') {
      const driver = this.driver(p.service);
      const cwd = textRequired(p.cwd, '项目目录', 4096);
      const prompt = textRequired(p.prompt, '任务内容', 100_000);
      const autonomy = parseAutonomy(p.autonomy, 'turbo')!;
      const model = typeof p.model === 'string' && p.model.trim() ? textRequired(p.model, '模型', 200) : undefined;
      const effort = typeof p.effort === 'string' && p.effort.trim() ? textRequired(p.effort, '思考程度', 40) : undefined;
      const opId = resolveOpId(p.opId, this.now());
      const baseline: SessionWaitBaseline = {userCount: 0, startedAt: this.now()};
      const started = await driver.start(opId, {cwd, prompt, model, effort, autonomy});
      this.rememberBaseline(driver.service, started.sessionId, baseline);
      const session = await driver.get(started.sessionId);
      const out: SessionStartResult = {
        service: driver.service,
        sessionId: started.sessionId,
        cwd: started.cwd,
        autonomy,
        ...(started.projectCreated ? {projectCreated: true} : {}),
        submitted: started.submitted,
        ...(started.uncertain ? {uncertain: true} : {}),
        baseline,
        session,
      };
      if (p.wait === true) {
        const until = p.until !== undefined ? (isSessionWaitUntil(p.until) ? p.until : (() => {throw new BridgeError('invalid', '等待条件无效');})()) : 'turn_end';
        const waitResult = await this.waitFor(driver.service, started.sessionId, {until, timeoutMs: p.timeoutMs, baseline});
        out.waitResult = waitResult;
        out.session = waitResult.session;
      }
      return out as unknown as Json;
    }

    if (action === 'agent.session.send') {
      const driver = this.driver(p.service);
      const sessionId = textRequired(p.sessionId, '会话 ID', 120);
      const prompt = textRequired(p.prompt, '消息内容', 100_000);
      const mode = parseSendMode(p.mode);
      const autonomy = parseAutonomy(p.autonomy);
      const model = typeof p.model === 'string' && p.model.trim() ? textRequired(p.model, '模型', 200) : undefined;
      const effort = typeof p.effort === 'string' && p.effort.trim() ? textRequired(p.effort, '思考程度', 40) : undefined;
      const opId = resolveOpId(p.opId, this.now());
      const before = await driver.get(sessionId);
      const baseline = baselineOfSnapshot(before, this.now());
      const sent = await driver.send(opId, {sessionId, prompt, mode, model, effort, autonomy});
      this.rememberBaseline(driver.service, sessionId, baseline);
      const session = await driver.get(sessionId);
      const out: SessionSendResult = {
        service: driver.service,
        sessionId,
        kind: sent.kind,
        baseline,
        session,
      };
      if (p.wait === true) {
        const until = p.until !== undefined ? (isSessionWaitUntil(p.until) ? p.until : (() => {throw new BridgeError('invalid', '等待条件无效');})()) : 'turn_end';
        const waitResult = await this.waitFor(driver.service, sessionId, {until, timeoutMs: p.timeoutMs, baseline});
        out.waitResult = waitResult;
        out.session = waitResult.session;
      }
      return out as unknown as Json;
    }

    if (action === 'agent.session.wait') {
      const driver = this.driver(p.service);
      const sessionId = textRequired(p.sessionId, '会话 ID', 120);
      const until = p.until !== undefined ? (isSessionWaitUntil(p.until) ? p.until : (() => {throw new BridgeError('invalid', '等待条件无效');})()) : 'turn_end';
      const baseline = this.consumeBaseline(driver.service, sessionId, p.baseline);
      return await this.waitFor(driver.service, sessionId, {until, timeoutMs: p.timeoutMs, baseline}) as unknown as Json;
    }

    if (action === 'agent.session.respond') {
      const driver = this.driver(p.service);
      const sessionId = textRequired(p.sessionId, '会话 ID', 120);
      const requestId = textRequired(p.requestId, '确认标识', 80);
      const decision = p.decision;
      if (decision !== 'allow' && decision !== 'allowSession' && decision !== 'deny') {
        throw new BridgeError('invalid', '回应决定无效（可选：allow、allowSession、deny）');
      }
      const answers = p.answers && typeof p.answers === 'object' && !Array.isArray(p.answers)
        ? Object.fromEntries(Object.entries(p.answers).map(([k, v]) => [k, String(v ?? '')]))
        : undefined;
      const opId = resolveOpId(p.opId, this.now());
      const before = await driver.get(sessionId);
      const baseline = baselineOfSnapshot(before, this.now());
      await driver.respond(opId, {sessionId, requestId, decision, answers});
      this.rememberBaseline(driver.service, sessionId, baseline);
      const session = await driver.get(sessionId);
      return {responded: true, baseline, session};
    }

    if (action === 'agent.session.stop') {
      const driver = this.driver(p.service);
      const sessionId = textRequired(p.sessionId, '会话 ID', 120);
      const opId = resolveOpId(p.opId, this.now());
      await driver.stop(opId, {sessionId, killBackgroundTasks: p.killBackgroundTasks === true});
      this.baselines.delete(`${driver.service}:${sessionId}`);
      const session = await driver.get(sessionId);
      return {stopRequested: true, session};
    }

    throw new BridgeError('unsupported', `不支持的统一会话操作：${action}`);
  }
}
