import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {Agent as HttpsAgent} from 'node:https';
import {connect as tlsConnect} from 'node:tls';
import type {Duplex} from 'node:stream';
import {WebSocket} from 'ws';
import {BridgeError, type Json} from '../shared/types.js';
import {MAX_VOICE_CHUNK_BYTES, MAX_VOICE_SESSION_MS, VOICE_SAMPLE_RATE, joinDictation, voiceStreamId} from '../shared/voice.js';
import {claudeConfigDir} from './claude-code.js';

/**
 * Claude Code's own dictation service (its `/voice` mode and the desktop app's microphone): audio
 * streams in over a WebSocket and the text so far streams back, so nothing waits for a pause.
 * It signs in with the computer's Claude Code login (a claude.ai account), which never leaves it.
 */
export const VOICE_STREAM_URL = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream';
const USER_AGENT = 'codex-mobile-web';
/** Mandarin with English words in it is recognised as spoken, so one language serves both. */
const LANGUAGE = 'zh';
const KEEP_ALIVE_MS = 8000;
const OPEN_TIMEOUT_MS = 10_000;
/** After the end of audio: the final text normally arrives within a second. */
const FINAL_TIMEOUT_MS = 5000;
const FINAL_QUIET_MS = 1500;
/** A stream the phone stopped feeding (closed, lost its connection) is dropped after this. */
const IDLE_MS = 20_000;
const MAX_STREAMS = 4;
/** Audio waiting for the service while it connects or reconnects; beyond this the link is too slow. */
const MAX_QUEUED_BYTES = VOICE_SAMPLE_RATE * 2 * 30;
const MAX_RECONNECTS = 3;

type Login = {accessToken: string; expiresAt?: number};

