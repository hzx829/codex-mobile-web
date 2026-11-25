import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BridgeError, type Json} from '../shared/types.js';

export const LOCAL_CONTROL_FILE = 'local-control.json';
const MAX_BODY_BYTES = 256 * 1024;

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
}

function authorized(header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readJsonBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
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
      try {resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});}
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

/**
 * Loopback-only control server hosted by the running connector so the Windows tray,
 * health checks, and local scripts work identically in single-token and team modes
 * without pretending to be a phone on the relay.
 */
export class LocalControlServer {
  private readonly server: Server;
  private readonly secret = randomBytes(32).toString('base64url');
  private readonly filePath: string;
  private port = 0;

  constructor(private readonly options: {
    dataDir: string;
    getStatus: () => Promise<LocalControlStatus>;
    handleRequest: (action: string, payload: Json) => Promise<Json>;
  }) {
    this.filePath = join(options.dataDir, LOCAL_CONTROL_FILE);
    this.server = createServer((req, res) => {void this.dispatch(req, res);});
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse) {
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
        if (!action) {sendJson(res, 400, {error: {code: 'invalid', message: '缺少 action'}}); return;}
        const result = await this.options.handleRequest(action, payload);
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
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    const record: LocalControlRecord = {pid: process.pid, port: this.port, secret: this.secret, startedAt: Date.now()};
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record) + '\n', {mode: 0o600});
    renameSync(tmp, this.filePath);
    return record;
  }

  close() {
    try {
      const existing = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<LocalControlRecord>;
      if (existing.pid === process.pid) rmSync(this.filePath, {force: true});
    } catch {}
    try {this.server.close();} catch {}
  }
}

export async function readLocalControl(dataDir: string): Promise<LocalControlRecord | null> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, LOCAL_CONTROL_FILE), 'utf8')) as Partial<LocalControlRecord>;
    if (!Number.isInteger(raw?.port) || raw.port! <= 0 || typeof raw?.secret !== 'string' || !raw.secret) return null;
    return {pid: Number(raw.pid) || 0, port: raw.port!, secret: raw.secret, startedAt: Number(raw.startedAt) || 0};
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

/**
 * Calls the running local connector directly. Returns `null` when no local control server is reachable
 * so callers can fall back to the legacy relay path for older connectors.
 */
export async function localBridgeRequest(dataDir: string, action: string, payload: Json = {}, timeoutMs = 30000): Promise<Json | null> {
  const control = await readLocalControl(dataDir);
  if (!control) return null;
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${control.port}/request`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${control.secret}`},
      body: JSON.stringify({action, payload}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (response.status === 401 || response.status === 404) return null;
  const body = await response.json() as {result?: Json; error?: {code?: string; message?: string; uncertain?: boolean}};
  if (body.error) throw new BridgeError(body.error.code || 'computer_error', body.error.message || '连接器处理失败', body.error.uncertain);
  return body.result ?? {};
}
