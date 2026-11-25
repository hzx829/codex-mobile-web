import {execFile} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {Agent, request, type ClientRequestArgs} from 'node:http';
import {join} from 'node:path';
import type {Duplex} from 'node:stream';
import {connect, type TLSSocket} from 'node:tls';
import {promisify} from 'node:util';
import {BridgeError, type Json} from '../shared/types.js';

const exec = promisify(execFile);
export type Endpoint = {pid: number; httpsPort: number; csrfToken: string};
export type HubMethod =
  | 'StartCascade' | 'SendUserCascadeMessage' | 'CancelCascadeInvocation' | 'DeleteCascadeTrajectory'
  | 'GetCascadeModelConfigData' | 'GetTrajectoryTurns'
  | 'GetPermissionSettings' | 'UpdateConversationAnnotations'
  | 'GetAllCascadeTrajectories' | 'GetCascadeTrajectorySteps' | 'HandleCascadeUserInteraction'
  | 'SendAudioChunk' | 'EndAudioSession';
export type HubStreamMethod = 'StreamAudioTranscription';

const READ_METHODS = new Set<HubMethod>([
  'GetCascadeModelConfigData', 'GetTrajectoryTurns',
  'GetPermissionSettings', 'GetAllCascadeTrajectories', 'GetCascadeTrajectorySteps',
]);

const ENDPOINT_CACHE_TTL_MS = 5_000;
const IDLE_SOCKET_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;

async function defaultFilterAntigravityPids(pids: number[]): Promise<Set<number>> {
  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs/antigravity/resources/bin/language_server.exe'))
    foreach ($id in @(${pids.join(',')})) {
      $p = Get-Process -Id $id
      if ($p -and $p.Path -eq $expected) { Write-Output $id }
    }`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const {stdout} = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {timeout: 7000, windowsHide: true});
  return new Set(stdout.split(/\r?\n/).map(line => Number(line.trim())).filter(n => Number.isSafeInteger(n) && n > 0));
}

// Verify the server end of this already-established socket before attaching its CSRF token.
// Checking only the listener would allow a newly started process to inherit a stale port.
async function defaultOwnsSocket(hub: Endpoint, clientPort: number) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $expected = Join-Path $env:LOCALAPPDATA 'Programs/antigravity/resources/bin/language_server.exe'
    $process = Get-Process -Id ${hub.pid}
    if ($process.Path -ne [IO.Path]::GetFullPath($expected)) { exit 1 }
    $netstat = Join-Path $env:SystemRoot 'System32/netstat.exe'
    $tuple = '^\\s*TCP\\s+127\\.0\\.0\\.1:${hub.httpsPort}\\s+127\\.0\\.0\\.1:${clientPort}\\s+\\S+\\s+${hub.pid}\\s*$'
    if (-not (& $netstat -ano -p tcp | Select-String -Quiet -Pattern $tuple)) { exit 1 }`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {timeout: 7000, windowsHide: true});
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultConnectTls(port: number): TLSSocket {
  return connect({host: '127.0.0.1', port, rejectUnauthorized: false});
}

export interface HubClientOptions {
  ownsSocket?: (hub: Endpoint, clientPort: number) => Promise<void>;
  filterAntigravityPids?: (pids: number[]) => Promise<Set<number>>;
  isPidAlive?: (pid: number) => boolean;
  connectTls?: (port: number) => TLSSocket;
  endpointTtlMs?: number;
  idleSocketTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

class VerifiedHubAgent extends Agent {
  constructor(
    private readonly hub: Endpoint,
    private readonly verifySocket: (hub: Endpoint, clientPort: number) => Promise<void>,
    private readonly connectTls: (port: number) => TLSSocket,
    idleTimeoutMs: number,
    private readonly connectTimeoutMs: number,
  ) {
    super({
      keepAlive: true,
      keepAliveMsecs: 15_000,
      maxSockets: 4,
      maxFreeSockets: 4,
      timeout: idleTimeoutMs,
    });
  }

