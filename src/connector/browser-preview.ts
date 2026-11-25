import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {request as httpRequest, type ClientRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
import type {Readable} from 'node:stream';
import {htmlEntry, htmlEntryUrl, openHtmlResource} from './html-preview.js';
import {WebSocket} from 'ws';
import {BridgeError, textRequired, type Json} from '../shared/types.js';

type HttpRoute={request?:ClientRequest;response?:Readable;paused?:boolean};

export function localPreviewUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>2048)throw new BridgeError('invalid','请输入本机网页地址');
  let url:URL;try{url=new URL(value);}catch{throw new BridgeError('invalid','网页地址无效');}
  if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw new BridgeError('invalid','只能预览这台电脑的 localhost 页面');
  return url.toString();
}

// Link-local ranges stay out: 169.254.169.254 hands out credentials on cloud machines.
const lanRanges=new BlockList();
for(const [net,prefix] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16],['127.0.0.0',8]] as const)lanRanges.addSubnet(net,prefix,'ipv4');
lanRanges.addSubnet('fc00::',7,'ipv6');lanRanges.addAddress('::1','ipv6');
export function lanAddress(address:string):boolean {
  const family=isIP(address);
  return family===4?lanRanges.check(address,'ipv4'):family===6&&lanRanges.check(address,'ipv6');
}
type Resolve=(host:string)=>Promise<{address:string;family:number}[]>;
export type PreviewAddress={url:string;pin?:{address:string;family:number}};
/**
 * A page this computer may relay: its own localhost, or with `lan` a host on its private network.
 * A name must resolve to private addresses only; the first is pinned so later requests cannot be pointed elsewhere.
 */
export async function previewAddress(value:unknown,lan:boolean,resolve:Resolve=host=>dnsLookup(host,{all:true})):Promise<PreviewAddress> {
  try{return {url:localPreviewUrl(value)};}catch(e){if(!lan||typeof value!=='string'||value.length>2048)throw e;}
  let url:URL;try{url=new URL(value as string);}catch{throw new BridgeError('invalid','网页地址无效');}
  const refused=new BridgeError('invalid','只能预览这台电脑的 localhost 页面，或它能访问的局域网地址');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw refused;
  const host=url.hostname.replace(/^\[|\]$/g,'');
  let found:{address:string;family:number}[];
  try{found=isIP(host)?[{address:host,family:isIP(host)}]:await resolve(host);}catch{throw new BridgeError('invalid','这台电脑找不到这个地址');}
  if(!found.length||!found.every(item=>lanAddress(item.address)))throw refused;
  return {url:url.toString(),...isIP(host)?{}:{pin:found[0]}};
}

