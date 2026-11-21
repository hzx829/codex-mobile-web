import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { MAX_FRAME, bridgeServices, textRequired, type Json, type Machine } from '../shared/types.js';
import { machineIdPattern, type ConnectorToken } from '../shared/config.js';
import { PreviewTunnel } from './preview-tunnel.js';
import { VOICE_REQUEST_TIMEOUT_MS } from '../shared/voice.js';
import { TeamError, type TeamStore } from './team/store.js';
import { CREATE_ACTIONS, LIST_ACTIONS, MUTATION_ACTIONS, READ_ACTIONS, SENDER_ACTIONS, SEND_ACTIONS, createdThread, handleTeam, publicUser, refreshSenderNames, serviceOf, threadOf, type Member } from './team/actions.js';

/** `member`: the signed-in person on a phone once the relay has a team; absent with the shared Token. */
type Peer={role:'phone'|'connector';machine?:Machine;alive:boolean;watch?:{machineId:string;threadId:string};member?:Member};
type Route={phone:WebSocket;connector:WebSocket;id:string;action:string;sessionId?:string;threadId?:string;timer:NodeJS.Timeout;machineId:string;payload:Json;member?:Member};
// Text frames compress well; file bytes and preview traffic are already dense or large.
const COMPRESS_LIMIT=2*1024*1024;
const DENSE_ACTIONS=new Set(['file.download','file.uploadChunk','claude.file.uploadChunk','antigravity.file.uploadChunk','voice.transcribe']);
const compress=promisify(gzip);
export function createRelay(token:string,staticDir=resolve('dist'),previewPort=3341,connectorTokens:ConnectorToken[] = [],team?:TeamStore) {
  if(connectorTokens.some(entry=>entry.token===token))throw new Error('连接器专用 Token 不能与主 Token 相同');
  const mainToken=Buffer.from(token);
  const restricted=connectorTokens.map(entry=>({...entry,token:Buffer.from(entry.token)}));
  const matches=(supplied:Buffer,actual:Buffer)=>supplied.length===actual.length&&timingSafeEqual(supplied,actual);
  const peers=new Map<WebSocket,Peer>();
  const routes=new Map<string,Route>();
  const compressed=new Map<string,{mtimeMs:number;size:number;body:Buffer}>();
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    let frameOrigin="'none'";
    try{const origin=new URL(`${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${req.headers.host}`);origin.port=String((preview.server.address() as any)?.port||previewPort);frameOrigin=origin.origin;}catch{}
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; frame-src ${frameOrigin}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`);
    if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
    try {
      const pathname=decodeURIComponent(new URL(req.url||'/', 'http://localhost').pathname);
      const file=resolve(staticDir,'.'+(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(resolve(staticDir)+sep))throw Error();
      if(!(await stat(file)).isFile())throw Error();
      const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
      const asset=/^\/assets\/[\w.-]+-[\w-]{8,}\.(m?js|css)$/.test(pathname);
      let body:Buffer;
      if(asset){
        res.setHeader('Cache-Control','public, max-age=31536000, immutable');res.setHeader('Vary','Accept-Encoding');
        const acceptsGzip=(req.headers['accept-encoding']||'').split(',').some(value=>{const [coding,...params]=value.trim().split(';');return coding==='gzip'&&!params.some(p=>/^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));});
        if(acceptsGzip){
          // Versioned assets do not change in place; compress each one once.
          const info=await stat(file),cached=compressed.get(file);
          if(cached&&cached.mtimeMs===info.mtimeMs&&cached.size===info.size)body=cached.body;
          else{body=await compress(await readFile(file));compressed.set(file,{mtimeMs:info.mtimeMs,size:info.size,body});}
          res.setHeader('Content-Encoding','gzip');
        }else body=await readFile(file);
      }else body=await readFile(file);
      res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Content-Length':body.length});res.end(body);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  // Session JSON shrinks several times with deflate, which matters on a phone's cross-border link.
  const wss=new WebSocketServer({server,path:'/ws',maxPayload:MAX_FRAME,perMessageDeflate:{threshold:1024,zlibDeflateOptions:{level:4}}});
  function send(ws:WebSocket,value:Json,dense=false) {
    if(ws.readyState!==WebSocket.OPEN)return;
    const frame=JSON.stringify(value),size=Buffer.byteLength(frame);
    if(ws.bufferedAmount>MAX_FRAME||size>MAX_FRAME){ws.close(1009,'response_too_large');return;}
    ws.send(frame,{compress:!dense&&size<=COMPRESS_LIMIT});
  }
  const preview=new PreviewTunnel(send,previewPort);
  const allowed=(p:Peer,machineId:string|undefined)=>!p.member||Boolean(machineId&&team?.canUse(p.member.user,machineId));
  function machines(viewer?:Peer){return [...peers.values()].flatMap(p=>p.machine&&(!viewer||allowed(viewer,p.machine.id))?[p.machine]:[]);}
  function publish(){for(const [ws,p]of peers)if(p.role==='phone')send(ws,{type:'machines',data:machines(p)});}
  /** Re-reads every signed-in device after a team change: revoked or disabled ones are closed, the rest get their current computers. */
  function refreshMembers(){
    if(!team)return;
    for(const [ws,p]of peers){
      if(!p.member)continue;
      const current=team.session(p.member.device.id);
      // A removed device or disabled member also loses its open web previews at once.
      if(!current){preview.stopPhone(ws);ws.close(4401,'revoked');continue;}
      p.member=current;
      if(p.watch&&!allowed(p,p.watch.machineId))p.watch=undefined;
      preview.stopPhone(ws,connector=>allowed(p,peers.get(connector)?.machine?.id));
      send(ws,{type:'machines',data:machines(p)});send(ws,{type:'team.user',user:publicUser(current.user)});
    }
  }
  /** Records who did what, who started a session, and marks lists and reads with owners. Message text is not kept. */
  function teamRecord(r:Route,message:Json){
    const member=r.member;if(!team||!member)return;
    const service=serviceOf(r.action),result=message.error?undefined:message.result;
    try{
      if(MUTATION_ACTIONS.has(r.action)){
        const state=message.error?(message.error.uncertain?'uncertain':'failed'):typeof result?.state==='string'?result.state:'accepted';
        team.addActivity({userId:member.user.id,deviceId:member.device.id,machineId:r.machineId,service,action:r.action,threadId:threadOf(r.payload,result)??null,opId:typeof r.payload.opId==='string'?r.payload.opId:null,state});
      }
      const created=CREATE_ACTIONS.has(r.action)?createdThread(r.action,r.payload,result):undefined;
      if(created)team.recordThread(r.machineId,service,created.id,member.user.id,created.parent);
      if(LIST_ACTIONS.has(r.action)&&Array.isArray(result?.data)){
        const items=result.data.filter((item:Json)=>item&&typeof item.id==='string');
        const owners=team.owners(r.machineId,service,items.map((item:Json)=>item.id));
        for(const item of items)item.owner=owners.get(item.id)??null;
        team.touchThreads(r.machineId,service,items.filter((item:Json)=>item.owner));
      }
      const read=READ_ACTIONS.has(r.action)&&result&&typeof result==='object'?threadOf(r.payload):undefined;
      if(read){
        result.owner=team.owners(r.machineId,service,[read]).get(read)??null;
        result.lastSender=team.lastSender(r.machineId,service,read,SEND_ACTIONS)??null;
      }
      if(SENDER_ACTIONS.has(r.action)&&result&&typeof result==='object')refreshSenderNames(team,result);
    }catch(error){console.error('团队记录写入失败：',(error as Error).message);}
  }
  function finish(routeId:string,message:Json){
    const r=routes.get(routeId);if(!r)return;clearTimeout(r.timer);routes.delete(routeId);
    if(r.action==='preview.start'&&!message.error){
      const result=message.result;
      if(r.phone.readyState!==WebSocket.OPEN||!result?.sessionId||typeof result.sessionId!=='string'||typeof result.url!=='string'||result.threadId!==r.threadId){
        if(typeof result?.sessionId==='string')send(r.connector,{type:'preview.stop',sessionId:result.sessionId,threadId:r.threadId});
        message={error:{code:'invalid',message:'网页预览的会话不匹配，请更新中继和电脑连接器'}};
      }else message.result=preview.start(r.phone,r.connector,result);
    }
    if(r.action==='preview.stop'&&!message.error&&message.result?.stopped===true&&r.sessionId&&r.threadId)preview.stopForThread(r.sessionId,r.threadId,r.connector);
    teamRecord(r,message);
    send(r.phone,{...message,id:r.id,type:'response'},DENSE_ACTIONS.has(r.action));
  }
  wss.on('connection',ws=>{
    const authTimer=setTimeout(()=>ws.close(4401,'auth_required'),5000);
    ws.on('error',()=>{});
    ws.on('pong',()=>{const p=peers.get(ws);if(p)p.alive=true;});
    // A failing team database read or any other unexpected error closes this one socket instead of the relay.
    ws.on('message',buffer=>{
      try{receive(buffer);}
      catch(error){console.error('中继处理消息失败：',(error as Error).message);try{ws.close(1011,'server_error');}catch{}}
    });
    function receive(buffer:RawData){
      let m:Json;try{m=JSON.parse(buffer.toString());}catch{ws.close(4400,'invalid_frame');return;}
      if(!m||typeof m!=='object'){ws.close(4400);return;}
      const p=peers.get(ws);
      if(!p) {
        const supplied=typeof m.token==='string'?m.token:'',suppliedBytes=Buffer.from(supplied);
        if(m.type!=='hello'||!['phone','connector'].includes(m.role)){ws.close(4401,'invalid_token');return;}
        const teamOn=Boolean(team?.enabled);
        let member:Member|undefined,deviceToken:string|undefined;
        let ownToken=false,bound=false;
        if(m.role==='phone'&&teamOn){
          // With a team, phones sign in as a member: a device token, or a one-time invite that becomes one.
          try{
            if(typeof m.invite==='string'){const redeemed=team!.redeemInvite(m.invite,typeof m.deviceName==='string'?m.deviceName:'');member=redeemed;deviceToken=redeemed.token;}
            else if(supplied)member=team!.authenticate(supplied);
          }catch(error){if(!(error instanceof TeamError))console.error('成员登录失败：',(error as Error).message);}
          if(!member){ws.close(4401,'invalid_token');return;}
        }else{
          const primary=matches(suppliedBytes,mainToken);
          const binding=primary?undefined:restricted.find(entry=>matches(suppliedBytes,entry.token));
          // A computer given its own token by an admin may only sign in with that token.
          const own=m.role==='connector'&&typeof m.machineId==='string'?team?.machineToken(m.machineId,supplied):undefined;
          if(m.role==='phone'&&!primary||m.role==='connector'&&(own===false||own===undefined&&!primary&&!(binding&&m.machineId===binding.machineId))){ws.close(4401,'invalid_token');return;}
          ownToken=own===true;bound=!ownToken&&Boolean(binding);
        }
        let machine:Machine|undefined;
        if(m.role==='connector'){
          if(typeof m.machineId!=='string'||!machineIdPattern.test(m.machineId)||typeof m.name!=='string'){ws.close(4400);return;}
          machine={id:m.machineId,name:m.name.slice(0,100)};
          if(m.guest===true||bound)machine.guest=true;
          if(Array.isArray(m.services))machine.services=bridgeServices.filter(service=>m.services.includes(service));
          for(const [old,q]of peers)if(q.machine?.id===machine.id){peers.delete(old);old.close(4409,'replaced');}
          try{team?.seenMachine(machine.id,machine.name);}catch{}
        }
        const peer:Peer={role:m.role,machine,alive:true,member};
        peers.set(ws,peer);clearTimeout(authTimer);
        // `features` lets connectors push live frames only through a relay that forwards them.
        send(ws,{type:'ready',machines:machines(m.role==='phone'?peer:undefined),features:team?['live','team']:['live'],
          ...member?{user:publicUser(member.user),device:{id:member.device.id,name:member.device.name}}:{},...deviceToken?{deviceToken}:{}});
        publish();return;
      }
      // A relay that set up its team after this phone signed in with the shared Token sends it back to sign in.
      if(p.role==='phone'&&!p.member&&team?.enabled){ws.close(4401,'team_login_required');return;}
      if(p.role==='phone'&&m.type==='team') {
        if(typeof m.id!=='string'||m.id.length>100||typeof m.action!=='string'){ws.close(4400);return;}
        if(!team||!p.member){send(ws,{type:'response',id:m.id,error:{code:'team_off',message:'这个中继还没有启用团队'}});return;}
        try{
          const online=new Map<string,string>();for(const q of peers.values())if(q.machine)online.set(q.machine.id,q.machine.name);
          const {result,refresh}=handleTeam(team,p.member,m.action,m.payload&&typeof m.payload==='object'?m.payload:{},{online});
          send(ws,{type:'response',id:m.id,result});
          if(refresh)refreshMembers();
        }catch(error){
          const known=error instanceof TeamError;if(!known)console.error('团队操作失败：',(error as Error).message);
          send(ws,{type:'response',id:m.id,error:{code:known?error.code:'team_error',message:known?error.message:'中继处理失败，请稍后重试'}});
        }
        return;
      }
      if(p.role==='phone'&&m.type==='watch') {
        // The phone's open thread; live frames for other threads are not sent to it.
        p.watch=typeof m.machineId==='string'&&typeof m.threadId==='string'&&m.threadId&&allowed(p,m.machineId)?{machineId:m.machineId,threadId:m.threadId}:undefined;
        return;
      }
      if(p.role==='phone'&&m.type==='request') {
        if(typeof m.id!=='string'||m.id.length>100||typeof m.action!=='string'||!m.payload||typeof m.payload!=='object'){ws.close(4400);return;}
        if(!allowed(p,m.machineId)){send(ws,{type:'response',id:m.id,error:{code:'forbidden',message:'你没有使用这台电脑的权限'}});return;}
        if(m.action==='session.read'&&m.payload.watch===true&&!m.payload.cursor&&typeof m.payload.threadId==='string'&&typeof m.machineId==='string')p.watch={machineId:m.machineId,threadId:m.payload.threadId};
        if(m.action==='voice.transcribe'||m.action.endsWith('file.uploadChunk')||(m.action==='turn.send'||m.action==='claude.send'||m.action==='claude.create'||m.action==='antigravity.send'||m.action==='antigravity.create')&&(m.payload.images?.length||m.payload.files?.length))send(ws,{type:'received',id:m.id});
        if(m.action==='preview.start'||m.action==='preview.stop')try{
          m.payload.threadId=textRequired(m.payload.threadId,'会话');
          if(m.action==='preview.stop')m.payload.sessionId=textRequired(m.payload.sessionId,'预览会话');
        }catch(e){send(ws,{type:'response',id:m.id,error:{code:'invalid',message:(e as Error).message}});return;}
        const connector=[...peers].find(([,q])=>q.machine?.id===m.machineId&&q.role==='connector')?.[0];
        if(!connector){send(ws,{type:'response',id:m.id,error:{code:'offline',message:'电脑未连接'}});return;}
        if([...routes.values()].filter(r=>r.phone===ws).length>=32){send(ws,{type:'response',id:m.id,error:{code:'busy',message:'请求较多，请稍后重试'}});return;}
        const routeId=randomUUID();
        const voice=m.action==='voice.transcribe';
        const timer=setTimeout(()=>finish(routeId,{error:{code:'timeout',message:voice?'语音识别超时，请重试':'电脑回执超时，请核实操作结果',uncertain:!voice}}),voice?VOICE_REQUEST_TIMEOUT_MS:40_000);
        routes.set(routeId,{phone:ws,connector,id:m.id,action:m.action,sessionId:m.payload.sessionId,threadId:m.payload.threadId,timer,machineId:m.machineId,payload:m.payload,member:p.member});
        // The relay alone says who sent a request; anything the phone claims is replaced.
        const actor=p.member?{userId:p.member.user.id,deviceId:p.member.device.id,name:p.member.user.name}:undefined;
        send(connector,{type:'request',id:routeId,action:m.action,payload:m.payload,...actor?{actor}:{}},DENSE_ACTIONS.has(m.action));
      } else if(p.role==='connector'&&m.type==='response') {
        if(routes.get(m.id)?.connector===ws)finish(m.id,m);
      } else if(p.role==='connector'&&m.type==='preview.ended') {
        preview.stopForThread(m.sessionId,m.threadId,ws);
      } else if(p.role==='connector'&&typeof m.type==='string'&&m.type.startsWith('proxy.')) {
        preview.handle(ws,m);
      } else if(p.role==='connector'&&m.type==='live'&&typeof m.threadId==='string') {
        for(const [phone,q]of peers)if(q.role==='phone'&&q.watch?.machineId===p.machine?.id&&q.watch?.threadId===m.threadId&&allowed(q,p.machine?.id))send(phone,{...m,machineId:p.machine?.id});
      } else if(p.role==='connector'&&m.type==='usage'&&Array.isArray(m.events)&&p.machine) {
        // Finished turns from the computer; the relay confirms each one it stored so the computer can forget it.
        if(!team)return;
        try{send(ws,{type:'usage.ack',ids:team.addUsage(p.machine.id,m.events.slice(0,500))});}
        catch(error){console.error('用量写入失败：',(error as Error).message);}
      } else if(p.role==='connector'&&m.type==='changed') {
        for(const [phone,q]of peers)if(q.role==='phone'&&allowed(q,p.machine?.id))send(phone,{type:'changed',machineId:p.machine?.id,threadId:m.threadId||null,generation:m.generation});
      }
    }
    ws.on('close',()=>{
      clearTimeout(authTimer);peers.delete(ws);
      preview.stopPeer(ws);
      for(const [id,r]of routes) {
        // Wait for a pending start result so cleanup names that exact session.
        if(r.phone===ws){if(r.action==='preview.start')continue;clearTimeout(r.timer);routes.delete(id);}
        else if(r.connector===ws)finish(id,{error:{code:'offline',message:'电脑连接中断，请核实操作结果',uncertain:true}});
      }
      publish();
    });
  });
  const heartbeat=setInterval(()=>{for(const [ws,p]of peers){if(!p.alive){ws.terminate();continue;}p.alive=false;ws.ping();}},15_000);
  server.on('close',()=>clearInterval(heartbeat));
  return {server,previewServer:preview.server,wss,close:async()=>{clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();for(const r of routes.values())clearTimeout(r.timer);await preview.close();await new Promise<void>(r=>wss.close(()=>server.close(()=>r())));}};
}
