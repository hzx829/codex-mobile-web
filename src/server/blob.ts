import type {IncomingMessage, ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import type {Json} from '../shared/types.js';
import {BLOB_ACTIONS} from '../shared/protocol.js';

/**
 * The relay's data channel (docs/sync/DESIGN.md §8). A phone downloads a file with a plain GET, which the relay joins to
 * one HTTP upload from the computer, so file bytes never pass through the chat connection and never as base64:
 *
 *   phone    POST /blob/session            token in Authorization → an HttpOnly cookie for this device
 *   phone    GET  /blob/<machine>/file?action=…&…   (Range allowed)
 *   relay    → computer, on its connection: {type:'blob.pull', stream, action, payload, range}
 *   computer POST /blob-feed/<stream>      body: the bytes; status, size and type in x-blob-* headers
 *
 * Only download actions are relayed, and the computer runs them with all their usual checks.
 */
const COOKIE = 'cmw_blob', SESSION_MS = 12 * 3600_000, FEED_WAIT_MS = 60_000, PER_SESSION = 4;
/** Types a page may show inline; anything else is always a download and never runs as this site's page. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'application/pdf']);

/** Who a cookie stands for: `deviceId` with a team (checked again on every use), the shared token's holder without. */
export type BlobSession = {expires: number; deviceId?: string};
export type BlobHost = {
  /** The device a token signs in as, null when it is not valid; `{}` for the shared token. */
  signIn(token: string): {deviceId?: string} | null;
  /** Whether the device may use the computer now (a team can remove it or the computer at any time). */
  allowed(session: BlobSession, machineId: string): boolean;
  /** Sends to the computer's connector; false when it is not connected. */
  pull(machineId: string, message: Json): boolean;
};

type Waiting = {response: ServerResponse; session: string; timer: NodeJS.Timeout; download: boolean};

export class BlobChannel {
  private sessions = new Map<string, BlobSession>();
  private waiting = new Map<string, Waiting>();
  private open = new Map<string, number>();
  constructor(private host: BlobHost, private now = Date.now) {}

  /** Handles `/blob…` and `/blob-feed/…`; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url || '/', 'http://relay.invalid');
    if (url.pathname === '/blob/session' && req.method === 'POST') {this.signIn(req, res);return true;}
    const file = /^\/blob\/([\w-]{1,80})\/file$/.exec(url.pathname);
    if (file && req.method === 'GET') {this.request(req, res, decodeURIComponent(file[1]), url);return true;}
    const feed = /^\/blob-feed\/([a-f0-9]{64})$/.exec(url.pathname);
    if (feed && req.method === 'POST') {void this.feed(req, res, feed[1]);return true;}
    if (url.pathname.startsWith('/blob')) {res.writeHead(404);res.end();return true;}
    return false;
  }
  close() {for (const waiting of this.waiting.values()) {clearTimeout(waiting.timer);waiting.response.destroy();}this.waiting.clear();}

  private signIn(req: IncomingMessage, res: ServerResponse) {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
    const who = token ? this.host.signIn(token) : null;
    if (!who) {res.writeHead(401);res.end();return;}
    for (const [id, session] of this.sessions) if (session.expires < this.now()) this.sessions.delete(id);
    const id = randomBytes(32).toString('hex');
    this.sessions.set(id, {expires: this.now() + SESSION_MS, ...who.deviceId ? {deviceId: who.deviceId} : {}});
    const secure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted;
    res.writeHead(204, {'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/blob; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`});
    res.end();
  }
  private session(req: IncomingMessage): [string, BlobSession] | undefined {
    const id = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    const session = id ? this.sessions.get(id) : undefined;
    if (!id || !session) return undefined;
    if (session.expires < this.now()) {this.sessions.delete(id);return undefined;}
    return [id, session];
  }
  private request(req: IncomingMessage, res: ServerResponse, machineId: string, url: URL) {
    const found = this.session(req);
    if (!found) {res.writeHead(401);res.end();return;}
    const [sessionId, session] = found;
    if (!this.host.allowed(session, machineId)) {res.writeHead(403);res.end();return;}
    const action = url.searchParams.get('action') || '';
    if (!BLOB_ACTIONS.has(action)) {res.writeHead(400);res.end();return;}
    if ((this.open.get(sessionId) || 0) >= PER_SESSION) {res.writeHead(429);res.end();return;}
    const payload: Json = {};
    for (const [key, value] of url.searchParams) if (key !== 'action' && key !== 'download' && key.length <= 40 && value.length <= 4096) payload[key] = value;
    // One range from a start, as video and PDF viewers ask; suffix and multiple ranges are not needed here.
    const range = req.headers.range ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null;
    if (req.headers.range && !range) {res.writeHead(416);res.end();return;}
    const asked = range ? {start: Number(range[1]), ...range[2] ? {end: Number(range[2])} : {}} : undefined;
    const stream = randomBytes(32).toString('hex');
    if (!this.host.pull(machineId, {type: 'blob.pull', stream, action, payload, ...asked ? {range: asked} : {}})) {res.writeHead(503);res.end();return;}
    this.open.set(sessionId, (this.open.get(sessionId) || 0) + 1);
    const timer = setTimeout(() => {if (this.waiting.delete(stream)) {res.writeHead(504);res.end();}}, FEED_WAIT_MS);
    this.waiting.set(stream, {response: res, session: sessionId, timer, download: url.searchParams.get('download') === '1'});
    res.on('close', () => {
      const left = (this.open.get(sessionId) || 1) - 1;if (left) this.open.set(sessionId, left);else this.open.delete(sessionId);
      const waiting = this.waiting.get(stream);if (waiting?.response === res) {clearTimeout(waiting.timer);this.waiting.delete(stream);}
    });
  }
  private async feed(req: IncomingMessage, res: ServerResponse, stream: string) {
    const waiting = this.waiting.get(stream);
    if (!waiting) {req.resume();res.writeHead(404);res.end();return;}
    clearTimeout(waiting.timer);this.waiting.delete(stream);
    const phone = waiting.response, header = (name: string) => String(req.headers[name] || '');
    const status = Number(header('x-blob-status')) || 502;
    if (status >= 400) {
      req.resume();
      phone.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8'});phone.end(decodeURIComponent(header('x-blob-error')) || '读取失败');
      res.writeHead(204);res.end();return;
    }
    const mime = header('x-blob-mime'), inline = INLINE.has(mime) && !waiting.download;
    const size = Number(header('x-blob-size')), start = Number(header('x-blob-start')), end = Number(header('x-blob-end'));
    const name = header('x-blob-name');
    phone.writeHead(status, {
      'Content-Type': inline ? mime : 'application/octet-stream',
      'Content-Length': header('content-length'),
      'Accept-Ranges': 'bytes',
      ...status === 206 ? {'Content-Range': `bytes ${start}-${end}/${size}`} : {},
      // A file is never this site's page: no scripts, no frames, saved rather than run.
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      ...inline ? {} : {'Content-Disposition': `attachment; filename*=UTF-8''${name}`},
    });
    try {await pipeline(req, phone);res.writeHead(204);res.end();}
    catch {req.destroy();phone.destroy();if (!res.headersSent) {res.writeHead(499);}res.end();}
  }
}