  override createConnection(_options: ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex | undefined {
    const socket = this.connectTls(this.hub.httpsPort);
    let settled = false;
    const onEarlyError = (err: Error) => fail(err);
    const onEarlyClose = () => fail(new Error('Hub closed'));
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', onEarlyError);
      socket.off('close', onEarlyClose);
      socket.destroy();
      callback?.(err, undefined as unknown as Duplex);
    };
    const timer = setTimeout(() => fail(new Error('Hub timeout')), this.connectTimeoutMs);
    socket.on('error', onEarlyError);
    socket.once('close', onEarlyClose);
    socket.once('secureConnect', () => {
      if (settled) return;
      const localPort = socket.localPort;
      if (!localPort) {
        fail(new Error('Hub socket missing localPort'));
        return;
      }
      void this.verifySocket(this.hub, localPort).then(() => {
        if (settled) return;
        if (socket.destroyed) {
          fail(new Error('Hub closed'));
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off('error', onEarlyError);
        socket.off('close', onEarlyClose);
        callback?.(null, socket);
      }, err => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
    });
    return undefined;
  }
}

export interface HubClient {
  callHub: (dir: string, method: HubMethod, body: Json) => Promise<Json>;
  openHubStream: (dir: string, method: HubStreamMethod, body: Json, handlers: HubStreamHandlers) => Promise<HubStreamHandle>;
  close: (dir?: string) => void;
}

/**
 * Creates a Hub client with endpoint caching and verified keep-alive TLS sockets.
 * Every new TLS socket runs `ownsSocket` before any HTTP bytes or CSRF token are written;
 * subsequent requests reuse the already-verified loopback connection while the Hub PID stays alive.
 */
export function createHubClient(options: HubClientOptions = {}): HubClient {
  const verifySocket = options.ownsSocket ?? defaultOwnsSocket;
  const filterPids = options.filterAntigravityPids ?? defaultFilterAntigravityPids;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const connectTls = options.connectTls ?? defaultConnectTls;
  const endpointTtlMs = options.endpointTtlMs ?? ENDPOINT_CACHE_TTL_MS;
  const idleSocketTimeoutMs = options.idleSocketTimeoutMs ?? IDLE_SOCKET_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const endpointCache = new Map<string, {endpoint: Endpoint; at: number}>();
  const endpointInflight = new Map<string, Promise<Endpoint>>();
  const agents = new Map<string, {key: string; agent: VerifiedHubAgent}>();

  const endpointKey = (hub: Endpoint) => `${hub.pid}:${hub.httpsPort}:${hub.csrfToken}`;

  function dropAgent(dir: string) {
    const existing = agents.get(dir);
    if (!existing) return;
    agents.delete(dir);
    existing.agent.destroy();
  }

  function invalidate(dir: string) {
    endpointCache.delete(dir);
    dropAgent(dir);
  }

  function close(dir?: string) {
    if (dir !== undefined) {
      invalidate(dir);
      return;
    }
    endpointCache.clear();
    for (const entry of agents.values()) entry.agent.destroy();
    agents.clear();
  }

  async function discoverEndpoint(dir: string): Promise<Endpoint> {
    const records = new Map<string, Endpoint>();
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter(name => /^hub_\d+\.json$/.test(name))) {
      try {
        const hub = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if (!Number.isSafeInteger(hub.pid) || hub.pid < 1 || !Number.isInteger(hub.httpsPort) ||
            hub.httpsPort < 1 || hub.httpsPort > 65535 || typeof hub.csrfToken !== 'string' ||
            !/^[\x21-\x7e]{1,512}$/.test(hub.csrfToken)) continue;
        if (!isPidAlive(hub.pid)) continue;
        records.set(`${hub.pid}:${hub.httpsPort}`, hub);
      } catch { /* Old Hub records can outlive their process. */ }
    }
    let live = [...records.values()];
    // Windows reuses PIDs quickly; an old hub_*.json whose PID now belongs to another program is not a second Hub.
    if (live.length > 1) {
      try {
        const valid = await filterPids([...new Set(live.map(hub => hub.pid))]);
        live = live.filter(hub => valid.has(hub.pid));
      } catch { /* Fall through to the ambiguity check below if process filtering fails. */ }
    }
    if (live.length !== 1) throw new BridgeError('unavailable', live.length ? '有多个活动 Hub，无法确定目标桌面' : '请先在电脑上打开 Antigravity');
    return live[0];
  }

  async function desktopEndpoint(dir: string, forceRefresh = false): Promise<Endpoint> {
    if (!forceRefresh) {
      const cached = endpointCache.get(dir);
      if (cached && now() - cached.at < endpointTtlMs) {
        if (isPidAlive(cached.endpoint.pid)) return cached.endpoint;
        invalidate(dir);
      }
    }
    let inflight = endpointInflight.get(dir);
    if (!inflight) {
      inflight = discoverEndpoint(dir).then(endpoint => {
        const current = agents.get(dir);
        if (current && current.key !== endpointKey(endpoint)) dropAgent(dir);
        endpointCache.set(dir, {endpoint, at: now()});
        return endpoint;
      }).finally(() => {
        if (endpointInflight.get(dir) === inflight) endpointInflight.delete(dir);
      });
      endpointInflight.set(dir, inflight);
    }
    return inflight;
  }

  function agentFor(dir: string, hub: Endpoint): VerifiedHubAgent {
    const key = endpointKey(hub);
    const existing = agents.get(dir);
    if (existing && existing.key === key) return existing.agent;
    if (existing) existing.agent.destroy();
    const agent = new VerifiedHubAgent(hub, verifySocket, connectTls, idleSocketTimeoutMs, requestTimeoutMs);
    agents.set(dir, {key, agent});
    return agent;
  }

  async function sendOnce(
    dir: string,
    hub: Endpoint,
    method: HubMethod,
    data: Buffer,
    reading: boolean,
  ): Promise<{result: Json; dispatched: boolean; reusedSocket: boolean}> {
    const agent = agentFor(dir, hub);
    let dispatched = false;
    let reusedSocket = false;
    let responseStarted = false;
    try {
      const result = await new Promise<Json>((resolve, reject) => {
        const req = request({
          host: '127.0.0.1',
          port: hub.httpsPort,
          method: 'POST',
          agent,
          path: '/exa.language_server_pb.LanguageServerService/' + method,
          headers: {
            'content-type': 'application/json',
            'content-length': data.length,
            'x-codeium-csrf-token': hub.csrfToken,
          },
        }, res => {
          responseStarted = true;
          res.on('error', reject);
          if ([401, 403, 404, 405, 415].includes(res.statusCode || 0)) {
            res.resume();
            if (res.statusCode === 401 || res.statusCode === 403) invalidate(dir);
            reject(new BridgeError('incompatible', `桌面 Hub 拒绝了操作（HTTP ${res.statusCode}），请核对桌面版本和账号。`));
            return;
          }
          if (res.statusCode !== 200 || !/^application\/json\b/i.test(res.headers['content-type'] || '')) {
            res.resume();
            reject(new Error('Unexpected Hub response'));
            return;
          }
          const chunks: Buffer[] = [];
          const limit = method === 'GetCascadeTrajectorySteps' ? 64 * 1024 * 1024 : reading ? 16 * 1024 * 1024 : 8192;
          let length = 0;
          res.on('data', (part: Buffer) => {
            length += part.length;
            if (length > limit) res.destroy(new Error('Unexpected Hub response size'));
            else chunks.push(part);
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || parsed.error) {
                throw new Error('Unexpected Hub receipt');
              }
              resolve(parsed);
            } catch (error) { reject(error); }
          });
        });
        req.setTimeout(requestTimeoutMs, () => {
          req.destroy(new Error('Hub timeout'));
        });
        // `socket` fires only after `VerifiedHubAgent.createConnection` passed `ownsSocket` (or reused a verified socket).
        req.once('socket', () => {
          dispatched = true;
          reusedSocket = Boolean(req.reusedSocket);
        });
        req.once('error', reject);
        req.end(data);
      });
      return {result, dispatched, reusedSocket};
    } catch (error) {
      throw Object.assign(new Error('Hub attempt failed'), {cause: error, dispatched, reusedSocket, responseStarted});
    }
  }

