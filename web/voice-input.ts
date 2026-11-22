import {MAX_VOICE_BYTES,MAX_VOICE_SESSION_MS,voiceMimeTypes,type VoiceProvider,type VoiceRecording} from '../src/shared/voice';

export type VoiceState='idle'|'starting'|'recording'|'transcribing';
export interface VoiceInput {start():void;stop():void;cancel():void}
export interface VoiceCallbacks {
  state:(state:VoiceState)=>void;
  /** The next piece of dictated text, in spoken order; called after each pause while recording continues. */
  text:(text:string)=>void;
  error:(error:Error)=>void;
  keyboard:()=>void;
  transcribe:(recording:VoiceRecording)=>Promise<{text:string}>;
}

/** A pause this long ends a segment, which is transcribed while recording goes on. */
const PAUSE_MS=700;
const MIN_SEGMENT_MS=1500;
/** Speech without a pause is cut here, so text still appears. */
const MAX_SEGMENT_MS=20_000;
/** Segment length when the browser gives no usable audio level to find pauses with. */
const BLIND_SEGMENT_MS=8000;
const METER_MS=100;

/** Joins dictated pieces: a space between Latin words, nothing between Chinese ones. */
export function joinDictation(before:string,text:string){
  if(!before.trim())return text;
  if(!text||/\s$/.test(before))return before+text;
  return before+(/[A-Za-z0-9,.!?;:)\]"']$/.test(before)&&/^[A-Za-z0-9(\["']/.test(text)?' ':'')+text;
}

export function createVoiceInput(provider:VoiceProvider,callbacks:VoiceCallbacks):VoiceInput {
  if(provider==='keyboard')return {start(){callbacks.keyboard();callbacks.state('idle');},stop(){},cancel(){callbacks.state('idle');}};
  return new CodexVoiceInput(callbacks);
}

type Segment={recorder:MediaRecorder;chunks:Blob[];bytes:number;startedAt:number;durationMs:number;heard:boolean;last:boolean};

/**
 * Records until stopped, cutting the audio at pauses. Each segment is transcribed as soon as it ends
 * and its text is handed over in spoken order, so the draft fills in while the person is still talking.
 */
