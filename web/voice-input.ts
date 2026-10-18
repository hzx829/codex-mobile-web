import {MAX_VOICE_BYTES,MAX_VOICE_DURATION_MS,voiceMimeTypes,type VoiceProvider,type VoiceRecording} from '../src/shared/voice';

export type VoiceState='idle'|'starting'|'recording'|'transcribing';
export interface VoiceInput {start():void;stop():void;cancel():void}
export interface VoiceCallbacks {
  state:(state:VoiceState)=>void;
  text:(text:string)=>void;
  error:(error:Error)=>void;
  keyboard:()=>void;
  transcribe:(recording:VoiceRecording)=>Promise<{text:string}>;
}

export function createVoiceInput(provider:VoiceProvider,callbacks:VoiceCallbacks):VoiceInput {
  if(provider==='keyboard')return {start(){callbacks.keyboard();callbacks.state('idle');},stop(){},cancel(){callbacks.state('idle');}};
  return new CodexVoiceInput(callbacks);
}

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
    }catch(error){
      const name=(error as Error)?.name;
      this.fail(name==='NotAllowedError'?new Error('请允许浏览器使用麦克风，或切换系统键盘')
        :name==='NotFoundError'?new Error('未找到麦克风，请检查设备或切换系统键盘')
        :name==='NotReadableError'?new Error('麦克风无法使用，请关闭其他录音后重试'):error);
    }
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
    this.callbacks.error(error instanceof Error?error:new Error((error as any)?.message||'语音输入失败，请重试'));
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
      const bytes=new Uint8Array(await blob.arrayBuffer()),parts:string[]=[];
      if(this.cancelled)return;
      for(let offset=0;offset<bytes.length;offset+=0x8000)parts.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));
      const result=await this.callbacks.transcribe({audio:btoa(parts.join('')),mimeType,durationMs});
      if(this.cancelled)return;
      if(typeof result?.text!=='string'||!result.text.trim())throw new Error('没有识别到文字，请重新录制');
      this.callbacks.text(result.text.trim());this.cancel();
    }catch(error){this.fail(error);}
  }
}
