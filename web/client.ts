import type { Json, RequestAction } from '../src/shared/types';
export function uuid(){return typeof crypto.randomUUID==='function'?crypto.randomUUID():'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));}
export const operationId=()=>`${Date.now()}:${uuid()}`;
export class Client {
  ws:WebSocket|null=null;
  ready=false;
  private stopped=false;
  private retry=0;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:any)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private token:string,private receive:(m:Json)=>void,private status:(s:string)=>void){this.connect();}
  private connect() {
    this.status('connecting');
    const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);this.ws=ws;
    ws.onopen=()=>ws.send(JSON.stringify({type:'hello',role:'phone',token:this.token}));
    ws.onmessage=e=>{
      let m:Json;try{m=JSON.parse(e.data);}catch{return;}
      if(m.type==='ready'){this.ready=true;this.retry=0;this.status('online');}
      if(m.type==='response') {
        const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
        if(m.error)p.reject(m.error);else p.resolve(m.result);return;
      }
      this.receive(m);
    };
    ws.onclose=e=>{
      this.ready=false;
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject({code:'offline',message:'连接断开，正在核实操作结果',uncertain:true});}this.pending.clear();
      if(this.stopped)return;
      if(e.code===4401){this.status('auth_error');return;}
      this.status('offline');this.timer=setTimeout(()=>this.connect(),Math.min(15_000,1000*2**this.retry++)+Math.random()*500);
    };
  }
  request(action:RequestAction,payload:Json,machineId:string):Promise<any> {
    if(!this.ready)return Promise.reject({code:'offline',message:'电脑尚未连接'});
    return new Promise((resolve,reject)=>{
      const id=uuid();const timer=setTimeout(()=>{this.pending.delete(id);reject({code:'timeout',message:'回执超时，请核实操作结果',uncertain:true});},45_000);
      this.pending.set(id,{resolve,reject,timer});this.ws!.send(JSON.stringify({type:'request',id,machineId,action,payload}));
    });
  }
  close(){this.stopped=true;clearTimeout(this.timer);this.ws?.close();}
}