class CodexVoiceInput implements VoiceInput {
  private cancelled=false;
  private started=false;
  private stopping=false;
  private stream?:MediaStream;
  private mimeType='';
  private segment?:Segment;
  private audio?:AudioContext;
  private analyser?:AnalyserNode;
  private samples?:Uint8Array<ArrayBuffer>;
  private floor=0.005;
  private quietSince=0;
  private meter?:ReturnType<typeof setInterval>;
  private timer?:ReturnType<typeof setTimeout>;
  /** One entry per uploaded segment, filled when its transcript arrives; `next` is the first not yet handed over. */
  private results:(string|undefined)[]=[];
  private next=0;
  private pending=0;
  private closed=false;
  private gotText=false;
  constructor(private callbacks:VoiceCallbacks){}
  start(){
    if(this.started||this.cancelled)return;
    this.started=true;
    // Created inside the tap: iOS leaves an audio context made later suspended.
    try{const Context=globalThis.AudioContext||(globalThis as any).webkitAudioContext;if(Context)this.audio=new Context();}catch{/* Pauses are then not detected; segments are cut by time. */}
    void this.capture();
  }
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
      this.stream=stream;this.mimeType=mimeType;
      stream.getTracks().forEach(track=>{track.onended=()=>this.fail(new Error('录音被中断，请重新录制'));});
      this.listen(stream);
      this.begin();
      this.meter=setInterval(()=>this.measure(),METER_MS);
      this.timer=setTimeout(()=>this.stop(),MAX_VOICE_SESSION_MS);
      this.callbacks.state('recording');
    }catch(error){
      const name=(error as Error)?.name;
      this.fail(name==='NotAllowedError'?new Error('请允许浏览器使用麦克风，或切换系统键盘')
        :name==='NotFoundError'?new Error('未找到麦克风，请检查设备或切换系统键盘')
        :name==='NotReadableError'?new Error('麦克风无法使用，请关闭其他录音后重试'):error);
    }
  }
  private listen(stream:MediaStream){
    if(!this.audio)return;
    try{
      const analyser=this.audio.createAnalyser();analyser.fftSize=1024;
      this.audio.createMediaStreamSource(stream).connect(analyser);
      this.analyser=analyser;this.samples=new Uint8Array(analyser.fftSize);
      void this.audio.resume?.().catch(()=>{});
    }catch{this.analyser=undefined;}
  }
  /** Whether the audio level can be read. Without it every segment counts as speech. */
  private metered(){return Boolean(this.analyser&&this.samples&&this.audio?.state==='running');}
  /** Whether the microphone is picking up speech now; undefined when the level cannot be read. */
  private loud(){
    if(!this.metered()||!this.analyser||!this.samples)return undefined;
    this.analyser.getByteTimeDomainData(this.samples);
    let sum=0;for(const sample of this.samples){const value=(sample-128)/128;sum+=value*value;}
    const level=Math.sqrt(sum/this.samples.length),loud=level>Math.max(0.015,this.floor*2.5);
    if(!loud)this.floor=this.floor*0.9+level*0.1;
    return loud;
  }
  private measure(){
    const segment=this.segment;if(this.cancelled||this.stopping||!segment)return;
    const now=Date.now(),age=now-segment.startedAt,loud=this.loud();
    if(loud===undefined){segment.heard=true;if(age>=BLIND_SEGMENT_MS)this.cut(false);return;}
    if(loud){segment.heard=true;this.quietSince=0;}else this.quietSince||=now;
    const paused=segment.heard&&this.quietSince>0&&now-this.quietSince>=PAUSE_MS&&age>=MIN_SEGMENT_MS;
    // A silent segment is dropped when it ends, so restarting it only keeps it short.
    if(paused||age>=MAX_SEGMENT_MS)this.cut(false);
  }
  private begin(){
    const recorder=new MediaRecorder(this.stream!,{mimeType:this.mimeType,audioBitsPerSecond:64_000});
    const segment:Segment={recorder,chunks:[],bytes:0,startedAt:Date.now(),durationMs:0,heard:!this.metered(),last:false};
    this.segment=segment;this.quietSince=0;
    recorder.ondataavailable=event=>{
      if(this.cancelled)return;
      segment.bytes+=event.data.size;
      if(segment.bytes>MAX_VOICE_BYTES){this.fail(new Error('录音超过 8 MiB，请缩短后重试'));return;}
      segment.chunks.push(event.data);
    };
    recorder.onerror=()=>this.fail(new Error('录音失败，请重试或切换系统键盘'));
    recorder.onstop=()=>void this.finish(segment);
    recorder.start(1000);
  }
  /** Ends the current segment and, unless it is the last, starts the next on the same microphone. */
  private cut(last:boolean){
    const segment=this.segment;if(!segment||segment.recorder.state==='inactive')return;
    segment.durationMs=Math.max(1,Date.now()-segment.startedAt);segment.last=last;
    try{segment.recorder.stop();if(!last)this.begin();}catch(error){this.fail(error);}
  }
  stop(){
    if(this.cancelled||this.stopping||!this.segment)return;
    this.stopping=true;this.stopTimers();
    this.callbacks.state('transcribing');
    this.cut(true);
    if(!this.cancelled)this.stopTracks();
  }
  cancel(){
    if(this.cancelled)return;
    this.cancelled=true;this.release();this.callbacks.state('idle');
  }
  private stopTimers(){clearTimeout(this.timer);clearInterval(this.meter);}
  private stopTracks(){
    this.stream?.getTracks().forEach(track=>{track.onended=null;track.stop();});this.stream=undefined;
    const audio=this.audio;this.audio=undefined;this.analyser=undefined;
    if(audio&&audio.state!=='closed')void audio.close().catch(()=>{});
  }
  private release(){
    this.stopTimers();
    const recorder=this.segment?.recorder;this.segment=undefined;
    if(recorder){
      recorder.ondataavailable=null;recorder.onerror=null;recorder.onstop=null;
      try{if(recorder.state!=='inactive')recorder.stop();}catch{/* Always release the microphone, even after a recorder failure. */}
    }
    this.stopTracks();
  }
  private fail(error:unknown){
    if(this.cancelled)return;
    this.callbacks.error(error instanceof Error?error:new Error((error as any)?.message||'语音输入失败，请重试'));
    this.cancel();
  }
  private async finish(segment:Segment){
    if(this.cancelled)return;
    if(segment.last)this.closed=true;
    const mimeType=(segment.recorder.mimeType||this.mimeType).split(';')[0].trim().toLowerCase();
    const blob=new Blob(segment.chunks,{type:mimeType});segment.chunks=[];
    // Silence is not uploaded: it costs a request and comes back as invented words.
    if(!blob.size||!segment.heard){this.settle();return;}
    const index=this.results.length;this.results.push(undefined);this.pending++;
    try{
      if(!Object.hasOwn(voiceMimeTypes,mimeType))throw new Error('当前浏览器的录音格式不支持，请切换系统键盘');
      const bytes=new Uint8Array(await blob.arrayBuffer()),parts:string[]=[];
      if(this.cancelled)return;
      for(let offset=0;offset<bytes.length;offset+=0x8000)parts.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));
      let text='';
      try{
        const result=await this.callbacks.transcribe({audio:btoa(parts.join('')),mimeType,durationMs:segment.durationMs});
        if(typeof result?.text==='string')text=result.text.trim();
      }catch(error){
        // One segment without words (a cough, background noise) does not end the dictation.
        if((error as any)?.code!=='voice_empty')throw error;
      }
      if(this.cancelled)return;
      this.results[index]=text;this.pending--;
      this.deliver();this.settle();
    }catch(error){this.fail(error);}
  }
  /** Hands over every transcript that has arrived and has nothing earlier still outstanding. */
  private deliver(){
    let text='';
    for(;this.next<this.results.length;this.next++){
      const ready=this.results[this.next];if(ready===undefined)break;
      text=joinDictation(text,ready);
    }
    if(text){this.gotText=true;this.callbacks.text(text);}
  }
  private settle(){
    if(this.cancelled||!this.closed||this.pending)return;
    if(this.gotText)this.cancel();
    else this.fail(new Error(this.results.length?'没有识别到文字，请重新录制':'没有录到声音，请重新录制'));
  }
}
