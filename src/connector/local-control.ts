import {createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {BridgeError, type Json} from '../shared/types.js';

export const LOCAL_CONTROL_FILE = 'local-control.json';
export const SESSION_DAEMON_FILE = 'session-daemon.json';
export const GLOBAL_CONTROL_DIRNAME = '.codex-mobile-web';
const MAX_BODY_BYTES = 512 * 1024;

export interface ActiveTask {
  service: 'codex' | 'claude' | 'antigravity';
  threadId: string;
  actorName?: string;
  queued?: boolean;
}

export interface LocalControlStatus {
  relay: 'ok' | 'connecting' | 'unreachable' | 'unauthorized';
  authReason?: 'machine_token_mismatch' | 'invalid_token' | 'replaced' | null;
  connector: 'online' | 'offline';
  teamMode: boolean;
  ownToken: boolean;
  machineId: string;
  machineName: string;
  services: string[];
  codexVersion?: string;
  desktopOnline?: boolean;
  claudeSignIn?: 'yes' | 'no' | 'unknown';
  activeTasks: ActiveTask[];
  pendingUsage: number;
  projectRoots?: string[];
  defaultProjectRoot?: string;
}

export interface LocalControlRecord {
  pid: number;
  port: number;
  secret: string;
  startedAt: number;
  dataDir?: string;
}

export function globalControlDir(home = homedir()): string {
  return join(home, GLOBAL_CONTROL_DIRNAME);
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readJsonBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BridgeError('too_large', '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});}
      catch {reject(new BridgeError('invalid', '请求格式无效'));}
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(payload);
}

function writeAtomicRecord(filePath: string, record: LocalControlRecord) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record) + '\n', {mode: 0o600});
  renameSync(tmp, filePath);
}

function removeOwnedRecord(filePath: string) {
  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<LocalControlRecord>;
    if (existing.pid === process.pid) rmSync(filePath, {force: true});
  } catch {}
}

/**
 * Loopback-only control server hosted by the running connector so the Windows tray,
 * health checks, cross-app session CLI, and local scripts work identically in single-token
 * and team modes without pretending to be a phone on the relay.
 */
export class LocalControlServer {
  private readonly server: Server;
  private readonly secret = randomBytes(32).toString('base64url');
  private readonly filePath: string;
  private readonly globalFilePath: string | null;
  private port = 0;

  constructor(private readonly options: {
    dataDir: string;
    fileName?: string;
    publishGlobal?: boolean;
    homeDir?: string;
    getStatus: () => Promise<LocalControlStatus>;
    handleRequest: (action: string, payload: Json, actor?: Json) => Promise<Json>;
  }) {
    const recordName = options.fileName || LOCAL_CONTROL_FILE;
    this.filePath = join(options.dataDir, recordName);
    this.globalFilePath = options.publishGlobal
      ? join(globalControlDir(options.homeDir), recordName)
      : null;
    this.server = createServer((req, res) => {void this.dispatch(req, res);});
    // Allow long-running `agent.session.wait` calls over loopback without hitting Node's 5-minute default timeout.
    this.server.requestTimeout = 0;
    this.server.timeout = 0;
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse) {
    res.setTimeout(0);
    if (!authorized(req.headers.authorization, this.secret)) {
      sendJson(res, 401, {error: {code: 'unauthorized', message: '未授权的本机控制请求'}});
      return;
    }
    const path = (req.url || '').split('?')[0];
    try {
      if (req.method === 'GET' && path === '/status') {
        sendJson(res, 200, await this.options.getStatus());
        return;
      }
      if (req.method === 'POST' && path === '/request') {
        const body = await readJsonBody(req);
        const action = typeof body?.action === 'string' ? body.action : '';
        const payload = body?.payload && typeof body.payload === 'object' ? body.payload : {};
        const actor = body?.actor && typeof body.actor === 'object' ? body.actor : undefined;
        if (!action) {sendJson(res, 400, {error: {code: 'invalid', message: '缺少 action'}}); return;}
        const result = await this.options.handleRequest(action, payload, actor);
        sendJson(res, 200, {result});
        return;
      }
      sendJson(res, 404, {error: {code: 'not_found', message: '不支持的路径'}});
    } catch (error) {
      const err = error instanceof BridgeError ? error : new BridgeError('computer_error', (error as Error)?.message || '本机控制请求失败');
      sendJson(res, 200, {error: {code: err.code, message: err.message, uncertain: err.uncertain}});
    }
  }

