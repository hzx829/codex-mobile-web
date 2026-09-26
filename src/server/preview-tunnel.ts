import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {WebSocket, WebSocketServer} from 'ws';
import type {Json} from '../shared/types.js';

type Session={id:string;phone:WebSocket;connector:WebSocket;url:string;cookie:string;ticket:string;lastActivity:number};
type HttpRoute={session:Session;response:ServerResponse;started:boolean;timer:NodeJS.Timeout;origin:string};
type SocketRoute={session:Session;socket:WebSocket;ready:boolean;pending:{data:string;binary:boolean}[]};
const authCookie='codex_preview';
const token=()=>randomBytes(32).toString('hex');

export class PreviewTunnel {
  readonly server=createServer((req,res)=>void this.http(req,res));
  private wss=new WebSocketServer({noServer:true,maxPayload:4*1024*1024});
  private sessions=new Map<string,Session>();
  private httpRoutes=new Map<string,HttpRoute>();
  private sockets=new Map<string,SocketRoute>();
  private expiry:NodeJS.Timeout;
  constructor(private send:(socket:WebSocket,message:Json)=>void,private port:number){
    this.expiry=setInterval(()=>{for(const session of this.sessions.values())if(Date.now()-session.lastActivity>30*60_000){this.stop(session.id);this.send(session.connector,{type:'preview.stop',sessionId:session.id});}},60_000);
    this.expiry.unref();
    this.server.on('upgrade',(req,socket,head)=>{
      const session=this.authorize(req);
      if(!session){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.websocket(req,ws,session));
    });
  }
  start(phone:WebSocket,connector:WebSocket,result:Json):Json {
    for(const session of this.sessions.values())if(session.connector===connector)this.stop(session.id,true);
    const session:Session={id:result.sessionId,phone,connector,url:result.url,cookie:token(),ticket:token(),lastActivity:Date.now()};
    this.sessions.set(session.id,session);
    return {...result,ticket:session.ticket,previewPort:(this.server.address() as any)?.port||this.port};
  }
  stop(id:string,notify=false){
    const session=this.sessions.get(id);if(!session)return;
    this.sessions.delete(id);
    for(const [routeId,route] of this.httpRoutes)if(route.session===session){clearTimeout(route.timer);route.response.destroy();this.httpRoutes.delete(routeId);}
    for(const [routeId,route] of this.sockets)if(route.session===session){route.socket.close();this.sockets.delete(routeId);}
    if(notify)this.send(session.phone,{type:'preview.ended',sessionId:id});
  }
  stopPeer(peer:WebSocket){
    for(const session of this.sessions.values())if(session.connector===peer)this.stop(session.id,true);
  }
  handle(connector:WebSocket,message:Json){
    const id=message.id;if(typeof id!=='string')return;
    const http=this.httpRoutes.get(id);
    if(http&&http.session.connector===connector){
      http.session.lastActivity=Date.now();
      const {response}=http;
      if(message.type==='proxy.http.head'&&!http.started){
        http.started=true;
        const headers=this.responseHeaders(message.headers,http.session.url,http.origin);
        response.writeHead(Number.isInteger(message.status)&&message.status>=100&&message.status<=599?message.status:502,headers);
      }else if(message.type==='proxy.http.data'&&http.started&&typeof message.data==='string'){
        if(!response.write(Buffer.from(message.data,'base64')))this.send(connector,{type:'proxy.http.pause',id});
      }else if(message.type==='proxy.http.end'||message.type==='proxy.http.fail'){
        clearTimeout(http.timer);this.httpRoutes.delete(id);
        if(!http.started)response.writeHead(502);response.end();
      }
      return;
    }
    const ws=this.sockets.get(id);
    if(!ws||ws.session.connector!==connector)return;
    ws.session.lastActivity=Date.now();
    if(message.type==='proxy.ws.ready'){
      ws.ready=true;for(const frame of ws.pending)this.send(connector,{type:'proxy.ws.data',id,...frame});ws.pending=[];
    }else if(message.type==='proxy.ws.data'&&typeof message.data==='string'){
      if(ws.socket.readyState===WebSocket.OPEN)ws.socket.send(message.binary?Buffer.from(message.data,'base64'):message.data);
    }else if(message.type==='proxy.ws.close'){ws.socket.close();this.sockets.delete(id);}
  }
  private authorize(req:IncomingMessage):Session|undefined {
    const cookie=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(authCookie+'='))?.slice(authCookie.length+1);
    return [...this.sessions.values()].find(session=>session.cookie===cookie);
  }
  private origin(req:IncomingMessage){
    const proto=req.headers['x-forwarded-proto']==='https'||(req.socket as any).encrypted?'https':'http';
    return `${proto}://${req.headers.host}`;
  }
  private headers(req:IncomingMessage):Json {
    const headers:Json={...req.headers};
    const cookies=(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v&&!v.startsWith(authCookie+'='));
    if(cookies.length)headers.cookie=cookies.join('; ');else delete headers.cookie;
    delete headers['x-forwarded-proto'];delete headers['x-forwarded-host'];delete headers['x-forwarded-for'];
    return headers;
  }
  private responseHeaders(raw:Json,targetUrl:string,origin:string):Json {
    const headers:Json={};
    if(raw&&typeof raw==='object')for(const [key,value] of Object.entries(raw)){
      const name=key.toLowerCase();
      if(['connection','transfer-encoding','keep-alive','te','trailer','upgrade','proxy-authenticate','proxy-authorization'].includes(name))continue;
      if(typeof value==='string'||Array.isArray(value)&&value.every(v=>typeof v==='string'))headers[name]=value;
    }
    if(typeof headers.location==='string'){
      try{const local=new URL(targetUrl);const next=new URL(headers.location,local);if(next.origin===local.origin)headers.location=origin+next.pathname+next.search+next.hash;}catch{}
    }
    if(headers['set-cookie'])headers['set-cookie']=(Array.isArray(headers['set-cookie'])?headers['set-cookie']:[headers['set-cookie']]).map((v:string)=>v.replace(/;\s*Domain=(?:localhost|127\.0\.0\.1)/ig,''));
    return headers;
  }
  private async http(req:IncomingMessage,res:ServerResponse){
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    const path=req.url||'/';
    if(path.startsWith('/_bridge/enter?')){
      const ticket=new URL(path,'http://preview.invalid').searchParams.get('ticket');
      const session=[...this.sessions.values()].find(s=>s.ticket===ticket);
      if(!session){res.writeHead(401);res.end('Preview link expired');return;}
      session.ticket='';
      const target=new URL(session.url);
      res.writeHead(302,{'Set-Cookie':`${authCookie}=${session.cookie}; HttpOnly; SameSite=Lax; Path=/${this.origin(req).startsWith('https:')?'; Secure':''}`,'Location':target.pathname+target.search});res.end();return;
    }
    const session=this.authorize(req);
    if(!session){res.writeHead(401);res.end('Preview expired. Open it from Codex Mobile again.');return;}
    session.lastActivity=Date.now();
    const chunks:Buffer[]=[];let size=0;
    try{for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}}catch{res.destroy();return;}
    const id=randomUUID(),timer=setTimeout(()=>{this.httpRoutes.delete(id);if(!res.headersSent)res.writeHead(504);res.end();},120_000);
    this.httpRoutes.set(id,{session,response:res,started:false,timer,origin:this.origin(req)});
    res.on('drain',()=>this.send(session.connector,{type:'proxy.http.resume',id}));
    res.on('close',()=>{const route=this.httpRoutes.get(id);if(route){clearTimeout(route.timer);this.httpRoutes.delete(id);this.send(session.connector,{type:'proxy.http.cancel',id});}});
    this.send(session.connector,{type:'proxy.http.request',id,sessionId:session.id,method:req.method,path,headers:this.headers(req),body:Buffer.concat(chunks).toString('base64')});
  }
  private websocket(req:IncomingMessage,socket:WebSocket,session:Session){
    session.lastActivity=Date.now();
    const id=randomUUID(),route:SocketRoute={session,socket,ready:false,pending:[]};this.sockets.set(id,route);
    socket.on('message',(data,binary)=>{
      session.lastActivity=Date.now();
      const frame={data:binary?data.toString('base64'):data.toString(),binary};
      if(route.ready)this.send(session.connector,{type:'proxy.ws.data',id,...frame});
      else if(route.pending.length<32)route.pending.push(frame);
      else socket.close(1009);
    });
    socket.on('close',()=>{this.sockets.delete(id);this.send(session.connector,{type:'proxy.ws.close',id});});
    socket.on('error',()=>{});
    this.send(session.connector,{type:'proxy.ws.open',id,sessionId:session.id,path:req.url,headers:this.headers(req)});
  }
  async close(){clearInterval(this.expiry);for(const session of this.sessions.values())this.stop(session.id);for(const ws of this.wss.clients)ws.terminate();await new Promise<void>(resolve=>this.wss.close(()=>resolve()));if(this.server.listening)await new Promise<void>(resolve=>this.server.close(()=>resolve()));}
}
