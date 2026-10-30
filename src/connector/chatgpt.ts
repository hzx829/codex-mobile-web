import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {WebSocket, WebSocketServer} from 'ws';
import {BridgeError, type Json} from '../shared/types.js';
import {Ledger} from './ledger.js';

export function browserPairing(dataDir:string, port=3342){
  mkdirSync(dataDir,{recursive:true});
  const path=join(dataDir,'chatgpt-pairing.json');
  let token:string;
  try{token=JSON.parse(readFileSync(path,'utf8')).token;if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid ChatGPT pairing file');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=randomBytes(32).toString('hex');}
  const pairing={url:`ws://127.0.0.1:${port}/chatgpt`,token};
  writeFileSync(path,JSON.stringify(pairing)+'\n',{mode:0o600});
  return pairing;
}

export class ChatGPTBridge {
  private server:WebSocketServer;
  private socket?:WebSocket;
  private failure='';
  private pending?:{id:string;resolve:(value:Json)=>void;reject:(error:BridgeError)=>void;timer:NodeJS.Timeout;mutation:boolean};
  private ledger:Ledger;
  private maintenanceUntil=0;
  readonly ready:Promise<void>;
  constructor(dataDir:string,port=3342){
    const pairing=browserPairing(dataDir,port);
    this.ledger=new Ledger(join(dataDir,'chatgpt-operations.sqlite'));
    this.server=new WebSocketServer({host:'127.0.0.1',port,path:'/chatgpt',maxPayload:4*1024*1024});
    this.ready=new Promise(resolve=>{this.server.once('listening',resolve);this.server.once('error',error=>{this.failure=error.message;resolve();});});
    this.server.on('error',()=>{});
    this.server.on('connection',(ws,req)=>{
      // Only the locally paired browser extension may attach; web pages cannot.
      if(!/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||'')){ws.close(4403);return;}
      let authenticated=false,alive=true;
      const auth=setTimeout(()=>ws.terminate(),5000);
      const pulse=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},20_000);
      ws.on('pong',()=>{alive=true;});
      ws.on('error',()=>{});
      ws.on('message',data=>{
        let message:Json;try{message=JSON.parse(data.toString());}catch{ws.close(4400);return;}
        if(!authenticated){
          const supplied=Buffer.from(typeof message.token==='string'?message.token:'');
          const expected=Buffer.from(pairing.token);
          if(message.type!=='hello'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){ws.close(4401);return;}
          if(this.socket){ws.close(4409);return;}
          authenticated=true;clearTimeout(auth);this.socket=ws;ws.send(JSON.stringify({type:'ready'}));return;
        }
        if(message.type==='ping'){ws.send(JSON.stringify({type:'pong'}));return;}
        const pending=this.pending;
        if(message.type!=='response'||!pending||message.id!==pending.id)return;
        this.pending=undefined;clearTimeout(pending.timer);
        if(message.error)pending.reject(new BridgeError(String(message.error.code||'browser_error'),String(message.error.message||'浏览器操作失败'),Boolean(message.error.uncertain)));
        else if(!message.result||typeof message.result!=='object')pending.reject(new BridgeError('protocol','浏览器响应格式无效',pending.mutation));
        else pending.resolve(message.result);
      });
      ws.on('close',()=>{
        clearTimeout(auth);clearInterval(pulse);
        if(this.socket!==ws)return;this.socket=undefined;
        if(this.pending){const pending=this.pending;this.pending=undefined;clearTimeout(pending.timer);pending.reject(new BridgeError('browser_offline','ChatGPT 浏览器桥接已断开，请核实聊天内容',pending.mutation));}
      });
    });
  }
  get busy(){return Boolean(this.pending);}
  prepareReload(){if(this.busy)throw new BridgeError('active','ChatGPT 浏览器正在处理操作，请稍后更新');this.maintenanceUntil=Date.now()+60_000;}
  private request(action:string,payload:Json={}):Promise<Json>{
    if(Date.now()<this.maintenanceUntil)throw new BridgeError('active','连接器正在更新，请稍后重试');
    if(!this.socket||this.socket.readyState!==WebSocket.OPEN)throw new BridgeError('browser_offline','请在电脑浏览器的扩展中连接 ChatGPT 页面');
    if(this.pending)throw new BridgeError('active','ChatGPT 页面正在处理另一项操作，请稍后重试');
    const socket=this.socket,id=randomUUID(),mutation=action==='send'||action==='stop';
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending=undefined;socket.terminate();
        reject(new BridgeError('timeout','ChatGPT 页面响应超时，请刷新核实；不会自动重发',mutation));
      },30_000);
      this.pending={id,resolve,reject,timer,mutation};
      socket.send(JSON.stringify({type:'request',id,action,payload}));
    });
  }
  async handle(action:string,payload:Json={}):Promise<Json>{
    if(action==='chatgpt.operation')return this.ledger.read(String(payload.opId||''));
    if(action==='chatgpt.status'){
      if(!this.socket)return {connected:false,notice:this.failure?'浏览器桥接监听失败，请检查本地 3342 端口':'请安装本地扩展，并连接已登录的 ChatGPT 页面'};
      return {connected:true,...await this.request('status')};
    }
    if(action==='chatgpt.list')return this.request('list',{more:payload.more===true});
    if(!['chatgpt.read','chatgpt.send','chatgpt.stop'].includes(action))throw new BridgeError('invalid','未知 ChatGPT 操作');
    const conversationId=payload.conversationId;
    if(typeof conversationId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversationId))throw new BridgeError('invalid','ChatGPT 聊天 ID 无效');
    if(action==='chatgpt.read')return this.request('read',{conversationId});
    const text=payload.text;
    if(action==='chatgpt.send'&&(typeof text!=='string'||!text.trim()||text.length>50_000||text.includes('\0')))throw new BridgeError('invalid','消息为空或超过 50,000 字符');
    const input={conversationId,...(action==='chatgpt.send'?{text}:{}),opId:payload.opId};
    return this.ledger.run(payload.opId,{action,...input},()=>this.request(action.slice(8),input));
  }
  close(){for(const ws of this.server.clients)ws.terminate();this.server.close();this.ledger.close();}
}
