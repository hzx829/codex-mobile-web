/** `claude`: streamed to Claude's dictation service through the computer's Claude Code login; `codex`: one clip sent to ChatGPT's. */
export type VoiceProvider = 'claude' | 'codex' | 'keyboard';
export const voiceProvider=(value:unknown):VoiceProvider=>value==='keyboard'||value==='codex'?value:'claude';
export const voiceProviderLabel=(provider:VoiceProvider)=>provider==='claude'?'Claude 识别':provider==='codex'?'Codex 识别':'系统键盘';
export const MAX_VOICE_BYTES=8*1024*1024;
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
