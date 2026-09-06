export type Json = Record<string, any>;
export type RequestAction = 'info' | 'sessions.list' | 'session.read' | 'session.create' | 'session.resume' | 'turn.send' | 'turn.stop' | 'request.respond' | 'operation.read' | 'file.read';
export interface BridgeRequest { id: string; action: RequestAction; payload: Json; machineId?: string }
export interface MessageItem { id: string; type: string; role: string; text: string; files?: string[]; images?: string[] }
export interface TurnView { id: string; status: string; items: MessageItem[]; diff?: string; error?: string }
export interface SessionView {
  id: string; title: string; cwd: string; model: string; provider: string;
  source: 'desktop' | 'connector' | 'history'; activeTurnId: string | null;
  turns: TurnView[]; requests: Json[]; canControl: boolean; hasMore?: boolean; notice?: string; generation?: string;
}
export class BridgeError extends Error {
  constructor(public code: string, message: string, public uncertain = false) { super(message); }
}
export function textRequired(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new BridgeError('invalid', `${label}无效`);
  return value.trim();
}
export const MAX_FRAME = 12 * 1024 * 1024;
