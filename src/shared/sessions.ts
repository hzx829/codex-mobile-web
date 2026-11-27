import type {ApprovalRequest, BridgeService} from './types.js';

export const SESSION_AUTONOMIES = ['turbo', 'auto', 'default', 'review'] as const;
export type SessionAutonomy = typeof SESSION_AUTONOMIES[number];

export const SESSION_PHASES = ['running', 'waiting_approval', 'background_running', 'idle', 'canceling', 'error'] as const;
export type SessionPhase = typeof SESSION_PHASES[number];

export const SESSION_WAIT_UNTIL = ['turn_end', 'fully_idle'] as const;
export type SessionWaitUntil = typeof SESSION_WAIT_UNTIL[number];

export type SessionWaitStopReason = 'completed' | 'approval_needed' | 'background_running' | 'error' | 'timeout';

export function isSessionAutonomy(value: unknown): value is SessionAutonomy {
  return typeof value === 'string' && (SESSION_AUTONOMIES as readonly string[]).includes(value);
}

export function isSessionWaitUntil(value: unknown): value is SessionWaitUntil {
  return typeof value === 'string' && (SESSION_WAIT_UNTIL as readonly string[]).includes(value);
}

export interface SessionTurnMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface SessionBackgroundTaskView {
  id: string;
  title: string;
  command?: string;
  cwd?: string;
  output?: string;
}

export interface UnifiedSessionSummary {
  service: BridgeService;
  sessionId: string;
  title: string;
  cwd: string;
  running: boolean;
  background?: number | boolean;
  updatedAt: number;
}

export interface UnifiedSessionSnapshot {
  service: BridgeService;
  sessionId: string;
  title: string;
  cwd: string;
  phase: SessionPhase;
  running: boolean;
  canSend: boolean;
  autonomy?: SessionAutonomy;
  model?: string;
  lastUserMessage?: string;
  lastAssistantReply?: string;
  recentMessages: SessionTurnMessage[];
  requests: ApprovalRequest[];
  backgroundTasks: SessionBackgroundTaskView[];
  queuedCount: number;
  error?: string;
  notice?: string;
}

export interface SessionWaitBaseline {
  userCount: number;
  lastUserId?: string;
  lastAssistantId?: string;
  startedAt: number;
}

export interface SessionWaitResult {
  stopReason: SessionWaitStopReason;
  elapsedMs: number;
  session: UnifiedSessionSnapshot;
}

export interface SessionStartResult {
  service: BridgeService;
  sessionId: string;
  cwd: string;
  alignedFrom?: string;
  autonomy: SessionAutonomy;
  projectCreated?: boolean;
  submitted: boolean;
  uncertain?: boolean;
  baseline: SessionWaitBaseline;
  session: UnifiedSessionSnapshot;
  waitResult?: SessionWaitResult;
}

export interface SessionSendResult {
  service: BridgeService;
  sessionId: string;
  kind: 'turn_accepted' | 'queued' | 'steer_accepted' | 'sent_now';
  baseline: SessionWaitBaseline;
  session: UnifiedSessionSnapshot;
  waitResult?: SessionWaitResult;
}
