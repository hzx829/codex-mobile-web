import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { readConfig } from '../shared/config.js';
import { MAX_FRAME, BridgeError, type Json } from '../shared/types.js';
import { Ledger } from './ledger.js';
import { Control } from './control.js';
import { BrowserPreview } from './browser-preview.js';
import { ChatGPTBridge } from './chatgpt.js';
import { AntigravityBridge } from './antigravity.js';
import { ServiceRouter } from './services.js';
import { ClaudeCodeBridge } from './claude-code.js';
const config=readConfig();
if(config.codexBin)process.env.CODEX_BIN=config.codexBin;
if(config.legacyCodexBin)process.env.CODEX_LEGACY_BIN=config.legacyCodexBin;
if(config.codexHome)process.env.CODEX_HOME=config.codexHome;
if(config.profile)process.env.CODEX_PROFILE=config.profile;
if(config.claudeBin)process.env.CLAUDE_CODE_BIN=config.claudeBin;
mkdirSync(config.dataDir,{recursive:true});
const ledger=new Ledger(join(config.dataDir,'operations.sqlite'));
const control=new Control(ledger);
const antigravity=new AntigravityBridge(join(homedir(),'.gemini','antigravity'),ledger);
control.bundleHash=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const browserPreview=new BrowserPreview();
const claudeCode=new ClaudeCodeBridge(ledger);
const chatgpt=new ChatGPTBridge(config.dataDir,config.chatgptPort||3342);
const services=new ServiceRouter([
  {prefix:'chatgpt',handle:(action,payload)=>chatgpt.handle(action,payload),mutations:['chatgpt.send','chatgpt.stop'],prepareReload:()=>chatgpt.prepareReload(),close:()=>chatgpt.close()},
  {prefix:'antigravity',handle:(action,payload)=>antigravity.handle(action,payload),mutations:['antigravity.send','antigravity.stop']},
  {prefix:'claude',handle:(action,payload)=>claudeCode.handle(action,payload),mutations:['claude.create','claude.send','claude.stop','claude.respond'],
    prepareReload:()=>{if(claudeCode.busy)throw new BridgeError('active','Claude Code 任务仍在运行，请稍后更新');},close:()=>claudeCode.close()},
],request=>control.handle(request as any),()=>control.updating);
// Codex is optional: without it the other apps on this computer must still reach the phone.
await control.start().catch(error=>console.error('Codex 暂不可用，连接器会在后台重试：',error instanceof Error?error.message:error));
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
  const url=new URL('/ws',config.relayUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(url,{maxPayload:MAX_FRAME});socket=ws;
  let alive=true;
  const pulse=setInterval(()=>{if(ws.readyState!==WebSocket.OPEN)return;if(!alive){ws.terminate();return;}alive=false;ws.ping();},15_000);
  ws.on('pong',()=>{alive=true;});
  let ready=false;const authTimer=setTimeout(()=>ws.terminate(),10_000);
  ws.on('open',()=>send({type:'hello',role:'connector',token:config.token,machineId:config.machineId,name:config.machineName||hostname()}));
  ws.on('message',async data=>{
    let m:Json;try{m=JSON.parse(data.toString());}catch{return;}
    if(m.type==='ready'){ready=true;clearTimeout(authTimer);backoff=1000;console.log('电脑已连接中继');return;}
    if(!ready)return;
    if(typeof m.type==='string'&&m.type.startsWith('proxy.')){browserPreview.handle(m);return;}
    if(m.type==='preview.stop'){if(typeof m.sessionId==='string'&&typeof m.threadId==='string')browserPreview.stop(m.sessionId,m.threadId);return;}
    if(m.type!=='request')return;
    try{
      const result=m.action==='preview.start'?(m.payload?.filePath!==undefined?await browserPreview.startFile(m.payload.filePath,m.payload.threadId):browserPreview.start(m.payload?.url,m.payload?.threadId))
        :m.action==='preview.stop'?{stopped:browserPreview.stopForThread(m.payload?.sessionId,m.payload?.threadId)}
        :await services.handle({id:String(m.id),action:m.action,payload:m.payload&&typeof m.payload==='object'?m.payload:{}});
      if(socket===ws)send({type:'response',id:m.id,result});
    }
    catch(e){const err=e instanceof BridgeError?e:new BridgeError('computer_error','电脑处理失败，请查看本机状态');if(socket===ws)send({type:'response',id:m.id,error:{code:err.code,message:err.message,uncertain:err.uncertain}});}
  });
  ws.on('error',()=>{});
  ws.on('close',code=>{
    clearInterval(proxyBackpressure);proxyBackpressure=undefined;
    void browserPreview.stop();
    clearTimeout(authTimer);clearInterval(pulse);if(stopping)return;
    if(code===4401||code===4409){console.error(code===4401?'连接 Token 不匹配，请在电脑更新配置':'同一电脑连接已被替换');return;}
    retry=setTimeout(connect,backoff+Math.random()*500);backoff=Math.min(15_000,backoff*2);
  });
}
control.on('change',(id:string|null)=>{
  dirtyIds.add(id);if(dirty)return;
  dirty=setTimeout(()=>{dirty=undefined;try{for(const threadId of dirtyIds)send({type:'changed',threadId,generation:control.generation});}catch{}dirtyIds.clear();},200);
});
connect();
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;clearTimeout(retry);clearTimeout(dirty);void browserPreview.stop();services.close();socket?.close();control.close();process.exit(0);});
