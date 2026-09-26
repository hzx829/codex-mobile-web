import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {request as httpRequest, type ClientRequest, type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {WebSocket} from 'ws';
import {BridgeError, type Json} from '../shared/types.js';

type HttpRoute={request:ClientRequest;response?:IncomingMessage};

export function localPreviewUrl(value:unknown):string {
  if(typeof value!=='string'||value.length>2048)throw new BridgeError('invalid','请输入本机网页地址');
  let url:URL;try{url=new URL(value);}catch{throw new BridgeError('invalid','网页地址无效');}
  if(!['http:','https:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password)throw new BridgeError('invalid','只能预览这台电脑的 localhost 页面');
  return url.toString();
}

export class BrowserPreview extends EventEmitter {
  private active?:{id:string;url:URL};
  private requests=new Map<string,HttpRoute>();
  private sockets=new Map<string,WebSocket>();
  start(value:unknown):Json {
    const url=new URL(localPreviewUrl(value));
    this.stop();
    const id=randomUUID();this.active={id,url};
    return {sessionId:id,url:url.toString()};
  }
  stop(sessionId?:unknown){
    if(!this.active||sessionId&&sessionId!==this.active.id)return;
    const id=this.active.id;this.active=undefined;
    for(const route of this.requests.values())route.request.destroy();this.requests.clear();
    for(const socket of this.sockets.values())socket.terminate();this.sockets.clear();
    this.emit('ended',{sessionId:id});
  }
  pauseResponses(){for(const route of this.requests.values())route.response?.pause();}
  resumeResponses(){for(const route of this.requests.values())route.response?.resume();}
  handle(message:Json){
    if(message.type==='proxy.http.request'){this.http(message);return;}
    const id=message.id;if(typeof id!=='string')return;
    if(message.type==='proxy.http.pause'||message.type==='proxy.http.resume'||message.type==='proxy.http.cancel'){
      const route=this.requests.get(id),response=route?.response;
      if(message.type==='proxy.http.pause')response?.pause();
      else if(message.type==='proxy.http.resume')response?.resume();
      else {route?.request.destroy();this.requests.delete(id);}
    }else if(message.type==='proxy.ws.open'){this.websocket(message);
    }else if(message.type==='proxy.ws.data'){
      const socket=this.sockets.get(id);
      if(socket?.readyState===WebSocket.OPEN&&typeof message.data==='string')socket.send(message.binary?Buffer.from(message.data,'base64'):message.data);
    }else if(message.type==='proxy.ws.close')this.sockets.get(id)?.close();
  }
  private target(message:Json):URL|undefined {
    if(!this.active||message.sessionId!==this.active.id||typeof message.path!=='string'||!message.path.startsWith('/')||message.path.startsWith('//'))return;
    const path=new URL(message.path,'http://preview.invalid');
    return new URL(path.pathname+path.search,this.active.url.origin);
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
  private http(message:Json){
    const target=this.target(message),id=message.id;
    if(!target||typeof id!=='string'||!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(message.method)||typeof message.body!=='string'){this.emit('message',{type:'proxy.http.fail',id});return;}
    const body=Buffer.from(message.body,'base64');
    if(body.length>8*1024*1024){this.emit('message',{type:'proxy.http.fail',id});return;}
    const request=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:message.method,headers:this.headers(message.headers,target)},response=>{
      const route=this.requests.get(id);if(!route)return response.destroy();route.response=response;
      this.emit('message',{type:'proxy.http.head',id,status:response.statusCode||502,headers:response.headers});
      response.on('data',(chunk:Buffer)=>this.emit('message',{type:'proxy.http.data',id,data:chunk.toString('base64')}));
      response.on('end',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.end',id});});
      response.on('error',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.fail',id});});
    });
    this.requests.set(id,{request});
    request.on('error',()=>{this.requests.delete(id);this.emit('message',{type:'proxy.http.fail',id});});
    request.setTimeout(120_000,()=>request.destroy());request.end(body);
  }
  private websocket(message:Json){
    const target=this.target(message),id=message.id;
    if(!target||typeof id!=='string'){this.emit('message',{type:'proxy.ws.close',id});return;}
    const headers=this.headers(message.headers,target);
    target.protocol=target.protocol==='https:'?'wss:':'ws:';
    delete headers['sec-websocket-key'];delete headers['sec-websocket-version'];delete headers['sec-websocket-extensions'];delete headers['sec-websocket-protocol'];
    const protocols=typeof message.headers?.['sec-websocket-protocol']==='string'?message.headers['sec-websocket-protocol'].split(',').map((v:string)=>v.trim()).filter(Boolean):[];
    const socket=new WebSocket(target,protocols,{headers,maxPayload:4*1024*1024});this.sockets.set(id,socket);
    socket.on('open',()=>this.emit('message',{type:'proxy.ws.ready',id}));
    socket.on('message',(data,isBinary)=>this.emit('message',{type:'proxy.ws.data',id,data:isBinary?data.toString('base64'):data.toString(),binary:isBinary}));
    socket.on('error',()=>{});
    socket.on('close',()=>{this.sockets.delete(id);this.emit('message',{type:'proxy.ws.close',id});});
  }
}