  async function callHub(dir: string, method: HubMethod, body: Json): Promise<Json> {
    const reading = READ_METHODS.has(method);
    const data = Buffer.from(JSON.stringify(body));
    let hub = await desktopEndpoint(dir);
    let dispatched = false;
    try {
      try {
        const out = await sendOnce(dir, hub, method, data, reading);
        return out.result;
      } catch (wrapped: any) {
        const cause = wrapped?.cause;
        dispatched = Boolean(wrapped?.dispatched);
        const reused = Boolean(wrapped?.reusedSocket);
        const responseStarted = Boolean(wrapped?.responseStarted);
        if (cause instanceof BridgeError) throw cause;
        // A pooled keep-alive socket may have been closed by the Hub while idle, or the Hub may have restarted.
        // Retry once on a freshly discovered & verified socket for idempotent reads (or writes that never reached a socket).
        if ((reading && !responseStarted) || (!dispatched && reused)) {
          invalidate(dir);
          hub = await desktopEndpoint(dir, true);
          try {
            const retryOut = await sendOnce(dir, hub, method, data, reading);
            return retryOut.result;
          } catch (retryWrapped: any) {
            dispatched = Boolean(retryWrapped?.dispatched);
            if (retryWrapped?.cause instanceof BridgeError) throw retryWrapped.cause;
            throw retryWrapped?.cause ?? retryWrapped;
          }
        }
        if (!dispatched || !isPidAlive(hub.pid)) invalidate(dir);
        throw cause ?? wrapped;
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (reading) throw new BridgeError('unavailable', '无法读取本机 Antigravity 设置，请确认桌面已打开并重试');
      throw new BridgeError(dispatched ? 'uncertain' : 'unavailable', dispatched
        ? '桌面回执未确认，请核对原会话' : '无法验证本机 Antigravity Hub，请确认桌面正在运行', dispatched);
    }
  }

  async function openHubStream(dir: string, method: HubStreamMethod, body: Json, handlers: HubStreamHandlers): Promise<HubStreamHandle> {
    const hub = await desktopEndpoint(dir);
    const socket = connectTls(hub.httpsPort);
    let closed = false, finished = false;
    const finish = (error?: BridgeError) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) handlers.onError(error);
      handlers.onEnd();
    };
    socket.on('error', () => {
      if (!closed) finish(new BridgeError('voice_failed', '与本机 Antigravity 语音服务的连接已断开，请重试'));
    });
    const connectTimer = setTimeout(() => socket.destroy(new Error('Hub timeout')), requestTimeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Hub closed')));
      });
      await verifySocket(hub, socket.localPort!);
      if (socket.destroyed) throw new Error('Hub closed');
    } catch (error) {
      clearTimeout(connectTimer);
      socket.destroy();
      invalidate(dir);
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('unavailable', '无法验证本机 Antigravity Hub，请确认桌面正在运行');
    }
    clearTimeout(connectTimer);
    const framed = connectFrame(body);
    const req = request({
      host: '127.0.0.1', port: hub.httpsPort, method: 'POST', createConnection: () => socket,
      path: '/exa.language_server_pb.LanguageServerService/' + method,
      headers: {
        'content-type': 'application/connect+json',
        'connect-protocol-version': '1',
        'content-length': framed.length,
        'x-codeium-csrf-token': hub.csrfToken,
      },
    }, res => {
      if ([401, 403, 404, 405, 415, 501].includes(res.statusCode || 0)) {
        res.resume();
        if (res.statusCode === 401 || res.statusCode === 403) invalidate(dir);
        finish(new BridgeError('incompatible', '本机 Antigravity 版本暂不支持语音识别，请更新 Antigravity 或切换识别方式'));
        return;
      }
      if (res.statusCode !== 200 || !/^application\/connect\+json\b/i.test(res.headers['content-type'] || '')) {
        res.resume();
        finish(new BridgeError('voice_failed', 'Antigravity 语音服务返回异常响应，请重试或切换识别方式'));
        return;
      }
      let buffer: Buffer = Buffer.alloc(0);
      res.on('data', (chunk: Buffer) => {
        if (closed || finished) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
          const flags = buffer[0];
          const length = buffer.readUInt32BE(1);
          if (length > 2 * 1024 * 1024) {
            finish(new BridgeError('voice_failed', 'Antigravity 语音数据超出限制'));
            return;
          }
          if (buffer.length < 5 + length) break;
          const payload = buffer.subarray(5, 5 + length).toString('utf8');
          buffer = buffer.subarray(5 + length);
          let parsed: Json;
          try { parsed = JSON.parse(payload); } catch { continue; }
          // Connect end-of-stream envelope (flag bit 1 = 0x02).
          if ((flags & 2) !== 0) {
            if (parsed?.error) {
              finish(new BridgeError('voice_failed', 'Antigravity 语音识别失败，请重试或切换识别方式'));
            } else {
              finish();
            }
            return;
          }
          if (parsed && typeof parsed === 'object') handlers.onMessage(parsed);
        }
      });
      res.on('end', () => finish());
      res.on('error', () => {
        if (!closed) finish(new BridgeError('voice_failed', 'Antigravity 语音流中断，请重试'));
      });
    });
    req.once('error', () => {
      if (!closed) finish(new BridgeError('voice_failed', '无法连接本机 Antigravity 语音服务，请确认桌面正在运行'));
    });
    req.end(framed);
    return {
      close() {
        if (closed) return;
        closed = true;
        finished = true;
        try { req.destroy(); } catch {}
        socket.destroy();
      },
    };
  }

  return {callHub, openHubStream, close};
}

export interface HubStreamHandlers {
  onMessage: (message: Json) => void;
  onError: (error: BridgeError) => void;
  onEnd: () => void;
}
export interface HubStreamHandle {
  close: () => void;
}

/** Encodes one Connect-RPC envelope frame (1-byte flags + 4-byte big-endian length + JSON). */
export function connectFrame(body: Json): Buffer {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

const defaultHubClient = createHubClient();

export function callHub(dir: string, method: HubMethod, body: Json): Promise<Json> {
  return defaultHubClient.callHub(dir, method, body);
}

/** Opens a verified Connect-RPC server-streaming call to the local Antigravity Hub. */
export function openHubStream(dir: string, method: HubStreamMethod, body: Json, handlers: HubStreamHandlers): Promise<HubStreamHandle> {
  return defaultHubClient.openHubStream(dir, method, body, handlers);
}

/** Destroys pooled keep-alive Hub sockets and clears cached endpoints. */
export function closeHubPool(dir?: string): void {
  defaultHubClient.close(dir);
}