export class BrowserPreview extends EventEmitter {
  private active?:{id:string;threadId:string;url:URL;entry?:string;pin?:{address:string;family:number}};
  /** `lan`: also relay pages on the computer's private network. Off for a guest's connector, whose network is its host's. */
  constructor(private options:{lan?:boolean;resolve?:Resolve}={}){super();}
  private generation=0;
  private requests=new Map<string,HttpRoute>();
  private sockets=new Map<string,WebSocket>();
  start(value:unknown,thread:unknown):Json {
    const threadId=textRequired(thread,'会话');
    return this.activate(threadId,new URL(localPreviewUrl(value)));
  }
  /** As `start`, and with `lan` also for a page on the private network. */
  async startAddress(value:unknown,thread:unknown):Promise<Json> {
    const threadId=textRequired(thread,'会话'), generation=++this.generation;
    const target=await previewAddress(value,Boolean(this.options.lan),this.options.resolve);
    if(generation!==this.generation)throw new BridgeError('changed','网页预览已更换');
    return this.activate(threadId,new URL(target.url),undefined,target.pin);
  }
  async startFile(value:unknown,thread:unknown):Promise<Json> {
    const threadId=textRequired(thread,'会话'), generation=++this.generation;
    const entry=await htmlEntry(value);
    if(generation!==this.generation)throw new BridgeError('changed','网页预览已更换');
    return this.activate(threadId,new URL(htmlEntryUrl(entry)),entry);
  }
  private activate(threadId:string,url:URL,entry?:string,pin?:{address:string;family:number}):Json {
    this.stop();
    const id=randomUUID();this.active={id,threadId,url,entry,pin};
    return {sessionId:id,threadId,url:url.toString()};
  }
  stopForThread(session:unknown,thread:unknown){
    return this.stop(textRequired(session,'预览会话'),textRequired(thread,'会话'));
  }
  stop(sessionId?:unknown,threadId?:unknown):boolean {
    if(sessionId===undefined)this.generation++;
    if(!this.active||sessionId!==undefined&&sessionId!==this.active.id||threadId!==undefined&&threadId!==this.active.threadId)return false;
    const active=this.active;this.active=undefined;this.paused=false;
    for(const route of this.requests.values()){route.request?.destroy();route.response?.destroy();}this.requests.clear();
    for(const socket of this.sockets.values())socket.terminate();this.sockets.clear();
    this.emit('ended',{sessionId:active.id,threadId:active.threadId});
    return true;
  }
  private paused=false;
  pauseResponses(){this.paused=true;for(const route of this.requests.values())route.response?.pause();}
  resumeResponses(){this.paused=false;for(const route of this.requests.values())if(!route.paused)route.response?.resume();}
  handle(message:Json){
    if(message.type==='proxy.http.request'){this.http(message);return;}
    const id=message.id;if(typeof id!=='string')return;
    if(message.type==='proxy.http.pause'||message.type==='proxy.http.resume'||message.type==='proxy.http.cancel'){
      const route=this.requests.get(id),response=route?.response;
      if(!route)return;
      if(message.type==='proxy.http.cancel'){route.request?.destroy();response?.destroy();this.requests.delete(id);}
      else {route.paused=message.type==='proxy.http.pause';if(route.paused||this.paused)response?.pause();else response?.resume();}
    }else if(message.type==='proxy.ws.open'){this.websocket(message);
    }else if(message.type==='proxy.ws.data'){
      const socket=this.sockets.get(id);
      if(socket?.readyState===WebSocket.OPEN&&typeof message.data==='string')socket.send(message.binary?Buffer.from(message.data,'base64'):message.data);
    }else if(message.type==='proxy.ws.close')this.sockets.get(id)?.close();
  }
  private target(message:Json):URL|undefined {
    if(!this.active||message.sessionId!==this.active.id||typeof message.path!=='string'||!message.path.startsWith('/')||message.path.startsWith('//'))return;
    const path=new URL(message.path,'http://preview.invalid');
    const target=new URL(this.active.url.origin);target.pathname=path.pathname;target.search=path.search;
    return target;
  }
  /** Connects to the address checked when the preview started, whatever the name resolves to now. */
  private pinned():{lookup?:(host:string,options:any,done:(...args:any[])=>void)=>void} {
    const pin=this.active?.pin;
    return pin?{lookup:(_host,options,done)=>options?.all?done(null,[pin]):done(null,pin.address,pin.family)}:{};
  }
  private headers(raw:Json,target:URL):Record<string,string|string[]> {
    const headers:Record<string,string|string[]>={};
    if(raw&&typeof raw==='object')for(const [key,value] of Object.entries(raw)){
      const name=key.toLowerCase();
      if(['host','connection','upgrade','proxy-connection','transfer-encoding','keep-alive','te','trailer','proxy-authorization','proxy-authenticate'].includes(name)||name.startsWith('sec-fetch-'))continue;
      if(typeof value==='string'||Array.isArray(value)&&value.every(v=>typeof v==='string'))headers[name]=value;
    }
    headers.host=target.host;
    if(headers.origin)headers.origin=target.origin;
    if(headers.referer){try{const from=new URL(String(headers.referer));headers.referer=target.origin+from.pathname+from.search;}catch{delete headers.referer;}}
    return headers;
  }
  private async html(message:Json,target:URL,entry:string){
    const id=message.id,route:HttpRoute={};this.requests.set(id,route);
    try{
      if(!['GET','HEAD'].includes(message.method)||message.headers?.['service-worker'])throw Error();
      const {file,mime,size}=await openHtmlResource(entry,target.pathname);
      if(this.requests.get(id)!==route){await file.close();return;}
      this.emit('message',{type:'proxy.http.head',id,status:200,headers:{'content-type':mime,'content-length':String(size),'x-content-type-options':'nosniff','content-security-policy':"worker-src 'none'; object-src 'none'; base-uri 'self'"}});
      if(message.method==='HEAD'){await file.close();this.requests.delete(id);this.emit('message',{type:'proxy.http.end',id});return;}
      const stream=file.createReadStream();route.response=stream;
      stream.on('data',(chunk:Buffer)=>this.emit('message',{type:'proxy.http.data',id,data:chunk.toString('base64')}));
      stream.on('end',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.end',id});});
      stream.on('error',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.fail',id});});
      if(route.paused||this.paused)stream.pause();
    }catch{
      if(this.requests.get(id)!==route)return;
      this.requests.delete(id);this.emit('message',{type:'proxy.http.head',id,status:404,headers:{}});this.emit('message',{type:'proxy.http.end',id});
    }
  }
  private http(message:Json){
    const target=this.target(message),id=message.id;
    if(!target||typeof id!=='string'||!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(message.method)||typeof message.body!=='string'){this.emit('message',{type:'proxy.http.fail',id});return;}
    if(this.active?.entry){void this.html(message,target,this.active.entry);return;}
    const body=Buffer.from(message.body,'base64');
    if(body.length>8*1024*1024){this.emit('message',{type:'proxy.http.fail',id});return;}
    const request=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:message.method,headers:this.headers(message.headers,target),...this.pinned()},response=>{
      const route=this.requests.get(id);if(!route)return response.destroy();route.response=response;
      this.emit('message',{type:'proxy.http.head',id,status:response.statusCode||502,headers:response.headers});
      response.on('data',(chunk:Buffer)=>this.emit('message',{type:'proxy.http.data',id,data:chunk.toString('base64')}));
      if(route.paused||this.paused)response.pause();
      response.on('end',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.end',id});});
      response.on('error',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.fail',id});});
    });
    this.requests.set(id,{request});
    request.on('error',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.fail',id});});
    request.setTimeout(120_000,()=>request.destroy());request.end(body);
  }
  private websocket(message:Json){
    const target=this.target(message),id=message.id;
    if(this.active?.entry||!target||typeof id!=='string'){this.emit('message',{type:'proxy.ws.close',id});return;}
    const headers=this.headers(message.headers,target);
    target.protocol=target.protocol==='https:'?'wss:':'ws:';
    delete headers['sec-websocket-key'];delete headers['sec-websocket-version'];delete headers['sec-websocket-extensions'];delete headers['sec-websocket-protocol'];
    const protocols=typeof message.headers?.['sec-websocket-protocol']==='string'?message.headers['sec-websocket-protocol'].split(',').map((v:string)=>v.trim()).filter(Boolean):[];
    const socket=new WebSocket(target,protocols,{headers,maxPayload:4*1024*1024,...this.pinned()});this.sockets.set(id,socket);
    socket.on('open',()=>this.emit('message',{type:'proxy.ws.ready',id}));
    socket.on('message',(data,isBinary)=>this.emit('message',{type:'proxy.ws.data',id,data:isBinary?data.toString('base64'):data.toString(),binary:isBinary}));
    socket.on('error',()=>{});
    socket.on('close',()=>{this.sockets.delete(id);this.emit('message',{type:'proxy.ws.close',id});});
  }
}
