import type {Json, UsageTokens} from '../shared/types.js';
import type {Ledger} from './ledger.js';

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Codex's cumulative `total` before a turn: its first update minus that update's own request. */
export function codexBase(total: Json, last: Json): Json {
  const base: Json = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) base[key] = Math.max(0, count(total?.[key]) - count(last?.[key]));
  return base;
}

/**
 * One Codex turn's tokens: the thread's cumulative total at the end minus the total before it began.
 * Codex counts cached input inside input and reasoning inside output; they are kept that way.
 */
export function codexTokens(model: string, base: Json, total: Json): UsageTokens {
  const delta = (key: string) => Math.max(0, count(total?.[key]) - count(base?.[key]));
  return {model, inputTokens: delta('inputTokens'), cachedInputTokens: delta('cachedInputTokens'), outputTokens: delta('outputTokens'), reasoningTokens: delta('reasoningOutputTokens')};
}

type ClaudeTotals = Record<string, {input: number; cacheRead: number; cacheCreation: number; output: number}>;

/** Claude Code's running totals per model from a `result` message's `modelUsage`. */
export function claudeTotals(modelUsage: unknown): ClaudeTotals {
  const totals: ClaudeTotals = {};
  if (!modelUsage || typeof modelUsage !== 'object') return totals;
  for (const [model, raw] of Object.entries(modelUsage as Json)) {
    if (!raw || typeof raw !== 'object' || !model) continue;
    totals[model.slice(0, 200)] = {input: count(raw.inputTokens), cacheRead: count(raw.cacheReadInputTokens), cacheCreation: count(raw.cacheCreationInputTokens), output: count(raw.outputTokens)};
  }
  return totals;
}

const empty = (totals: ClaudeTotals) => Object.values(totals).every(item => !item.input && !item.cacheRead && !item.cacheCreation && !item.output);

/**
 * Tokens of the turn between two running totals, or `undefined` when a total went down (a cleared
 * session): then the turn's share is unknown and nothing is counted rather than counting it all again.
 * Input includes cache reads and cache writes, as Codex's input includes its cached input.
 */
export function claudeDelta(previous: ClaudeTotals, current: ClaudeTotals): UsageTokens[] | undefined {
  const tokens: UsageTokens[] = [];
  for (const [model, now] of Object.entries(current)) {
    const before = previous[model] || {input: 0, cacheRead: 0, cacheCreation: 0, output: 0};
    const input = now.input - before.input, cacheRead = now.cacheRead - before.cacheRead, cacheCreation = now.cacheCreation - before.cacheCreation, output = now.output - before.output;
    if (input < 0 || cacheRead < 0 || cacheCreation < 0 || output < 0) return undefined;
    if (input || cacheRead || cacheCreation || output) tokens.push({model, inputTokens: input + cacheRead + cacheCreation, cachedInputTokens: cacheRead, outputTokens: output, reasoningTokens: 0});
  }
  return tokens;
}

/**
 * Where a Claude Code session's running total starts: `zero` for a session this connector created,
 * `cursor` for the total saved after its last turn, `unknown` when neither applies (a session started
 * elsewhere, or resumed from an earlier message). An unknown start only sets the baseline.
 */
export type ClaudeBaseline = 'zero' | 'cursor' | 'unknown';

/** Records one finished Claude Code turn: always as a turn, with tokens when its share can be told. */
export function recordClaudeTurn(ledger: Ledger, sessionId: string, baseline: ClaudeBaseline, result: Json, opId?: string) {
  if (!sessionId) return;
  const current = claudeTotals(result.modelUsage);
  const saved = ledger.claudeCursor(sessionId);
  const previous = baseline === 'zero' ? {} : baseline === 'cursor' ? saved : undefined;
  // A crashed turn may report zeros; keep the saved total so the next turn is still measured from it.
  const zeroed = empty(current) && saved && !empty(saved);
  if (!zeroed) ledger.setClaudeCursor(sessionId, current);
  const models = previous && !zeroed ? claudeDelta(previous, current) ?? [] : [];
  const turnId = typeof result.uuid === 'string' && result.uuid ? result.uuid : `${Date.now()}`;
  ledger.recordUsage({id: `claude:${sessionId}:${turnId}`, service: 'claude', threadId: sessionId, turnId, opId, models});
}