/** The claude.ai login Claude Code keeps: a file beside its settings, or the macOS keychain. */
export async function readClaudeLogin(dir = claudeConfigDir(), platform = process.platform): Promise<Login | undefined> {
  let raw: string | undefined;
  try {raw = await readFile(join(dir, '.credentials.json'), 'utf8');} catch {}
  if (raw === undefined && platform === 'darwin') {
    try {raw = (await promisify(execFile)('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {timeout: 5000})).stdout;} catch {}
  }
  try {
    const login = JSON.parse(raw || '')?.claudeAiOauth;
    if (typeof login?.accessToken === 'string' && login.accessToken)
      return {accessToken: login.accessToken, expiresAt: typeof login.expiresAt === 'number' ? login.expiresAt : undefined};
  } catch {}
  return undefined;
}

/**
 * Hands out the access token, asking Claude Code to renew its login when it has expired. Claude Code
 * renews it itself: renewing here would replace the refresh token under a running Claude Code.
 */
export class ClaudeVoiceAuth {
  constructor(private renew: () => Promise<void> = async () => {}, private read = () => readClaudeLogin(), private now = Date.now) {}
  /** `rejected`: the service refused this token, so a renewed one is required. */
  async token(rejected?: string): Promise<string> {
    let login = await this.read();
    if (!login) throw new BridgeError('voice_auth', 'Claude 识别需要电脑上的 Claude Code 登录 claude.ai 账号，也可在语音设置切换识别方式');
    if (login.accessToken === rejected || login.expiresAt !== undefined && login.expiresAt - this.now() < 60_000) {
      await this.renew().catch(() => {});
      login = await this.read();
      if (!login || login.accessToken === rejected || login.expiresAt !== undefined && login.expiresAt <= this.now())
        throw new BridgeError('voice_auth', '电脑上 Claude Code 的登录已过期，请在电脑上打开一次 Claude Code 后重试');
    }
    return login.accessToken;
  }
}

/** The HTTPS proxy from the environment for this host, unless NO_PROXY exempts it. */
export function proxyFor(target: string, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  const host = new URL(target).hostname.toLowerCase();
  const exempt = (env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(entry => entry.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\*?\./, '')).filter(Boolean);
  if (exempt.some(entry => entry === '*' || host === entry || host.endsWith('.' + entry))) return undefined;
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return undefined;
  try {const url = new URL(proxy);return url.protocol === 'http:' ? url : undefined;} catch {return undefined;}
}

/** Opens TLS through an HTTP proxy's CONNECT tunnel; the proxy sees only the host name. */
class TunnelAgent extends HttpsAgent {
  constructor(private proxy: URL) {super({keepAlive: false});}
  override createConnection(options: Json, callback: (error: Error | null, socket?: Duplex) => void): Duplex | undefined {
    const authority = `${options.host}:${options.port || 443}`;
    const auth = this.proxy.username ? {'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString('base64')} : {};
    const tunnel = httpRequest({host: this.proxy.hostname, port: this.proxy.port || 80, method: 'CONNECT', path: authority, headers: {Host: authority, ...auth}});
    tunnel.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {socket.destroy();callback(new Error(`proxy ${response.statusCode}`));return;}
      callback(null, tlsConnect({socket, servername: options.servername || options.host, ALPNProtocols: ['http/1.1']}));
    });
    tunnel.once('error', error => callback(error));
    tunnel.end();
    return undefined;
  }
}

type Upstream = {ws: WebSocket; open: boolean; finishing: boolean; keepAlive?: NodeJS.Timeout; opened: Promise<void>};

class VoiceStream {
  finals: string[] = [];
  interim = '';
  queue: Buffer[] = [];
  queued = 0;
  upstream?: Upstream;
  error?: BridgeError;
  nextSeq = 0;
  early = new Map<number, Buffer>();
  reconnects = 0;
  received = 0;
  ended = false;
  lastSeen: number;
  readonly startedAt: number;
  /** Called on each message from the service and when it closes, while the final text is awaited. */
  onEvent?: (kind: 'message' | 'endpoint' | 'closed') => void;
  constructor(readonly id: string, now: number) {this.startedAt = this.lastSeen = now;}
  text() {return [...this.finals, this.interim].reduce((all, piece) => joinDictation(all, piece), '');}
  /** Keeps what the service has heard when its connection ends before the final text. */
  settle() {if (this.interim) this.finals.push(this.interim);this.interim = '';}
}

/** Streams the phone's audio to Claude's dictation service and answers each request with the text so far. */
export class ClaudeVoiceStreams {
  private streams = new Map<string, VoiceStream>();
  private sweep: NodeJS.Timeout;
  constructor(private auth: ClaudeVoiceAuth, private endpoint = VOICE_STREAM_URL, private now = Date.now, private env: NodeJS.ProcessEnv = process.env) {
    this.sweep = setInterval(() => {
      for (const stream of this.streams.values()) if (this.now() - stream.lastSeen > IDLE_MS) this.drop(stream);
    }, 5000);
    this.sweep.unref();
  }

  async handle(action: string, p: Json): Promise<Json> {
    const id = voiceStreamId(p.id);
    if (!id) throw new BridgeError('invalid', '语音标识无效');
    if (action === 'voice.stream.open') {
      if (this.streams.has(id)) return {id};
      if (this.streams.size >= MAX_STREAMS) {
        // A phone that lost its connection leaves its stream behind; the oldest one gives way.
        const oldest = [...this.streams.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        this.drop(oldest);
      }
      const stream = new VoiceStream(id, this.now());
      this.streams.set(id, stream);
      void this.connect(stream);
      return {id};
    }
    const stream = this.streams.get(id);
    if (action === 'voice.stream.cancel') {if (stream) this.drop(stream);return {cancelled: true};}
    if (!stream) throw new BridgeError('voice_failed', '语音连接已结束，请重新录制');
    stream.lastSeen = this.now();
    if (action === 'voice.stream.audio') {
      this.receive(stream, p.seq, p.audio);
      if (stream.error) {this.drop(stream);throw stream.error;}
      return {text: stream.text()};
    }
    if (action === 'voice.stream.close') return this.finish(stream, p.seq);
    throw new BridgeError('invalid', '语音操作无效');
  }

  private receive(stream: VoiceStream, seq: unknown, audio: unknown) {
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) throw new BridgeError('invalid', '语音数据序号无效');
    if (typeof audio !== 'string' || audio.length > 4 * Math.ceil(MAX_VOICE_CHUNK_BYTES / 3)) throw new BridgeError('invalid', '语音数据无效');
    if (stream.ended) return;
    if (this.now() - stream.startedAt > MAX_VOICE_SESSION_MS + 30_000) {
      stream.error = new BridgeError('voice_limit', '单次语音输入最长 10 分钟，请分段录制');return;
    }
    const bytes = Buffer.from(audio, 'base64');
    if (bytes.length % 2 || bytes.toString('base64') !== audio) throw new BridgeError('invalid', '语音数据无效');
    // Requests arrive in order on one connection; the sequence number guards against anything else.
    if ((seq as number) < stream.nextSeq || stream.early.size > 64) return;
    stream.early.set(seq as number, bytes);
    for (let next = stream.early.get(stream.nextSeq); next; next = stream.early.get(stream.nextSeq)) {
      stream.early.delete(stream.nextSeq++);
      if (next.length) {stream.received += next.length;this.forward(stream, next);}
    }
  }

  private forward(stream: VoiceStream, bytes: Buffer) {
    const upstream = stream.upstream;
    if (upstream?.open && !upstream.finishing) {upstream.ws.send(bytes);return;}
    stream.queue.push(bytes);stream.queued += bytes.length;
    if (stream.queued > MAX_QUEUED_BYTES) {stream.error = new BridgeError('voice_failed', '电脑连接语音服务太慢，请检查电脑网络后重试');return;}
    if (!upstream) void this.connect(stream);
  }

  /** Connects (again) and sends what was queued meanwhile. A connection ended by the service is reopened once audio follows. */
  private async connect(stream: VoiceStream, rejected?: string): Promise<void> {
    if (stream.upstream || stream.error) return;
    // Holds the place while the token is read, so audio queues instead of opening a second connection.
    const placeholder: Upstream = {ws: undefined as unknown as WebSocket, open: false, finishing: false, opened: new Promise<void>(() => {})};
    stream.upstream = placeholder;
    let token: string;
    try {token = await this.auth.token(rejected);} catch (error) {
      stream.upstream = undefined;stream.error = error instanceof BridgeError ? error : new BridgeError('voice_auth', '无法读取电脑上的 Claude Code 登录');
      stream.onEvent?.('closed');return;
    }
    if (!this.streams.has(stream.id)) {stream.upstream = undefined;return;}
    const query = new URLSearchParams({encoding: 'linear16', sample_rate: String(VOICE_SAMPLE_RATE), channels: '1', endpointing_ms: '300',
      utterance_end_ms: '1000', language: LANGUAGE, use_conversation_engine: 'true'});
    const url = `${this.endpoint}?${query}`, proxy = url.startsWith('wss:') ? proxyFor(url, this.env) : undefined;
    const ws = new WebSocket(url, {headers: {Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT}, handshakeTimeout: OPEN_TIMEOUT_MS,
      ...proxy ? {agent: new TunnelAgent(proxy)} : {}});
    const upstream: Upstream = {ws, open: false, finishing: false, opened: undefined as unknown as Promise<void>};
    upstream.opened = new Promise<void>(resolve => {ws.once('open', () => resolve());ws.once('close', () => resolve());});
    stream.upstream = upstream;
    let refused = false;
    ws.on('unexpected-response', (_request, response) => {
      refused = true;
      const status = response.statusCode ?? 0;
      response.resume();
      if ((status === 401 || status === 403) && !rejected) {
        // An expired or revoked token: renew it once, then give up.
        stream.upstream = undefined;ws.terminate();void this.connect(stream, token);return;
      }
      stream.error = status === 401 || status === 403 ? new BridgeError('voice_auth', 'Claude 语音服务未接受电脑上的登录，请在电脑上重新登录 Claude Code，或切换识别方式')
        : status === 429 ? new BridgeError('voice_limit', 'Claude 语音识别暂时达到限额，请稍后重试或切换识别方式')
        : new BridgeError('voice_failed', '无法连接 Claude 语音服务，请检查电脑网络后重试');
      ws.terminate();
    });
    ws.on('open', () => {
      upstream.open = true;stream.reconnects = 0;
      upstream.keepAlive = setInterval(() => {if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"KeepAlive"}');}, KEEP_ALIVE_MS);
      for (const bytes of stream.queue.splice(0)) ws.send(bytes);
      stream.queued = 0;
    });
    ws.on('message', (data, binary) => {
      if (binary) return;
      let message: Json;
      try {message = JSON.parse(data.toString());} catch {return;}
      if ((message.type === 'TranscriptText' || message.type === 'TranscriptInterim') && typeof message.data === 'string') stream.interim = message.data;
      else if (message.type === 'TranscriptEndpoint') {stream.settle();if (upstream.finishing) {stream.onEvent?.('endpoint');return;}}
      else if (message.type === 'TranscriptError' || message.type === 'error') {
        // Words already heard are kept; a stream that failed before any is reported.
        if (!stream.text()) stream.error = new BridgeError('voice_failed', 'Claude 语音识别失败，请重试或切换识别方式');
        ws.close();
      }
      stream.onEvent?.('message');
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearInterval(upstream.keepAlive);
      if (stream.upstream === upstream) stream.upstream = undefined;
      stream.settle();
      if (!upstream.open && !refused && !stream.error && ++stream.reconnects > MAX_RECONNECTS)
        stream.error = new BridgeError('voice_failed', '无法连接 Claude 语音服务，请检查电脑网络后重试');
      // Audio that arrived while it was closing is sent on a new connection.
      if (!upstream.open && !refused && !stream.error && this.streams.has(stream.id)) setTimeout(() => void this.connect(stream), 500).unref();
      else if (stream.queue.length && !stream.error && this.streams.has(stream.id)) void this.connect(stream);
      stream.onEvent?.('closed');
    });
  }

  /** Waits for every chunk and the service's final text, which may still correct earlier words. */
  private async finish(stream: VoiceStream, count: unknown): Promise<Json> {
    const expected = Number.isSafeInteger(count) ? count as number : stream.nextSeq;
    stream.ended = true;
    try {
      // Stopped before any audio arrived: nothing to wait for.
      if (!stream.received && expected === 0) return {text: ''};
      const deadline = this.now() + FINAL_TIMEOUT_MS * 2;
      const wait = () => new Promise<void>(resolve => {stream.onEvent = () => resolve();setTimeout(resolve, 200).unref();});
      // Connecting (or reconnecting) with audio still to send.
      while (!stream.error && this.now() < deadline && (stream.nextSeq < expected || stream.queue.length || stream.upstream && !stream.upstream.open)) {
        if (stream.upstream && !stream.upstream.open) await Promise.race([stream.upstream.opened, wait()]);
        else await wait();
      }
      const upstream = stream.upstream;
      if (!stream.error && upstream?.open && upstream.ws.readyState === WebSocket.OPEN) {
        upstream.finishing = true;
        upstream.ws.send('{"type":"CloseStream"}');
        await new Promise<void>(resolve => {
          let quiet = setTimeout(resolve, FINAL_QUIET_MS);
          const limit = setTimeout(resolve, FINAL_TIMEOUT_MS);
          stream.onEvent = kind => {
            clearTimeout(quiet);
            if (kind === 'message') {quiet = setTimeout(resolve, FINAL_QUIET_MS);return;}
            clearTimeout(limit);resolve();
          };
        });
      }
      stream.settle();
      const text = stream.text();
      if (stream.error && !text) throw stream.error;
      return {text};
    } finally {this.drop(stream);}
  }

  private drop(stream: VoiceStream) {
    this.streams.delete(stream.id);
    stream.onEvent = undefined;stream.queue = [];stream.queued = 0;
    const upstream = stream.upstream;stream.upstream = undefined;
    if (upstream?.ws) {clearInterval(upstream.keepAlive);try {upstream.ws.terminate();} catch {}}
  }

  /** When the relay connection ends: no phone can finish these streams any more. */
  dropAll() {for (const stream of [...this.streams.values()]) this.drop(stream);}
  close() {clearInterval(this.sweep);this.dropAll();}
}
