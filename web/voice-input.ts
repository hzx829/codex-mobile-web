import type {Json} from '../src/shared/types';
import {MAX_VOICE_BYTES,MAX_VOICE_CHUNK_BYTES,MAX_VOICE_DURATION_MS,MAX_VOICE_SESSION_MS,joinDictation,voiceMimeTypes,type VoiceProvider,type VoiceRecording} from '../src/shared/voice';
export {joinDictation};

export type VoiceState='idle'|'starting'|'recording'|'transcribing';
export interface VoiceInput {start():void;stop():void;cancel():void}
export type VoiceStreamAction='voice.stream.open'|'voice.stream.audio'|'voice.stream.close'|'voice.stream.cancel';
export interface VoiceCallbacks {
  state:(state:VoiceState)=>void;
  /** A finished piece of text to add to the draft (Codex: the whole recording). */
  text:(text:string)=>void;
  /** Everything heard so far in this dictation; each call replaces the previous one (Claude). */
  live:(text:string)=>void;
  error:(error:Error)=>void;
  keyboard:()=>void;
  transcribe:(recording:VoiceRecording)=>Promise<{text:string}>;
  stream:(action:VoiceStreamAction,payload:Json)=>Promise<any>;
}

export function createVoiceInput(provider:VoiceProvider,callbacks:VoiceCallbacks):VoiceInput {
  if(provider==='keyboard')return {start(){callbacks.keyboard();callbacks.state('idle');},stop(){},cancel(){callbacks.state('idle');}};
  return provider==='claude'?new ClaudeVoiceInput(callbacks):new CodexVoiceInput(callbacks);
}

/**
 * Where streamed text sits in the draft. `owned` is the text this dictation last wrote at the end of the
 * draft, standing for the transcript after `anchor`. Once the person edits it, what they wrote stays theirs
 * and only words heard afterwards are added.
 */
export type DictationSpan={anchor:string;owned:string;text:string}|null;
export function applyDictation(draft:string,span:DictationSpan,text:string):{draft:string;span:DictationSpan}{
  if(!text)return {draft,span};
  if(!span)return {draft:joinDictation(draft,text),span:{anchor:'',owned:text,text}};
  let {anchor,owned}=span;
  if(owned&&!draft.endsWith(owned)){anchor=span.text;owned='';}
  // The service may still correct words the person has since taken over; theirs win.
  if(!text.startsWith(anchor))return {draft,span:{anchor,owned,text:span.text}};
  const next=text.slice(anchor.length);
  return {draft:draft.slice(0,draft.length-owned.length)+next,span:{anchor,owned:next,text}};
}

function microphoneError(error:unknown){
  const name=(error as Error)?.name;
  return name==='NotAllowedError'?new Error('请允许浏览器使用麦克风，或切换系统键盘')
    :name==='NotFoundError'?new Error('未找到麦克风，请检查设备或切换系统键盘')
    :name==='NotReadableError'?new Error('麦克风无法使用，请关闭其他录音后重试'):error;
}
const asError=(error:unknown)=>error instanceof Error?error:new Error((error as any)?.message||'语音输入失败，请重试');
function base64(bytes:Uint8Array){
  const parts:string[]=[];
  for(let offset=0;offset<bytes.length;offset+=0x8000)parts.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));
  return btoa(parts.join(''));
}
const streamId=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');

/** How often captured audio is sent, and how many sends may wait for an answer before audio is gathered into the next. */
const SEND_MS=200;
const MAX_IN_FLIGHT=4;

/**
 * Streams the microphone to Claude's dictation service through the computer: 16 kHz PCM every 200 ms,
 * each answer carrying the text so far, which replaces what this dictation put in the draft. On the tick
 * the service finishes the text, which may still correct earlier words.
 */
