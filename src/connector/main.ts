import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { readConfig } from '../shared/config.js';
import { MAX_FRAME, BridgeError, bridgeServices, type BridgeRequest, type Json } from '../shared/types.js';
import { Ledger } from './ledger.js';
import { Control } from './control.js';
import { BrowserPreview } from './browser-preview.js';
import { AntigravityBridge } from './antigravity.js';
import { ServiceRouter, type ServiceBridge } from './services.js';
import { ClaudeCodeBridge, sdkQuery } from './claude-code.js';
import { ClaudeRuntime } from './claude-runtime.js';
import { NoDesktop, preflight, useGuestHomes } from './guest.js';
import { setWorkspace } from './project.js';
const config=readConfig();
if(config.codexBin)process.env.CODEX_BIN=config.codexBin;
if(config.legacyCodexBin)process.env.CODEX_LEGACY_BIN=config.legacyCodexBin;
if(config.codexHome&&!config.guest)process.env.CODEX_HOME=config.codexHome;
if(config.profile)process.env.CODEX_PROFILE=config.profile;
if(config.claudeBin)process.env.CLAUDE_CODE_BIN=config.claudeBin;
const guest=config.guestPaths;
if(guest&&(typeof config.machineId!=='string'||!config.machineId.startsWith('guest-')))
  throw new Error('访客配置缺少有效的电脑 ID');
