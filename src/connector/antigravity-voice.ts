import {join} from 'node:path';
import {BridgeError, type Json} from '../shared/types.js';
import {MAX_VOICE_CHUNK_BYTES, MAX_VOICE_SESSION_MS, VOICE_SAMPLE_RATE, joinDictation, voiceStreamId} from '../shared/voice.js';
import {callHub, openHubStream, type HubMethod, type HubStreamHandle, type HubStreamHandlers, type HubStreamMethod} from './antigravity-hub.js';

const IDLE_MS = 20_000;
const MAX_STREAMS = 4;
const MAX_QUEUED_BYTES = VOICE_SAMPLE_RATE * 2 * 30;
const FINAL_TIMEOUT_MS = 6000;
const FINAL_QUIET_MS = 1500;
const AUDIO_MIME = `audio/pcm;rate=${VOICE_SAMPLE_RATE}`;
const LANGUAGES = ['zh-CN', 'en-US'];

type HubCall = (dir: string, method: HubMethod, body: Json) => Promise<Json>;
type HubStreamOpener = (dir: string, method: HubStreamMethod, body: Json, handlers: HubStreamHandlers) => Promise<HubStreamHandle>;

class AntigravityVoiceStream {
  finals: string[] = [];
  interim = '';
  queue: Buffer[] = [];
  queued = 0;
  sessionId?: string;
  handle?: HubStreamHandle;
  error?: BridgeError;
  nextSeq = 0;
  hubSeq = 0;
  early = new Map<number, Buffer>();
  sending = false;
  received = 0;
  ended = false;
  completed = false;
  lastSeen: number;
  readonly startedAt: number;
  onEvent?: (kind: 'message' | 'complete' | 'closed') => void;
  constructor(readonly id: string, now: number) { this.startedAt = this.lastSeen = now; }
  finalized() { return this.finals.reduce((all, piece) => joinDictation(all, piece), ''); }
  text() { return [...this.finals, this.interim].reduce((all, piece) => joinDictation(all, piece), ''); }
  settle() { if (this.interim) this.finals.push(this.interim); this.interim = ''; }
  applyTranscription(text: string, isFinal: boolean) {
    const clean = text.trim();
    if (!clean) return;
    const prefix = this.finalized();
    if (isFinal) {
      // Handle both cumulative transcripts and per-utterance final segments without duplicating earlier text.
      if (prefix && clean.startsWith(prefix)) this.finals = [clean];
      else this.finals.push(clean);
      this.interim = '';
    } else {
      if (prefix && clean.startsWith(prefix)) this.interim = clean.slice(prefix.length).trimStart();
      else this.interim = clean;
    }
  }
}

/**
 * Streams the phone's 16 kHz PCM audio to the local Antigravity desktop Hub (`StreamAudioTranscription`,
 * `SendAudioChunk`, `EndAudioSession`) using the same `voice.stream.*` protocol as Claude dictation.
 */
export class AntigravityVoiceStreams {
  private streams = new Map<string, AntigravityVoiceStream>();
  private sweep: NodeJS.Timeout;
  private daemonDir: string;
  constructor(
    root: string,
    private hub: HubCall = callHub,
    private openStream: HubStreamOpener = openHubStream,
    private now = Date.now,
  ) {
    this.daemonDir = join(root, 'daemon');
    this.sweep = setInterval(() => {
      for (const stream of this.streams.values()) if (this.now() - stream.lastSeen > IDLE_MS) this.drop(stream);
    }, 5000);
    this.sweep.unref();
  }

  has(id: string) { return this.streams.has(id); }

  async handle(action: string, p: Json): Promise<Json> {
    const id = voiceStreamId(p.id);
    if (!id) throw new BridgeError('invalid', '语音标识无效');
    if (action === 'voice.stream.open') {
      if (this.streams.has(id)) return {id};
      if (this.streams.size >= MAX_STREAMS) {
        const oldest = [...this.streams.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        this.drop(oldest);
      }
      const stream = new AntigravityVoiceStream(id, this.now());
      this.streams.set(id, stream);
      void this.connect(stream);
      return {id};
    }
    const stream = this.streams.get(id);
    if (action === 'voice.stream.cancel') { if (stream) this.drop(stream, true); return {cancelled: true}; }
    if (!stream) throw new BridgeError('voice_failed', '语音连接已结束，请重新录制');
    stream.lastSeen = this.now();
    if (action === 'voice.stream.audio') {
      this.receive(stream, p.seq, p.audio);
      if (stream.error) { this.drop(stream, true); throw stream.error; }
      return {text: stream.text()};
    }
    if (action === 'voice.stream.close') return this.finish(stream, p.seq);
    throw new BridgeError('invalid', '语音操作无效');
  }

  private receive(stream: AntigravityVoiceStream, seq: unknown, audio: unknown) {
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) throw new BridgeError('invalid', '语音数据序号无效');
    if (typeof audio !== 'string' || audio.length > 4 * Math.ceil(MAX_VOICE_CHUNK_BYTES / 3)) throw new BridgeError('invalid', '语音数据无效');
    if (stream.ended) return;
    if (this.now() - stream.startedAt > MAX_VOICE_SESSION_MS + 30_000) {
      stream.error = new BridgeError('voice_limit', '单次语音输入最长 10 分钟，请分段录制');
      return;
    }
    const bytes = Buffer.from(audio, 'base64');
    if (bytes.length % 2 || bytes.toString('base64') !== audio) throw new BridgeError('invalid', '语音数据无效');
    if ((seq as number) < stream.nextSeq || stream.early.size > 64) return;
    stream.early.set(seq as number, bytes);
    for (let next = stream.early.get(stream.nextSeq); next; next = stream.early.get(stream.nextSeq)) {
      stream.early.delete(stream.nextSeq++);
      if (next.length) {
        stream.received += next.length;
        stream.queue.push(next);
        stream.queued += next.length;
        if (stream.queued > MAX_QUEUED_BYTES) {
          stream.error = new BridgeError('voice_failed', '电脑连接 Antigravity 语音服务太慢，请稍后重试');
          return;
        }
        void this.pump(stream);
      }
    }
  }

