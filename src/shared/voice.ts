import type {BridgeService} from './types.js';

/**
 * `claude`: streamed to Claude's dictation service through the computer's Claude Code login;
 * `antigravity`: streamed to the computer's Antigravity desktop Hub;
 * `codex`: one clip sent to ChatGPT's service through Codex's login.
 */
export type VoiceProvider = 'claude' | 'antigravity' | 'codex' | 'keyboard';
export const VOICE_PROVIDERS: readonly VoiceProvider[] = ['claude', 'antigravity', 'codex', 'keyboard'];
export const defaultVoiceProvider = (service: BridgeService): VoiceProvider => service;
export const voiceProvider = (value: unknown, fallback: VoiceProvider = 'claude'): VoiceProvider =>
  value === 'claude' || value === 'antigravity' || value === 'codex' || value === 'keyboard' ? value : fallback;
export const isStreamingVoice = (provider: VoiceProvider) => provider === 'claude' || provider === 'antigravity';
export const voiceProviderLabel = (provider: VoiceProvider) =>
  provider === 'claude' ? 'Claude 识别'
  : provider === 'antigravity' ? 'Antigravity 识别'
  : provider === 'codex' ? 'Codex 识别'
  : '系统键盘';

/** Falls back to an available service when the connected computer does not offer the chosen provider. */
export function resolveVoiceProvider(choice: VoiceProvider, available?: readonly BridgeService[]): VoiceProvider {
  if (choice === 'keyboard' || !available?.length || available.includes(choice)) return choice;
  for (const fallback of ['claude', 'antigravity', 'codex'] as const) {
    if (available.includes(fallback)) return fallback;
  }
  return 'keyboard';
}

export const voiceEngineKey = (service: BridgeService) => `voice-engine:${service}`;

/**
 * Loads one app's saved voice provider. Each app keeps its own setting under `voice-engine:<service>`
 * and defaults to its own native service (`codex` -> Codex, `claude` -> Claude, `antigravity` -> Antigravity).
 * A legacy global choice (`voice-engine` or `voice-provider: keyboard`) is respected until this app is configured.
 */
export function loadVoiceChoice(service: BridgeService, read: (key: string) => unknown): VoiceProvider {
  const own = read(voiceEngineKey(service));
  if (own === 'claude' || own === 'antigravity' || own === 'codex' || own === 'keyboard') return own;
  const legacy = read('voice-engine');
  if (legacy === 'keyboard' || read('voice-provider') === 'keyboard') return 'keyboard';
  if (service !== 'antigravity' && (legacy === 'claude' || legacy === 'codex')) return legacy;
  return defaultVoiceProvider(service);
}

export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
/** The longest Codex recording, sent as one clip after it ends. */
export const MAX_VOICE_DURATION_MS=120_000;
/** How long one streamed dictation may run before it stops by itself. */
export const MAX_VOICE_SESSION_MS=600_000;
export const VOICE_REQUEST_TIMEOUT_MS=120_000;
export const voiceMimeTypes:Record<string,string>={'audio/webm':'webm','audio/mp4':'m4a','audio/ogg':'ogg'};
export interface VoiceRecording {audio:string;mimeType:string;durationMs:number}

/** Streamed dictation audio: 16-bit little-endian mono PCM at this rate, base64 in each request. */
export const VOICE_SAMPLE_RATE=16_000;
/** The most audio one stream request may carry: what piles up on a slow link before it can be sent. */
export const MAX_VOICE_CHUNK_BYTES=VOICE_SAMPLE_RATE*2*15;
/** Chosen by the phone, so audio can follow the opening request without waiting for its answer. */
export const voiceStreamId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,64}$/.test(value)?value:undefined;

/** Joins dictated pieces: a space between Latin words, nothing between Chinese ones. */
export function joinDictation(before:string,text:string){
  if(!before.trim())return text;
  if(!text||/\s$/.test(before))return before+text;
  return before+(/[A-Za-z0-9,.!?;:)\]"']$/.test(before)&&/^[A-Za-z0-9(\["']/.test(text)?' ':'')+text;
}
