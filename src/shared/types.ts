export type Json = Record<string, any>;
export type AntigravityAction = `antigravity.${'list' | 'create' | 'read' | 'watch' | 'models' | 'send' | 'stop' | 'respond' | 'operation' | 'file.read' | 'file.download' | 'file.uploadStart' | 'file.uploadChunk'}`;
export type ClaudeAction = `claude.${'list' | 'read' | 'watch' | 'file.read' | 'file.download' | 'file.uploadStart' | 'file.uploadChunk' | 'models' | 'create' | 'send' | 'stop' | 'respond' | 'operation' | 'project.get' | 'project.save' | 'fork' | 'rename' | 'archive' | 'edit' | 'steerQueued' | 'withdrawQueued' | 'cancelQueued' | 'artifact.snapshot' | 'artifact.download' | 'artifact.login'}`;
export type AntigravityModel = {id:string; label:string; description?:string; supportsImages?:boolean; group?:string; groupLabel?:string; effort?:string};
export type AntigravityModelGroup = {id:string; label:string; description?:string; efforts?:string[]; defaultEffort?:string; variants?:Record<string,string>; supportsImages?:boolean};
export const ANTIGRAVITY_PERMISSION_MODES = ['AGENT_PERMISSION_PRESET_AUTO', 'AGENT_PERMISSION_PRESET_DEFAULT', 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW', 'AGENT_PERMISSION_PRESET_TURBO'] as const;
export type AntigravityPermissionMode = typeof ANTIGRAVITY_PERMISSION_MODES[number];
export type ApprovalQuestion = {question:string; header:string; multiSelect:boolean; options:{label:string; description:string}[]};
export type ApprovalRequest = {id:string; kind:'permission'|'question'|'plan'|'notice'; tool:string; title:string; detail:string; canRemember:boolean; rememberScope?:'session'|'project'|'user'; implementModes?:string[]; questions?:ApprovalQuestion[]};
export type AntigravityMessage = {id:string; role:'user'|'assistant'|'tool'; text:string; sender?:TeamMember};
export type AntigravityIssue = {kind:'retry'; attempt:number; connection:boolean} | {kind:'interrupted'} | {kind:'error'};
export const bridgeServices = ['codex', 'antigravity', 'claude'] as const;
export type BridgeService = typeof bridgeServices[number];
/** `protocol` and `features`: what the computer's connector reported (src/shared/protocol.ts); older connectors and relays leave them out. */
export type Machine = {id: string; name: string; guest?: boolean; services?: BridgeService[]; protocol?: number; features?: string[]};
export type RequestAction = AntigravityAction | ClaudeAction | 'project.create' | 'info' | 'runtime.reload' | 'sessions.list' | 'session.read' | 'session.status' | 'session.create' | 'session.fork' | 'session.resume' | 'session.rename' | 'session.archive' | 'session.unarchive' | 'turn.send' | 'turn.cancelQueued' | 'turn.withdrawQueued' | 'turn.steerQueued' | 'turn.edit' | 'turn.stop' | 'request.respond' | 'operation.read' | 'file.read' | 'file.download' | 'file.uploadStart' | 'file.uploadChunk' | 'preview.start' | 'preview.stop' | 'voice.transcribe' | 'voice.stream.open' | 'voice.stream.audio' | 'voice.stream.close' | 'voice.stream.cancel';
export interface BridgeRequest { id: string; action: RequestAction; payload: Json; machineId?: string }
/** `sender`: the team member who sent a user message from the phone, when the connector recorded it. */
export interface MessageItem { id: string; type: string; role: string; text: string; files?: string[]; images?: string[]; sender?: TeamMember }
/** `anchor`: the last transcript entry of the turn, where a Claude Code fork ends. `pages`: claude.ai Artifacts the turn published; on the newest turn also those of earlier turns (`earlier`). `changed`: the turn's latest call that changed the page; `shown`: its latest call that put the page in front of the user. */
export interface TurnView { id: string; status: string; items: MessageItem[]; canFork: boolean; diff?: string; error?: string; revision?: string; anchor?: string; pages?: {url: string; title: string; earlier?: boolean; changed?: string; shown?: string}[];
  /** The plan as the turn left it (Claude Code's plan tools). */
  plan?: PlanStep[];
  /** On a turn under way: what it is doing now. `item`: the activity item of the call still running; `startedAt`: when that began (ISO). */
  step?: {text: string; type?: string; item?: string; startedAt?: string};
  /** The closing card Claude's desktop app shows under a turn: what was done, what it asks, and answers to tap. */
  nextStep?: NextStep }
export interface PlanStep { text: string; status: 'pending' | 'in_progress' | 'completed' }
/** `action`: an app action the answer stands for (commit, create_pr…); the label is what is sent as the reply. */
export interface NextStep { recap: string; ask: string; actions: {label: string; action?: string}[]; blocked?: boolean }
export interface TurnCursor { before: string; native?: string }
export const turnFinished=(status:unknown)=>status==='completed'||status==='interrupted'||status==='failed';
export interface ContextUsage { usedTokens: number; windowTokens: number | null }
export interface UsageLimit { id: string; name: string | null; usedPercent: number; windowMinutes: number | null; resetsAt: number | null }
export interface ThreadStatus { threadId: string; limits: UsageLimit[]; limitsNotice?: string }
export interface QueuedMessage { id: string; text: string; imageCount: number; fileNames?: string[]; imageBytes?: number; state: 'queued' | 'sending' | 'failed' | 'uncertain'; error?: string }
export interface SessionView {
  id: string; sessionId: string; title: string; cwd: string; model: string; provider: string; effort?: string; approvalPolicy?: string; serviceTier?: string | null;
  source: 'desktop' | 'connector' | 'history'; activeTurnId: string | null; running?: boolean; contextUsage?: ContextUsage | null;
  turns: TurnView[]; requests: Json[]; queuedMessages?: QueuedMessage[]; canControl: boolean; hasMore?: boolean; nextCursor?: TurnCursor | null; notice?: string; retry?: string; generation?: string; resumeUnavailable?: boolean;
  /** Added by a relay with a team: who started the session and who last sent to it, when known. */
  owner?: TeamMember | null; lastSender?: TeamMember | null;
}
export interface TeamMember { id: string; name: string }
/** One model's tokens in a turn. Input includes cached input; output includes reasoning where the model reports it. */
export interface UsageTokens { model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }
/** One finished turn, sent by the connector to a team relay. No `models` when its tokens are unknown (Antigravity). */
export interface UsageEvent { id: string; ts: number; service: BridgeService; threadId: string; turnId: string; opId?: string; actor?: {userId: string; name?: string}; models: UsageTokens[] }
export class BridgeError extends Error {
  constructor(public code: string, message: string, public uncertain = false) { super(message); }
}
export function textRequired(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new BridgeError('invalid', `${label}无效`);
  return value.trim();
}
export const MAX_FRAME = 12 * 1024 * 1024;
export const FILE_CHUNK_SIZE = 512 * 1024;
export const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024;
export interface FilePreview {
  path: string; name: string; size: number; revision: string; mime: string;
  text?: string; data?: string; notice?: string;
}
export interface FileChunk { offset: number; data: string }
