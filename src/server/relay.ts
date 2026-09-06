import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { MAX_FRAME, type Json } from '../shared/types.js';

type Peer={role:'phone'|'connector';machineId?:string;name?:string;alive:boolean};
export function createRelay(token:string,staticDir=resolve('dist')) {
  const peers=new Map<WebSocket,Peer>();
  const routes=new Map<string,{phone:WebSocket;connector:WebSocket;id:string;timer:NodeJS.Timeout}>();
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
    try {
      const pathname=decodeURIComponent(new URL(req.url||'/', 'http://localhost').pathname);
      const file=resolve(staticDir,'.'+(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(resolve(staticDir)+sep))throw Error();
      if(!(await stat(file)).isFile())throw Error();
      const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
      res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'});res.end(await readFile(file));
    }catch{res.writeHead(404);res.end('Not found');}
  });
  const wss=new WebSocketServer({server,path:'/ws',maxPayload:MAX_FRAME});
  function send(ws:WebSocket,value:Json) {
    if(ws.readyState!==WebSocket.OPEN)return;
    const frame=JSON.stringify(value);
    if(ws.bufferedAmount>MAX_FRAME||Buffer.byteLength(frame)>MAX_FRAME){ws.close(1009,'response_too_large');return;}
    ws.send(frame);
  }
  function machines(){return [...peers.values()].filter(p=>p.role==='connector').map(p=>({id:p.machineId,name:p.name}));}
  function publish(){for(const [ws,p]of peers)if(p.role==='phone')send(ws,{type:'machines',data:machines()});}
  function finish(routeId:string,message:Json){const r=routes.get(routeId);if(!r)return;clearTimeout(r.timer);routes.delete(routeId);send(r.phone,{...message,id:r.id,type:'response'});}
  wss.on('connection',ws=>{
    const authTimer=setTimeout(()=>ws.close(4401,'auth_required'),5000);
    ws.on('error',()=>{});
    ws.on('pong',()=>{const p=peers.get(ws);if(p)p.alive=true;});
    ws.on('message',buffer=>{
      let m:Json;try{m=JSON.parse(buffer.toString());}catch{ws.close(4400,'invalid_frame');return;}
      if(!m||typeof m!=='object'){ws.close(4400);return;}
      const p=peers.get(ws);
      if(!p) {
        const supplied=Buffer.from(typeof m.token==='string'?m.token:''),actual=Buffer.from(token);
        if(m.type!=='hello'||!['phone','connector'].includes(m.role)||supplied.length!==actual.length||!timingSafeEqual(supplied,actual)){ws.close(4401,'invalid_token');return;}
        if(m.role==='connector'&&(!/^[a-zA-Z0-9_-]{1,80}$/.test(m.machineId)||typeof m.name!=='string')){ws.close(4400);return;}
        if(m.role==='connector')for(const [old,q]of peers)if(q.machineId===m.machineId){peers.delete(old);old.close(4409,'replaced');}
        peers.set(ws,{role:m.role,machineId:m.machineId,name:m.name?.slice(0,100),alive:true});clearTimeout(authTimer);
        send(ws,{type:'ready',machines:machines()});publish();return;
      }
      if(p.role==='phone'&&m.type==='request') {
        if(typeof m.id!=='string'||m.id.length>100||typeof m.action!=='string'||!m.payload||typeof m.payload!=='object'){ws.close(4400);return;}
        const connector=[...peers].find(([,q])=>q.role==='connector'&&q.machineId===m.machineId)?.[0];
        if(!connector){send(ws,{type:'response',id:m.id,error:{code:'offline',message:'电脑未连接'}});return;}
        if([...routes.values()].filter(r=>r.phone===ws).length>=32){send(ws,{type:'response',id:m.id,error:{code:'busy',message:'请求较多，请稍后重试'}});return;}
        const routeId=randomUUID();
        const timer=setTimeout(()=>finish(routeId,{error:{code:'timeout',message:'电脑回执超时，请核实操作结果',uncertain:true}}),40_000);
        routes.set(routeId,{phone:ws,connector,id:m.id,timer});
        send(connector,{type:'request',id:routeId,action:m.action,payload:m.payload});
      } else if(p.role==='connector'&&m.type==='response') {
        if(routes.get(m.id)?.connector===ws)finish(m.id,m);
      } else if(p.role==='connector'&&m.type==='changed') {
        for(const [phone,q]of peers)if(q.role==='phone')send(phone,{type:'changed',machineId:p.machineId,threadId:m.threadId||null,generation:m.generation});
      }
    });
    ws.on('close',()=>{
      clearTimeout(authTimer);peers.delete(ws);
      for(const [id,r]of routes) {
        if(r.phone===ws){clearTimeout(r.timer);routes.delete(id);}
        else if(r.connector===ws)finish(id,{error:{code:'offline',message:'电脑连接中断，请核实操作结果',uncertain:true}});
      }
      publish();
    });
  });
  const heartbeat=setInterval(()=>{for(const [ws,p]of peers){if(!p.alive){ws.terminate();continue;}p.alive=false;ws.ping();}},15_000);
  server.on('close',()=>clearInterval(heartbeat));
  return {server,wss,close:async()=>{clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();for(const r of routes.values())clearTimeout(r.timer);await new Promise<void>(r=>wss.close(()=>server.close(()=>r())));}};
}
