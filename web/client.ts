import type { Json, RequestAction } from '../src/shared/types';
import { VOICE_REQUEST_TIMEOUT_MS } from '../src/shared/voice';
export function uuid(){return typeof crypto.randomUUID==='function'?crypto.randomUUID():'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));}
export const operationId=()=>`${Date.now()}:${uuid()}`;
/** A one-time team invite, from a pasted link or code; the relay swaps it for this device's own token. */
export function inviteCode(value:string){const text=value.trim();const match=/[#&?]invite=([\w-]+)/.exec(text);return match?'inv_'+match[1].replace(/^inv_/,''):/^inv_[\w-]+$/.test(text)?text:null;}
/** A short name for this browser, shown in the member's device list. */
export function deviceName(agent=typeof navigator==='undefined'?'':navigator.userAgent){
  const system=/iPhone/.test(agent)?'iPhone':/iPad/.test(agent)?'iPad':/Android/.test(agent)?'Android':/Windows/.test(agent)?'Windows':/Mac OS X/.test(agent)?'Mac':/Linux/.test(agent)?'Linux':'设备';
  const browser=/Edg\//.test(agent)?'Edge':/MicroMessenger/.test(agent)?'微信':/Chrome\//.test(agent)?'Chrome':/Firefox\//.test(agent)?'Firefox':/Safari\//.test(agent)?'Safari':'浏览器';
  return `${system} ${browser}`;
}
export class Client {
  ws:WebSocket|null=null;
  ready=false;
  private stopped=false;
  private retry=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:any)=>void;timer:ReturnType<typeof setTimeout>;receiptTimeout:number}>();
  private previewListeners=new Set<(message:Json)=>void>();
  private watching:{machineId:string;threadId:string}|null=null;
  /** `credential`: called when an invite became this device's token, which replaces it from then on. */
  constructor(private token:string,private receive:(m:Json)=>void,private status:(s:string)=>void,private credential:(token:string)=>void=()=>{}){this.connect();}
  private connect() {
    this.status('connecting');
    const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);this.ws=ws;
    ws.onopen=()=>{const invite=inviteCode(this.token);ws.send(JSON.stringify(invite?{type:'hello',role:'phone',invite,deviceName:deviceName()}:{type:'hello',role:'phone',token:this.token}));};
    ws.onmessage=e=>{
      let m:Json;try{m=JSON.parse(e.data);}catch{return;}
      if(m.type==='ready'){if(typeof m.deviceToken==='string'){this.token=m.deviceToken;this.credential(m.deviceToken);}this.ready=true;this.retry=0;this.sendWatch();this.status('online');}
      if(m.type==='received'){
        const p=this.pending.get(m.id);if(!p)return;
        clearTimeout(p.timer);
        p.timer=setTimeout(()=>{this.pending.delete(m.id);p.reject({code:'timeout',message:'回执超时，请核实操作结果',uncertain:true});},p.receiptTimeout);
        return;
      }
      if(m.type==='response') {
        const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
        if(m.error)p.reject(m.error);else p.resolve(m.result);return;
      }
      if(m.type==='preview.ended'){for(const listener of this.previewListeners)listener(m);return;}
      this.receive(m);
    };
    ws.onclose=e=>{
      this.ready=false;
      for(const listener of this.previewListeners)listener({type:'preview.disconnected'});
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject({code:'offline',message:'连接断开，正在核实操作结果',uncertain:true});}this.pending.clear();
      if(this.stopped)return;
      if(e.code===4401){this.status('auth_error');return;}
      this.status('offline');this.timer=setTimeout(()=>this.connect(),Math.min(15_000,1000*2**this.retry++)+Math.random()*500);
    };
  }
  /** A team request the relay answers itself: members, devices, computers and the activity log. */
  team(action:`team.${string}`,payload:Json={}):Promise<any> {
    if(!this.ready)return Promise.reject({code:'offline',message:'尚未连接中继'});
    return new Promise((resolve,reject)=>{
      const id=uuid();const timer=setTimeout(()=>{this.pending.delete(id);reject({code:'timeout',message:'中继没有回应，请重试'});},20_000);
      this.pending.set(id,{resolve,reject,timer,receiptTimeout:20_000});
      try{this.ws!.send(JSON.stringify({type:'team',id,action,payload}));}
      catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  request(action:RequestAction,payload:Json,machineId:string):Promise<any> {
    if(!this.ready)return Promise.reject({code:'offline',message:'电脑尚未连接'});
    return new Promise((resolve,reject)=>{
      // The timer starts before the browser finishes sending the WebSocket frame.
      // Attachments can spend much of the ordinary 45 seconds on a slow uplink.
      const timeout=action==='voice.transcribe'||action.endsWith('file.uploadChunk')||(action==='turn.send'||action==='claude.send'||action==='claude.create'||action==='antigravity.send'||action==='antigravity.create')&&(payload.images?.length||payload.files?.length)?240_000:45_000;
      const id=uuid();const timer=setTimeout(()=>{this.pending.delete(id);reject({code:'timeout',message:'回执超时，请核实操作结果',uncertain:true});},timeout);
      this.pending.set(id,{resolve,reject,timer,receiptTimeout:action==='voice.transcribe'?VOICE_REQUEST_TIMEOUT_MS+5000:45_000});
      try{this.ws!.send(JSON.stringify({type:'request',id,machineId,action,payload}));}
      catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  /** Tells the relay which thread is open, so its live frames reach this phone. */
  watch(target:{machineId:string;threadId:string}|null){
    if(this.watching?.machineId===target?.machineId&&this.watching?.threadId===target?.threadId)return;
    this.watching=target;if(this.ready)this.sendWatch();
  }
  private sendWatch(){try{this.ws?.send(JSON.stringify({type:'watch',machineId:this.watching?.machineId??null,threadId:this.watching?.threadId??null}));}catch{}}
  onPreview(listener:(message:Json)=>void){this.previewListeners.add(listener);return()=>{this.previewListeners.delete(listener);};}
  close(){this.stopped=true;clearTimeout(this.timer);this.ws?.close();}
}