const checks=guest?await preflight(guest):undefined;
const available=checks?.services??bridgeServices;
if(checks){
  for(const message of checks.messages)console.log(message);
  if(!available.length){
    console.error('请先安装并登录 Codex 或 Claude Code。');
    process.exit(1);
  }
}
if(process.argv.includes('--preflight'))process.exit(0);
if(guest){
  useGuestHomes(guest);
  await setWorkspace(guest.workspace);
}
mkdirSync(config.dataDir,{recursive:true});
const ledger=new Ledger(join(config.dataDir,'operations.sqlite'));
const control=new Control(ledger,undefined,guest?new NoDesktop():undefined);
control.bundleHash=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const browserPreview=new BrowserPreview();
const bridges:ServiceBridge[]=[];
if(available.includes('claude')){
  const entrypoint=!guest&&typeof config.claudeEntrypoint==='string'&&config.claudeEntrypoint||false;
  const claudeCode=new ClaudeCodeBridge(ledger,undefined,undefined,undefined,new ClaudeRuntime(sdkQuery,undefined,undefined,entrypoint));
  bridges.push({prefix:'claude',handle:(action,payload)=>claudeCode.handle(action,payload),mutations:['claude.create','claude.send','claude.stop','claude.respond','claude.project.save'],
    prepareReload:()=>{if(claudeCode.busy)throw new BridgeError('active','Claude Code 任务仍在运行，请稍后更新');},close:()=>claudeCode.close()});
}
if(!guest){
  const antigravity=new AntigravityBridge(join(homedir(),'.gemini','antigravity'),ledger);
  bridges.push({prefix:'antigravity',handle:(action,payload)=>antigravity.handle(action,payload),mutations:['antigravity.send','antigravity.stop']});
}
const useCodex=available.includes('codex');
const services=new ServiceRouter(bridges,request=>{
  if(guest&&(request.action==='runtime.reload'||request.action.startsWith('antigravity.')||request.action.startsWith('claude.')))
    throw new BridgeError('unsupported','借用电脑暂不支持此操作');
  if(!useCodex&&!['project.create','operation.read'].includes(request.action))
    throw new BridgeError('unavailable','借用电脑上的 Codex 暂不可用');
  return control.handle(request);
},()=>control.updating);
let socket:WebSocket|undefined,stopping=false,backoff=1000,retry:NodeJS.Timeout|undefined,dirty:NodeJS.Timeout|undefined;
let proxyBackpressure:NodeJS.Timeout|undefined;
const dirtyIds=new Set<string|null>();
function send(value:Json){if(socket?.readyState===WebSocket.OPEN){const frame=JSON.stringify(value);if(Buffer.byteLength(frame)>MAX_FRAME||socket.bufferedAmount>MAX_FRAME)throw new BridgeError('too_large','会话内容较大，请减少历史范围');socket.send(frame);}}
browserPreview.on('message',(message:Json)=>{try{
  send(message);
  if(message.type==='proxy.http.data'&&!proxyBackpressure&&(socket?.bufferedAmount||0)>2_000_000){
    browserPreview.pauseResponses();
    proxyBackpressure=setInterval(()=>{if(!socket||socket.bufferedAmount<500_000){clearInterval(proxyBackpressure);proxyBackpressure=undefined;browserPreview.resumeResponses();}},20);
  }
}catch{}});
browserPreview.on('ended',(event:Json)=>{try{send({type:'preview.ended',...event});}catch{}});
function connect() {
  if(guest)console.log('正在连接中继…');
  const url=new URL('/ws',config.relayUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(url,{maxPayload:MAX_FRAME});socket=ws;
  let alive=true;
  const pulse=setInterval(()=>{if(ws.readyState!==WebSocket.OPEN)return;if(!alive){ws.terminate();return;}alive=false;ws.ping();},15_000);
  ws.on('pong',()=>{alive=true;});
  let ready=false;const authTimer=setTimeout(()=>ws.terminate(),10_000);
  ws.on('open',()=>send({type:'hello',role:'connector',token:config.token,machineId:config.machineId,name:config.machineName||hostname(),services:available,...guest?{guest:true}:{}}));
  ws.on('message',async data=>{
    let m:Json;try{m=JSON.parse(data.toString());}catch{return;}
    if(m.type==='ready'){ready=true;clearTimeout(authTimer);backoff=1000;control.livePush=Array.isArray(m.features)&&m.features.includes('live');console.log('电脑已连接中继');return;}
    if(!ready)return;
    if(typeof m.type==='string'&&m.type.startsWith('proxy.')){browserPreview.handle(m);return;}
    if(m.type==='preview.stop'){if(typeof m.sessionId==='string'&&typeof m.threadId==='string')browserPreview.stop(m.sessionId,m.threadId);return;}
    if(m.type!=='request')return;
    try{
      const result=m.action==='preview.start'?(m.payload?.filePath!==undefined?await browserPreview.startFile(m.payload.filePath,m.payload.threadId):browserPreview.start(m.payload?.url,m.payload?.threadId))
        :m.action==='preview.stop'?{stopped:browserPreview.stopForThread(m.payload?.sessionId,m.payload?.threadId)}
        :await services.handle({id:String(m.id),action:String(m.action) as BridgeRequest['action'],payload:m.payload&&typeof m.payload==='object'?m.payload:{}});
      if(socket===ws)send({type:'response',id:m.id,result});
    }
    catch(e){const err=e instanceof BridgeError?e:new BridgeError('computer_error','电脑处理失败，请查看本机状态');if(socket===ws)send({type:'response',id:m.id,error:{code:err.code,message:err.message,uncertain:err.uncertain}});}
  });
  ws.on('error',()=>{});
  ws.on('close',code=>{
    clearInterval(proxyBackpressure);proxyBackpressure=undefined;
    void browserPreview.stop();
    clearTimeout(authTimer);clearInterval(pulse);if(stopping)return;
    if(code===4401||code===4409){
      console.error(code===4401?(guest?'连接 Token 不匹配，请检查中继配置':'连接 Token 不匹配，请在电脑更新配置'):'同一电脑连接已被替换');
      if(guest){services.close();control.close();process.exit(1);}
      return;
    }
    retry=setTimeout(connect,backoff+Math.random()*500);backoff=Math.min(15_000,backoff*2);
  });
}
// Structural changes ask phones to read again; bursts within this window share one notice.
const CHANGE_DELAY=60;
// Running-turn content is pushed; frames within this window are merged into one.
const LIVE_DELAY=40;
const liveIds=new Set<string>();let liveTimer:NodeJS.Timeout|undefined;
function scheduleLive(id:string){
  liveIds.add(id);if(liveTimer)return;
  liveTimer=setTimeout(()=>{
    liveTimer=undefined;const ids=[...liveIds];liveIds.clear();
    for(const threadId of ids){try{const frame=control.liveFrame(threadId);if(frame)send({type:'live',...frame});}catch{}}
  },LIVE_DELAY);
}
control.on('stream',(id:string)=>scheduleLive(id));
control.on('change',(id:string|null)=>{
  if(id)scheduleLive(id);
  dirtyIds.add(id);if(dirty)return;
  dirty=setTimeout(()=>{dirty=undefined;try{for(const threadId of dirtyIds)send({type:'changed',threadId,generation:control.generation});}catch{}dirtyIds.clear();},CHANGE_DELAY);
});
connect();
// Keep the relay connection independent of Codex startup and recovery.
if(useCodex)void control.start().catch(error=>console.error('Codex 暂不可用，连接器会在后台重试：',error instanceof Error?error.message:error));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;clearTimeout(retry);clearTimeout(dirty);clearTimeout(liveTimer);void browserPreview.stop();services.close();socket?.close();control.close();process.exit(0);});
