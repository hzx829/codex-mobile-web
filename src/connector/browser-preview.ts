import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {BridgeError, type Json} from '../shared/types.js';

type Pending={resolve:(value:Json)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout};
type Session={id:string;url:string;width:number;height:number;dir:string;child:ChildProcess;socket:WebSocket;nextId:number;pending:Map<number,Pending>;closed:boolean;lastFrame:number};

export function localPreviewUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>2048)throw new BridgeError('invalid','请输入本机网页地址');
  let url:URL;try{url=new URL(value);}catch{throw new BridgeError('invalid','网页地址无效');}
  if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw new BridgeError('invalid','只能预览这台电脑的 localhost 页面');
  return url.toString();
}

function browserBinary():string {
  const roots=[process.env['PROGRAMFILES(X86)'],process.env.PROGRAMFILES,process.env.LOCALAPPDATA].filter((v):v is string=>Boolean(v));
  const candidates=[...roots.flatMap(root=>[join(root,'Microsoft','Edge','Application','msedge.exe'),join(root,'Google','Chrome','Application','chrome.exe')])];
  const found=candidates.find(existsSync);
  if(!found)throw new BridgeError('browser_missing','电脑上未找到 Microsoft Edge 或 Google Chrome');
  return found;
}

async function debuggerPort(dir:string,child:ChildProcess):Promise<number> {
  let launchError=false;child.once('error',()=>{launchError=true;});
  for(let i=0;i<120;i++){
    if(launchError||child.exitCode!==null)break;
    try {const port=Number((await readFile(join(dir,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);if(Number.isInteger(port)&&port>0&&port<65536)return port;}catch{}
    await delay(100);
  }
  throw new BridgeError('browser_start','电脑浏览器未能启动远程预览');
}

async function pageSocket(port:number):Promise<WebSocket> {
  for(let i=0;i<30;i++){
    try {
      const response=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)});
      const pages=await response.json() as Json[];
      const target=pages.find(page=>page.type==='page'&&typeof page.webSocketDebuggerUrl==='string');
      if(target){const address=new URL(target.webSocketDebuggerUrl);address.hostname='127.0.0.1';const socket=new WebSocket(address);await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});return socket;}
    }catch{}
    await delay(100);
  }
  throw new BridgeError('browser_start','无法连接电脑上的预览浏览器');
}