  private async connect(stream: AntigravityVoiceStream): Promise<void> {
    try {
      const handle = await this.openStream(this.daemonDir, 'StreamAudioTranscription', {
        mimeType: AUDIO_MIME,
        continuous: true,
        languageCodes: LANGUAGES,
      }, {
        onMessage: message => {
          if (!this.streams.has(stream.id)) return;
          if (typeof message.ready?.sessionId === 'string' && message.ready.sessionId) {
            stream.sessionId = message.ready.sessionId;
            void this.pump(stream);
            stream.onEvent?.('message');
          } else if (message.transcription && typeof message.transcription.text === 'string') {
            stream.applyTranscription(message.transcription.text, Boolean(message.transcription.isFinal));
            stream.onEvent?.('message');
          } else if (message.complete !== undefined) {
            stream.completed = true;
            stream.settle();
            stream.onEvent?.('complete');
          }
        },
        onError: error => {
          if (!stream.error && !stream.text()) stream.error = error;
          stream.onEvent?.('closed');
        },
        onEnd: () => {
          stream.settle();
          stream.onEvent?.('closed');
        },
      });
      if (!this.streams.has(stream.id)) { handle.close(); return; }
      stream.handle = handle;
    } catch (error) {
      stream.error = error instanceof BridgeError
        ? error
        : new BridgeError('voice_failed', '无法连接本机 Antigravity 语音服务，请确认桌面正在运行或切换识别方式');
      stream.onEvent?.('closed');
    }
  }

  private async pump(stream: AntigravityVoiceStream): Promise<void> {
    if (stream.sending || !stream.sessionId || stream.error) return;
    stream.sending = true;
    try {
      while (stream.queue.length && stream.sessionId && !stream.error && this.streams.has(stream.id)) {
        const chunk = stream.queue.shift()!;
        stream.queued -= chunk.length;
        const sequenceNumber = stream.hubSeq++;
        await this.hub(this.daemonDir, 'SendAudioChunk', {
          sessionId: stream.sessionId,
          data: chunk.toString('base64'),
          sequenceNumber,
        });
      }
    } catch (error) {
      if (!stream.error && !stream.text()) {
        stream.error = error instanceof BridgeError ? error : new BridgeError('voice_failed', '发送语音到 Antigravity 失败，请重试');
      }
    } finally {
      stream.sending = false;
      stream.onEvent?.('message');
    }
  }

  private async finish(stream: AntigravityVoiceStream, count: unknown): Promise<Json> {
    const expected = Number.isSafeInteger(count) ? count as number : stream.nextSeq;
    stream.ended = true;
    try {
      if (!stream.received && expected === 0) return {text: ''};
      const deadline = this.now() + FINAL_TIMEOUT_MS * 2;
      const wait = () => new Promise<void>(resolve => { stream.onEvent = () => resolve(); setTimeout(resolve, 150).unref(); });
      while (!stream.error && !stream.completed && this.now() < deadline &&
             (stream.nextSeq < expected || !stream.sessionId || stream.queue.length > 0 || stream.sending)) {
        if (stream.sessionId && stream.queue.length > 0 && !stream.sending) void this.pump(stream);
        await wait();
      }
      if (!stream.error && stream.sessionId && !stream.completed) {
        const lastSequenceNumber = Math.max(0, stream.hubSeq - 1);
        await this.hub(this.daemonDir, 'EndAudioSession', {sessionId: stream.sessionId, lastSequenceNumber}).catch(() => {});
        if (!stream.completed) {
          await new Promise<void>(resolve => {
            let quiet = setTimeout(resolve, FINAL_QUIET_MS);
            const limit = setTimeout(resolve, FINAL_TIMEOUT_MS);
            stream.onEvent = kind => {
              clearTimeout(quiet);
              if (kind === 'message') { quiet = setTimeout(resolve, FINAL_QUIET_MS); return; }
              clearTimeout(limit); resolve();
            };
          });
        }
      }
      stream.settle();
      const text = stream.text();
      if (stream.error && !text) throw stream.error;
      return {text};
    } finally { this.drop(stream); }
  }

  private drop(stream: AntigravityVoiceStream, endRemote = false) {
    this.streams.delete(stream.id);
    stream.onEvent = undefined;
    stream.queue = [];
    stream.queued = 0;
    const sessionId = stream.sessionId;
    stream.sessionId = undefined;
    if (endRemote && sessionId && !stream.completed) {
      void this.hub(this.daemonDir, 'EndAudioSession', {sessionId, lastSequenceNumber: Math.max(0, stream.hubSeq - 1)}).catch(() => {});
    }
    const handle = stream.handle;
    stream.handle = undefined;
    handle?.close();
  }

  dropAll() { for (const stream of [...this.streams.values()]) this.drop(stream, true); }
  close() { clearInterval(this.sweep); this.dropAll(); }
}