class ClaudeVoiceInput implements VoiceInput {
  private cancelled=false;
  private started=false;
  private stopping=false;
  private finished=false;
  private opened=false;
  private readonly id=streamId();
  private stream?:MediaStream;
  private audio?:AudioContext;
  private worklet?:AudioWorkletNode;
  private pending:Uint8Array[]=[];
  private pendingBytes=0;
  private seq=0;
  private inFlight=0;
  private shownSeq=-1;
  private shown='';
  private sender?:ReturnType<typeof setInterval>;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private callbacks:VoiceCallbacks){}
  start(){
    if(this.started||this.cancelled)return;
    this.started=true;
    // Created inside the tap: iOS leaves an audio context made later suspended.
    try{const Context=globalThis.AudioContext||(globalThis as any).webkitAudioContext;if(Context){this.audio=new Context();void this.audio!.resume?.().catch(()=>{});}}catch{}
    void this.capture();
  }
  private async capture(){
    this.callbacks.state('starting');
    try{
      if(!globalThis.isSecureContext)throw new Error('网页录音需要 HTTPS，请使用 HTTPS 地址或切换系统键盘');
      if(!navigator.mediaDevices?.getUserMedia||!this.audio?.audioWorklet)throw new Error('当前浏览器不支持边说边识别，请在语音设置切换识别方式');
      // The computer connects to the service while the microphone is being granted.
      this.opened=true;
      this.callbacks.stream('voice.stream.open',{id:this.id}).catch(error=>this.fail(error?.code==='unsupported'
        ?new Error('电脑上的连接器版本较旧，不支持 Claude 识别，请更新连接器或在语音设置切换识别方式'):error));
      const [stream]=await Promise.all([navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}}),this.audio.audioWorklet.addModule('/pcm-worklet.js')]);
      // A permission prompt may outlive navigation, cancellation, or a provider change.
      if(this.cancelled){stream.getTracks().forEach(track=>track.stop());return;}
      this.stream=stream;
      stream.getTracks().forEach(track=>{track.onended=()=>this.fail(new Error('录音被中断，请重新录制'));});
      const worklet=new AudioWorkletNode(this.audio,'pcm-16k',{numberOfInputs:1,numberOfOutputs:1,channelCount:1});this.worklet=worklet;
      worklet.port.onmessage=event=>{if(event.data instanceof ArrayBuffer&&!this.cancelled){this.pending.push(new Uint8Array(event.data));this.pendingBytes+=event.data.byteLength;}};
      // Silent output keeps the node in the rendered graph on every browser.
      const mute=this.audio.createGain();mute.gain.value=0;
      this.audio.createMediaStreamSource(stream).connect(worklet);worklet.connect(mute);mute.connect(this.audio.destination);
      await this.audio.resume?.();
      if(this.cancelled)return;
      this.sender=setInterval(()=>this.send(),SEND_MS);
      this.timer=setTimeout(()=>this.stop(),MAX_VOICE_SESSION_MS);
      this.callbacks.state('recording');
    }catch(error){this.fail(microphoneError(error));}
  }
  /** Sends what was captured since the last send; `force` at the end, whatever is still waiting. */
  private send(force=false){
    if(this.cancelled||!this.pendingBytes||!force&&this.inFlight>=MAX_IN_FLIGHT)return;
    if(this.pendingBytes>MAX_VOICE_CHUNK_BYTES){this.fail(new Error('网络太慢，语音没能及时发出，请稍后重试'));return;}
    const bytes=new Uint8Array(this.pendingBytes);let offset=0;
    for(const piece of this.pending){bytes.set(piece,offset);offset+=piece.length;}
    this.pending=[];this.pendingBytes=0;
    const seq=this.seq++;this.inFlight++;
    this.callbacks.stream('voice.stream.audio',{id:this.id,seq,audio:base64(bytes)}).then(result=>{
      this.inFlight--;
      if(this.cancelled||this.finished||seq<this.shownSeq||typeof result?.text!=='string')return;
      this.shownSeq=seq;this.show(result.text);
    },error=>{this.inFlight--;this.fail(error);});
  }
  private show(text:string){if(text&&text!==this.shown){this.shown=text;this.callbacks.live(text);}}
  stop(){
    if(this.cancelled||this.stopping||!this.worklet)return;
    this.stopping=true;clearInterval(this.sender);clearTimeout(this.timer);
    this.callbacks.state('transcribing');
    void this.finish();
  }
  private async finish(){
    try{
      // The last few milliseconds are still in the worklet.
      const worklet=this.worklet!;
      await new Promise<void>(resolve=>{
        const done=setTimeout(resolve,300);
        worklet.port.addEventListener('message',event=>{if(event.data==='flushed'){clearTimeout(done);resolve();}});
        worklet.port.postMessage('flush');
      });
      this.releaseCapture();
      if(this.cancelled)return;
      this.send(true);
      const result=await this.callbacks.stream('voice.stream.close',{id:this.id,seq:this.seq});
      if(this.cancelled)return;
      this.finished=true;
      if(typeof result?.text==='string')this.show(result.text);
      if(!this.shown)throw new Error(this.seq?'没有识别到文字，请重新录制':'没有录到声音，请重新录制');
      this.cancel(false);
    }catch(error){this.fail(error);}
  }
  cancel(notify=true){
    if(this.cancelled)return;
    this.cancelled=true;clearInterval(this.sender);clearTimeout(this.timer);this.releaseCapture();
    // Tells the computer to drop its connection now rather than when it goes quiet.
    if(notify&&this.opened&&!this.finished)this.callbacks.stream('voice.stream.cancel',{id:this.id}).catch(()=>{});
    this.callbacks.state('idle');
  }
  private releaseCapture(){
    this.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});this.stream=undefined;
    if(this.worklet){this.worklet.port.onmessage=null;try{this.worklet.disconnect();}catch{}}
    const audio=this.audio;this.audio=undefined;
    if(audio&&audio.state!=='closed')void audio.close().catch(()=>{});
  }
  private fail(error:unknown){
    if(this.cancelled)return;
    this.callbacks.error(asError(error));
    this.cancel();
  }
}

