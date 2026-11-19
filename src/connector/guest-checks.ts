import type {Json} from '../shared/types.js';
import {claudeEnv, findClaude} from './claude-runtime.js';
import {GUEST_ENTRYPOINT} from './guest.js';

/**
 * A borrowed computer is only useful if the apps reach their service with the owner's login, proxy and
 * endpoint. Finding the files proves none of that, so after start-up each app answers one short message.
 * Neither test is saved as a session: Codex runs it as an ephemeral thread, Claude Code without persistence.
 */

export type CheckResult = {ok: boolean; message: string};
const PROMPT = 'Reply with the single word OK.';
const TIMEOUT = 90_000;
const ADVICE = '请确认这台电脑能上网；如果平时要开代理才能用，请先打开代理再重新启动。';
const NETWORK = '连不上服务。' + ADVICE;
const SILENT = '一分半钟内没有回应，可能连不上服务。' + ADVICE;
const short = (text: unknown) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);

function timeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<undefined>(resolve => {timer = setTimeout(() => {onTimeout();resolve(undefined);}, ms);})])
    .finally(() => clearTimeout(timer));
}

/** Codex `TurnError`, from `turn/completed` or a final `error` notification. */
export function explainCodex(error: Json | undefined): CheckResult {
  const info = error?.codexErrorInfo;
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  const detail = short(error?.message);
  if (kind === 'usageLimitExceeded' || kind === 'rateLimitExceeded')
    return {ok: true, message: '连接正常，但这个账号的 Codex 额度暂时用完了'};
  if (kind === 'serverOverloaded' || kind === 'internalServerError')
    return {ok: true, message: '连接正常，Codex 服务暂时繁忙'};
  if (kind === 'unauthorized') return {ok: false, message: 'Codex 的登录已失效。请打开 Codex 重新登录，再重新启动。'};
  if (['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(kind))
    return {ok: false, message: 'Codex ' + NETWORK};
  if (kind === 'modelNotFound') return {ok: false, message: `Codex 设置里的模型不可用：${detail}`};
  return {ok: false, message: `Codex 测试失败：${detail || '未知错误'}`};
}

type Runtime = {
  rpc(method: string, params: Json, timeout?: number): Promise<Json>;
  on(event: 'event', listener: (event: Json) => void): unknown;
  off(event: 'event', listener: (event: Json) => void): unknown;
};

/** Sends one message through the guest's Codex runtime. Read-only and never asks for approval. */
export async function checkCodex(runtime: Runtime, cwd: string, ms = TIMEOUT): Promise<CheckResult> {
  let threadId = '', failure: Json | undefined, retrying: Json | undefined, finish!: (turn: Json) => void;
  const completed = new Promise<Json>(resolve => {finish = resolve;});
  const listen = (event: Json) => {
    if (!threadId || event.params?.threadId !== threadId) return;
    if (event.method === 'error') {if (event.params.willRetry === false) failure = event.params.error;else retrying = event.params.error;}
    if (event.method === 'turn/completed') finish(event.params.turn);
  };
  runtime.on('event', listen);
  try {
    const started = await runtime.rpc('thread/start', {cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only'}, 30_000);
    threadId = started.thread.id;
    await runtime.rpc('turn/start', {threadId, input: [{type: 'text', text: PROMPT, text_elements: []}]}, 30_000);
    const turn = await timeout(completed, ms, () => {});
    if (!turn) return retrying ? explainCodex(retrying) : {ok: false, message: 'Codex ' + SILENT};
    if (turn.status === 'completed') return {ok: true, message: ''};
    return explainCodex(turn.error || failure);
  } catch (error) {
    return {ok: false, message: `Codex 无法开始测试：${short((error as Error).message)}`};
  } finally {runtime.off('event', listen);}
}

const NETWORK_TEXT = /connection error|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|network|timed? ?out|proxy/i;

/** The assistant message's `error` and the final result's text from a Claude Code run. */
export function explainClaude(error: string | undefined, text: string): CheckResult {
  const detail = short(text);
  if (error === 'rate_limit') return {ok: true, message: '连接正常，但这个账号的 Claude 额度暂时用完了'};
  if (error === 'server_error' || error === 'overloaded') return {ok: true, message: '连接正常，Claude 服务暂时繁忙'};
  if (error === 'authentication_failed' || error === 'oauth_org_not_allowed' || error === 'cloud_credential_error' || /invalid api key|please run \/login|not logged in|oauth token/i.test(detail))
    return {ok: false, message: 'Claude Code 的登录已失效。请在终端运行 claude 重新登录，再重新启动。'};
  if (error === 'billing_error' || error === 'account_on_hold' || error === 'verification_required')
    return {ok: false, message: `这个账号现在不能使用 Claude Code：${detail || error}`};
  if (error === 'model_not_found') return {ok: false, message: `Claude Code 设置里的模型不可用：${detail}`};
  if (NETWORK_TEXT.test(detail)) return {ok: false, message: 'Claude Code ' + NETWORK};
  return {ok: false, message: `Claude Code 测试失败：${detail || error || '未知错误'}`};
}

type ClaudeQuery = AsyncIterable<Json> & {close?(): void};
export type ClaudeLoader = () => Promise<(params: {prompt: string; options: Json}) => ClaudeQuery>;

/** Sends one message with Claude Code: no tools, one turn, not saved as a session. */
export async function checkClaude(load: ClaudeLoader, cwd: string, ms = TIMEOUT): Promise<CheckResult> {
  let q: ClaudeQuery | undefined;
  try {
    const query = await load();
    const executable = findClaude();
    q = query({prompt: PROMPT, options: {cwd, persistSession: false, tools: [], maxTurns: 1, env: claudeEnv(GUEST_ENTRYPOINT),
      ...(executable ? {pathToClaudeCodeExecutable: executable} : {}), stderr: () => {}}});
    const run = async () => {
      let error: string | undefined, text = '';
      for await (const message of q!) {
        if (message.type === 'assistant' && typeof message.error === 'string') error = message.error;
        if (message.type === 'result') {
          if (message.subtype === 'success' && !message.is_error && !error) return {ok: true, message: ''};
          text = [message.result, ...(Array.isArray(message.errors) ? message.errors : [])].filter(Boolean).join(' ');
          break;
        }
      }
      return explainClaude(error, text);
    };
    return await timeout(run(), ms, () => {try {q?.close?.();} catch {}}) ?? {ok: false, message: 'Claude Code ' + SILENT};
  } catch (error) {
    return {ok: false, message: `Claude Code 无法开始测试：${short((error as Error).message)}`};
  } finally {try {q?.close?.();} catch {}}
}