export class BrowserPreview extends EventEmitter {
  private active?:Session;
  private revision=0;
  async start(value:unknown,rawWidth:unknown,rawHeight:unknown):Promise<Json> {
    const url=localPreviewUrl(value);
    const width=Math.max(320,Math.min(1000,Math.round(Number(rawWidth)||390)));
    const height=Math.max(400,Math.min(1400,Math.round(Number(rawHeight)||760)));
    const revision=++this.revision;
    if(this.active)await this.dispose(this.active,true);
    if(revision!==this.revision)throw new BridgeError('cancelled','预览已取消');
    const dir=await mkdtemp(join(tmpdir(),'codex-mobile-preview-'));
    let child:ChildProcess|undefined,socket:WebSocket|undefined,created:Session|undefined;
    try {
      child=spawn(browserBinary(),['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${dir}`,`--window-size=${width},${height}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
      const port=await debuggerPort(dir,child);
      if(revision!==this.revision)throw new BridgeError('cancelled','预览已取消');
      socket=await pageSocket(port);
      if(revision!==this.revision)throw new BridgeError('cancelled','预览已取消');
      const session:Session={id:randomUUID(),url,width,height,dir,child,socket,nextId:0,pending:new Map(),closed:false,lastFrame:0};
      created=session;
      this.active=session;
      socket.on('message',raw=>this.receive(session,raw.toString()));
      socket.on('close',()=>{void this.dispose(session,true);});
      child.on('exit',()=>{void this.dispose(session,true);});
      await this.command(session,'Page.enable');
      await this.command(session,'Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true});
      await this.command(session,'Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
      await this.command(session,'Page.navigate',{url});
      await delay(300);
      const first:Json=await this.command(session,'Page.captureScreenshot',{format:'jpeg',quality:65,captureBeyondViewport:false}).catch(()=>({}));
      await this.command(session,'Page.startScreencast',{format:'jpeg',quality:65,maxWidth:width,maxHeight:height,everyNthFrame:1,maxFramesInFlight:1});
      if(revision!==this.revision)throw new BridgeError('cancelled','预览已取消');
      return {sessionId:session.id,url,width,height,frame:first.data};
    }catch(error){
      if(created)await this.dispose(created,false);
      else {socket?.terminate();child?.kill();await rm(dir,{recursive:true,force:true}).catch(()=>{});}
      if(error instanceof BridgeError)throw error;
      throw new BridgeError('browser_start','电脑浏览器启动失败，请检查 Edge 或 Chrome');
    }
  }
  async input(sessionId:unknown,input:Json):Promise<void> {
    const session=this.active;
    if(!session||session.id!==sessionId||session.closed)return;
    const type=input?.type;
    if(['touchStart','touchMove','touchEnd','touchCancel'].includes(type)){
      const x=Number(input.x),y=Number(input.y);
      if(type!=='touchEnd'&&type!=='touchCancel'&&(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>session.width||y>session.height))return;
      await this.command(session,'Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y,id:1}]});
    }else if(type==='text'){
      if(typeof input.text!=='string'||input.text.length>4000)return;
      await this.command(session,'Input.insertText',{text:input.text});
    }else if(type==='key'){
      const keys:Record<string,{code:string;keyCode:number;text?:string}>={Enter:{code:'Enter',keyCode:13,text:'\r'},Backspace:{code:'Backspace',keyCode:8},Tab:{code:'Tab',keyCode:9},Escape:{code:'Escape',keyCode:27}};
      const key=keys[input.key];if(!key)return;
      await this.command(session,'Input.dispatchKeyEvent',{type:'keyDown',key:input.key,code:key.code,windowsVirtualKeyCode:key.keyCode,text:key.text});
      await this.command(session,'Input.dispatchKeyEvent',{type:'keyUp',key:input.key,code:key.code,windowsVirtualKeyCode:key.keyCode});
    }else if(type==='reload')await this.command(session,'Page.reload',{ignoreCache:true});
    else if(type==='back')await this.command(session,'Runtime.evaluate',{expression:'history.back()'});
    else if(type==='scroll'){
      const deltaX=Number(input.deltaX),deltaY=Number(input.deltaY);
      if(Number.isFinite(deltaX)&&Number.isFinite(deltaY))await this.command(session,'Input.dispatchMouseEvent',{type:'mouseWheel',x:session.width/2,y:session.height/2,deltaX:Math.max(-1000,Math.min(1000,deltaX)),deltaY:Math.max(-1000,Math.min(1000,deltaY))});
    }
  }
  async stop(sessionId?:unknown):Promise<void> {const session=this.active;if(!sessionId||session?.id===sessionId){this.revision++;if(session)await this.dispose(session,true);}}
  private receive(session:Session,raw:string){
    let message:Json;try{message=JSON.parse(raw);}catch{return;}
    if(typeof message.id==='number'){
      const pending=session.pending.get(message.id);if(!pending)return;
      clearTimeout(pending.timer);session.pending.delete(message.id);
      if(message.error)pending.reject(Error(message.error.message||'浏览器命令失败'));else pending.resolve(message.result||{});
    }else if(message.method==='Page.screencastFrame'){
      this.fire(session,'Page.screencastFrameAck',{sessionId:message.params?.sessionId});
      const now=Date.now();if(session.closed||now-session.lastFrame<180)return;
      session.lastFrame=now;
      const data=message.params?.data;
      if(typeof data==='string'&&data.length<2_000_000)this.emit('frame',{sessionId:session.id,data,width:session.width,height:session.height});
    }
  }
  private fire(session:Session,method:string,params:Json={}){if(!session.closed&&session.socket.readyState===WebSocket.OPEN)session.socket.send(JSON.stringify({id:++session.nextId,method,params}));}
  private command(session:Session,method:string,params:Json={}):Promise<Json> {
    if(session.closed||session.socket.readyState!==WebSocket.OPEN)return Promise.reject(Error('浏览器已关闭'));
    return new Promise((resolve,reject)=>{
      const id=++session.nextId,timer=setTimeout(()=>{session.pending.delete(id);reject(Error('浏览器响应超时'));},10_000);
      session.pending.set(id,{resolve,reject,timer});session.socket.send(JSON.stringify({id,method,params}));
    });
  }
  private async dispose(session:Session,notify:boolean){
    if(session.closed)return;
    session.closed=true;if(this.active===session)this.active=undefined;
    for(const pending of session.pending.values()){clearTimeout(pending.timer);pending.reject(Error('浏览器已关闭'));}session.pending.clear();
    session.socket.terminate();session.child.kill();
    if(session.child.exitCode===null)await Promise.race([new Promise<void>(resolve=>session.child.once('exit',()=>resolve())),delay(1500)]);
    for(let attempt=0;attempt<3;attempt++){try{await rm(session.dir,{recursive:true,force:true});break;}catch{await delay(200);}}
    if(notify)this.emit('ended',{sessionId:session.id});
  }
}