/** Records one clip until stopped, then sends it whole: Codex's service hears the full context at once. */
class CodexVoiceInput implements VoiceInput {
  private cancelled=false;
  private started=false;
  private stream?:MediaStream;
  private recorder?:MediaRecorder;
  private chunks:Blob[]=[];
  private bytes=0;
  private startedAt=0;
  private durationMs=0;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private callbacks:VoiceCallbacks){}
  start(){if(this.started||this.cancelled)return;this.started=true;void this.capture();}
  private async capture(){
    this.callbacks.state('starting');
    try{
      if(!globalThis.isSecureContext)throw new Error('网页录音需要 HTTPS，请使用 HTTPS 地址或切换系统键盘');
      if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined')throw new Error('当前浏览器不支持网页录音，请切换系统键盘');
      const mimeType=['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType)throw new Error('当前浏览器没有可用的录音格式，请切换系统键盘');
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      // A permission prompt may outlive navigation, cancellation, or a provider change.
      if(this.cancelled){stream.getTracks().forEach(track=>track.stop());return;}
      this.stream=stream;
      stream.getTracks().forEach(track=>{track.onended=()=>this.fail(new Error('录音被中断，请重新录制'));});
      const recorder=new MediaRecorder(stream,{mimeType,audioBitsPerSecond:64_000});this.recorder=recorder;
      recorder.ondataavailable=event=>{
        if(this.cancelled)return;
        this.bytes+=event.data.size;
        if(this.bytes>MAX_VOICE_BYTES){this.fail(new Error('录音超过 8 MiB，请缩短后重试'));return;}
        this.chunks.push(event.data);
      };
      recorder.onerror=()=>this.fail(new Error('录音失败，请重试或切换系统键盘'));
      recorder.onstop=()=>void this.finish(recorder.mimeType||mimeType);
      recorder.start(1000);this.startedAt=Date.now();
      this.timer=setTimeout(()=>this.stop(),MAX_VOICE_DURATION_MS);
      this.callbacks.state('recording');
    }catch(error){this.fail(microphoneError(error));}
  }
  stop(){
    if(this.cancelled||!this.recorder||this.recorder.state==='inactive')return;
    this.durationMs=Math.max(1,Date.now()-this.startedAt);clearTimeout(this.timer);
    this.callbacks.state('transcribing');
    try{this.recorder.stop();this.stopTracks();}catch(error){this.fail(error);}
  }
  cancel(){
    if(this.cancelled)return;
    this.cancelled=true;this.release();this.chunks=[];this.callbacks.state('idle');
  }
  private stopTracks(){this.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});this.stream=undefined;}
  private release(){
    clearTimeout(this.timer);
    if(this.recorder){
      this.recorder.ondataavailable=null;this.recorder.onerror=null;this.recorder.onstop=null;
      try{if(this.recorder.state!=='inactive')this.recorder.stop();}catch{/* Always release the microphone, even after a recorder failure. */}
      this.recorder=undefined;
    }
    this.stopTracks();
  }
  private fail(error:unknown){
    if(this.cancelled)return;
    this.callbacks.error(asError(error));
    this.cancel();
  }
  private async finish(type:string){
    if(this.cancelled)return;
    const mimeType=type.split(';')[0].trim().toLowerCase(),durationMs=this.durationMs||Math.max(1,Date.now()-this.startedAt);
    const blob=new Blob(this.chunks,{type:mimeType});this.chunks=[];this.release();
    this.callbacks.state('transcribing');
    try{
      if(!Object.hasOwn(voiceMimeTypes,mimeType))throw new Error('当前浏览器的录音格式不支持，请切换系统键盘');
      if(!blob.size)throw new Error('没有录到声音，请重新录制');
      if(durationMs>MAX_VOICE_DURATION_MS+2000)throw new Error('录音不能超过 2 分钟，请重新录制');
      const bytes=new Uint8Array(await blob.arrayBuffer());
      if(this.cancelled)return;
      const result=await this.callbacks.transcribe({audio:base64(bytes),mimeType,durationMs});
      if(this.cancelled)return;
      if(typeof result?.text!=='string'||!result.text.trim())throw new Error('没有识别到文字，请重新录制');
      this.callbacks.text(result.text.trim());this.cancel();
    }catch(error){this.fail(error);}
  }
}
