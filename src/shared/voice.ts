export type VoiceProvider = 'codex' | 'keyboard';
export const voiceProvider=(value:unknown):VoiceProvider=>value==='keyboard'?'keyboard':'codex';
export const voiceProviderLabel=(provider:VoiceProvider)=>provider==='codex'?'Codex 识别':'系统键盘';
export const MAX_VOICE_BYTES=8*1024*1024;
/** The longest single upload; dictation is cut at pauses into uploads far shorter than this. */
export const MAX_VOICE_DURATION_MS=120_000;
/** How long one dictation may run before it stops by itself. */
export const MAX_VOICE_SESSION_MS=600_000;
export const VOICE_REQUEST_TIMEOUT_MS=120_000;
export const voiceMimeTypes:Record<string,string>={'audio/webm':'webm','audio/mp4':'m4a','audio/ogg':'ogg'};
export interface VoiceRecording {audio:string;mimeType:string;durationMs:number}