  async start(): Promise<LocalControlRecord> {
    mkdirSync(this.options.dataDir, {recursive: true});
    await new Promise<void>((resolveListen, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolveListen();
      });
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    const record: LocalControlRecord = {
      pid: process.pid,
      port: this.port,
      secret: this.secret,
      startedAt: Date.now(),
      dataDir: resolve(this.options.dataDir),
    };
    writeAtomicRecord(this.filePath, record);
    if (this.globalFilePath) {
      try {
        mkdirSync(globalControlDir(this.options.homeDir), {recursive: true});
        writeAtomicRecord(this.globalFilePath, record);
      } catch {
        // Non-fatal: the connector's own dataDir record is still written.
      }
    }
    return record;
  }

  close() {
    removeOwnedRecord(this.filePath);
    if (this.globalFilePath) removeOwnedRecord(this.globalFilePath);
    try {this.server.close();} catch {}
  }
}

export async function readLocalControl(dataDir: string, fileName = LOCAL_CONTROL_FILE): Promise<LocalControlRecord | null> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, fileName), 'utf8')) as Partial<LocalControlRecord>;
    if (!Number.isInteger(raw?.port) || raw.port! <= 0 || typeof raw?.secret !== 'string' || !raw.secret) return null;
    return {
      pid: Number(raw.pid) || 0,
      port: raw.port!,
      secret: raw.secret,
      startedAt: Number(raw.startedAt) || 0,
      ...(typeof raw.dataDir === 'string' && raw.dataDir ? {dataDir: raw.dataDir} : {}),
    };
  } catch {
    return null;
  }
}

export async function fetchLocalStatus(dataDir: string, timeoutMs = 4000): Promise<LocalControlStatus | null> {
  const control = await readLocalControl(dataDir);
  if (!control) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${control.port}/status`, {
      headers: {Authorization: `Bearer ${control.secret}`},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json() as LocalControlStatus;
  } catch {
    return null;
  }
}

export async function postControlRequest(
  control: LocalControlRecord,
  action: string,
  payload: Json = {},
  options: {timeoutMs?: number; actor?: Json} = {},
): Promise<Json | null> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const bodyBytes = Buffer.from(JSON.stringify({
    action,
    payload,
    ...(options.actor ? {actor: options.actor} : {}),
  }), 'utf8');
  return new Promise<Json | null>((resolveOut, rejectOut) => {
    let settled = false;
    const finish = (err: Error | null, value?: Json | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) rejectOut(err);
      else resolveOut(value ?? null);
    };
    const req = httpRequest({
      host: '127.0.0.1',
      port: control.port,
      path: '/request',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBytes.length,
        Authorization: `Bearer ${control.secret}`,
      },
    }, res => {
      if (res.statusCode === 401 || res.statusCode === 404) {
        res.resume();
        finish(null, null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', () => finish(null, null));
      res.on('end', () => {
        let parsed: {result?: Json; error?: {code?: string; message?: string; uncertain?: boolean}};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          finish(null, null);
          return;
        }
        if (parsed.error) {
          finish(new BridgeError(parsed.error.code || 'computer_error', parsed.error.message || '连接器处理失败', Boolean(parsed.error.uncertain)));
          return;
        }
        finish(null, parsed.result ?? {});
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(new BridgeError('timeout', '等待本机连接器响应超时'));
    }, timeoutMs);
    req.on('error', () => finish(null, null));
    req.end(bodyBytes);
  });
}

/**
 * Calls the running local connector directly. Returns `null` when no local control server is reachable
 * so callers can fall back to the legacy relay path or an in-process driver.
 */
export async function localBridgeRequest(
  dataDir: string,
  action: string,
  payload: Json = {},
  timeoutMs = 30000,
  actor?: Json,
): Promise<Json | null> {
  const control = await readLocalControl(dataDir);
  if (!control) return null;
  return postControlRequest(control, action, payload, {timeoutMs, actor});
}

/**
 * Probes candidate connector data directories (explicit dir, `~/.codex-mobile-web`, `%LOCALAPPDATA%\CodexMobileWeb\.local`)
 * and dispatches `action` to the first live local connector. Returns `null` if none is reachable.
 */
export async function discoverAndRequest(
  action: string,
  payload: Json = {},
  options: {dataDir?: string; homeDir?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; actor?: Json} = {},
): Promise<Json | null> {
  const home = options.homeDir || homedir();
  const env = options.env || process.env;
  const dirs = new Set<string>();
  if (options.dataDir) dirs.add(resolve(options.dataDir));
  if (env.CMW_DATA_DIR) dirs.add(resolve(env.CMW_DATA_DIR));
  dirs.add(globalControlDir(home));
  if (env.LOCALAPPDATA) dirs.add(join(env.LOCALAPPDATA, 'CodexMobileWeb', '.local'));
  for (const dir of dirs) {
    const record = await readLocalControl(dir);
    if (!record) continue;
    const result = await postControlRequest(record, action, payload, {timeoutMs: options.timeoutMs, actor: options.actor});
    if (result !== null) return result;
  }
  return null;
}
