import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { readConfig } from '../shared/config.js';
import { MAX_FRAME, BridgeError, bridgeServices, type BridgeRequest, type Json } from '../shared/types.js';
import { CONNECTOR_FEATURES, PROTOCOL_VERSION } from '../shared/protocol.js';
import { Ledger, actorOf, requestActor } from './ledger.js';
import { Control } from './control.js';
import { BrowserPreview } from './browser-preview.js';
import { AntigravityBridge } from './antigravity.js';
import { AntigravityVoiceStreams } from './antigravity-voice.js';
import { ServiceRouter, type ServiceBridge } from './services.js';
import { ClaudeCodeBridge, sdkQuery } from './claude-code.js';
import { ClaudeRuntime, PERMISSION_MODES } from './claude-runtime.js';
import { ArtifactViewer } from './claude-artifacts.js';
import { GUEST_ENTRYPOINT, NoDesktop, preflight, returnLogins, useGuestHomes } from './guest.js';
import { checkClaude, checkCodex, type CheckResult, type ClaudeLoader } from './guest-checks.js';
import { setWorkspace } from './project.js';
import { recordClaudeTurn } from './usage-meter.js';
import { ClaudeVoiceAuth, ClaudeVoiceStreams } from './claude-voice.js';
const config=readConfig();
if(config.codexBin)process.env.CODEX_BIN=config.codexBin;
if(config.legacyCodexBin)process.env.CODEX_LEGACY_BIN=config.legacyCodexBin;
if(config.codexHome&&!config.guest)process.env.CODEX_HOME=config.codexHome;
if(config.profile)process.env.CODEX_PROFILE=config.profile;
if(config.claudeBin)process.env.CLAUDE_CODE_BIN=config.claudeBin;
const guest=config.guestPaths;
if(guest&&(typeof config.machineId!=='string'||!config.machineId.startsWith('guest-')))
  throw new Error('访客配置缺少有效的电脑 ID');
if(process.argv.includes('--return-login')){
  // Run by the guest launcher after stopping the connector: the owner gets back the login the guest refreshed.
  const result=guest?await returnLogins(guest):{messages:[],failed:false};
  for(const message of result.messages)console.log(message);
  process.exit(result.failed?1:0);
}
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
// Dictation streams through Claude Code's login or the local Antigravity Hub, routed by each stream's provider.
let renewClaudeLogin=async()=>{};
const claudeVoiceStreams=new ClaudeVoiceStreams(new ClaudeVoiceAuth(()=>renewClaudeLogin()));
const antigravityVoiceStreams=guest?undefined:new AntigravityVoiceStreams(join(homedir(),'.gemini','antigravity'));
const voiceProviders=new Map<string,'claude'|'antigravity'>();
function handleVoiceStream(action:string,payload:Json):Promise<Json>{
  const id=typeof payload.id==='string'?payload.id:'';
  if(action==='voice.stream.open'){
    const provider=payload.provider==='antigravity'?'antigravity':'claude';
    if(provider==='antigravity'){
      if(!antigravityVoiceStreams)return Promise.reject(new BridgeError('unsupported','借用电脑不支持 Antigravity 语音识别'));
      if(id)voiceProviders.set(id,'antigravity');
      return antigravityVoiceStreams.handle(action,payload);
    }
    if(id)voiceProviders.set(id,'claude');
    return claudeVoiceStreams.handle(action,payload);
  }
  const owner=id?voiceProviders.get(id):undefined;
  if(action==='voice.stream.close'||action==='voice.stream.cancel')if(id)voiceProviders.delete(id);
  if(owner==='antigravity'&&antigravityVoiceStreams)return antigravityVoiceStreams.handle(action,payload);
  return claudeVoiceStreams.handle(action,payload);
}
function dropVoiceStreams(){voiceProviders.clear();claudeVoiceStreams.dropAll();antigravityVoiceStreams?.dropAll();}
function closeVoiceStreams(){voiceProviders.clear();claudeVoiceStreams.close();antigravityVoiceStreams?.close();}
if(available.includes('claude')){
  // CLAUDE_CODE_ENTRYPOINT: by default 'codex-mobile-web', which the terminal's `claude --resume` list shows; `claudeEntrypoint`
  // overrides it. A guest's sessions use 'sdk-ts', which that list hides. See docs/claude-local/M1-RESULTS.md.
  const entrypoint=guest?GUEST_ENTRYPOINT:typeof config.claudeEntrypoint==='string'&&config.claudeEntrypoint?config.claudeEntrypoint:undefined;
  // On your own computer sessions skip permission prompts unless the phone picks another mode; `claudePermissionMode` overrides it.
  // A borrowed computer keeps Claude Code's default (ask when needed).
  const configuredMode=PERMISSION_MODES.find(mode=>mode===config.claudePermissionMode);
  const defaultMode=guest?'default':configuredMode||'bypassPermissions';
  const claudeRuntime=new ClaudeRuntime(sdkQuery,undefined,undefined,entrypoint,defaultMode);
  renewClaudeLogin=()=>claudeRuntime.renewLogin(guest?.workspace);
  claudeRuntime.on('turn',(session,result,opId)=>recordClaudeTurn(ledger,session.id,session.usageBaseline,result,opId));
  const claudeCode=new ClaudeCodeBridge(ledger,undefined,undefined,undefined,claudeRuntime);
  // claude.ai Artifacts open in a browser profile of the connector's own (signed in once from the phone) and reach the phone as static copies.
  // A guest's profile lives in the guest folder, so clearing the guest data removes that sign-in too.
  claudeCode.artifacts=new ArtifactViewer(guest?guest.root:config.dataDir);
  bridges.push({prefix:'claude',handle:(action,payload)=>claudeCode.handle(action,payload),mutations:['claude.create','claude.send','claude.stop','claude.respond','claude.project.save','claude.fork','claude.rename','claude.archive','claude.edit','claude.steerQueued','claude.withdrawQueued','claude.cancelQueued'],
    prepareReload:()=>{if(claudeCode.busy)throw new BridgeError('active','Claude Code 任务仍在运行，请稍后更新');},close:()=>claudeCode.close()});
}
if(!guest){
  const antigravity=new AntigravityBridge(join(homedir(),'.gemini','antigravity'),ledger);
  bridges.push({prefix:'antigravity',handle:(action,payload)=>antigravity.handle(action,payload),mutations:['antigravity.create','antigravity.send','antigravity.stop','antigravity.respond']});
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
// Finished turns go to a team relay in batches; each stays in the ledger until the relay confirms it.
let usageRelay=false,usageSending=false;
function flushUsage(){
  if(!usageRelay||usageSending||socket?.readyState!==WebSocket.OPEN)return;
  const events=ledger.pendingUsage(200);if(!events.length)return;
  usageSending=true;
  try{send({type:'usage',events});}catch{usageSending=false;}
}
ledger.onUsage=()=>setImmediate(flushUsage);
// A batch the relay never confirmed (for example lost while it restarted) is sent again.
setInterval(()=>{usageSending=false;flushUsage();},60_000).unref();
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
  ws.on('open',()=>send({type:'hello',role:'connector',token:config.token,machineId:config.machineId,name:config.machineName||hostname(),services:available,protocol:PROTOCOL_VERSION,features:CONNECTOR_FEATURES,...guest?{guest:true}:{}}));
  ws.on('message',async data=>{
    let m:Json;try{m=JSON.parse(data.toString());}catch{return;}
    if(m.type==='ready'){ready=true;clearTimeout(authTimer);backoff=1000;control.livePush=Array.isArray(m.features)&&m.features.includes('live');usageRelay=Array.isArray(m.features)&&m.features.includes('team');usageSending=false;console.log('电脑已连接中继');flushUsage();return;}
    if(!ready)return;
    if(m.type==='usage.ack'){if(Array.isArray(m.ids))ledger.ackUsage(m.ids);usageSending=false;flushUsage();return;}
    if(typeof m.type==='string'&&m.type.startsWith('proxy.')){browserPreview.handle(m);return;}
    if(m.type==='preview.stop'){if(typeof m.sessionId==='string'&&typeof m.threadId==='string')browserPreview.stop(m.sessionId,m.threadId);return;}
    if(m.type!=='request')return;
    const respond=(promise:Promise<Json>)=>promise.then(result=>{if(socket===ws)send({type:'response',id:m.id,result});},e=>{
      const err=e instanceof BridgeError?e:new BridgeError('computer_error','电脑处理失败，请查看本机状态');
      if(socket===ws)send({type:'response',id:m.id,error:{code:err.code,message:err.message,uncertain:err.uncertain}});
    });
    // Audio is taken in the order it arrives, before anything else can interleave.
    if(typeof m.action==='string'&&m.action.startsWith('voice.stream.')){void respond(handleVoiceStream(m.action,m.payload&&typeof m.payload==='object'?m.payload:{}));return;}
    try{
      // Operations started by this request record the team member the relay names as its sender.
      const result=await requestActor.run(actorOf(m.actor),async()=>m.action==='preview.start'?(m.payload?.filePath!==undefined?await browserPreview.startFile(m.payload.filePath,m.payload.threadId):browserPreview.start(m.payload?.url,m.payload?.threadId))
        :m.action==='preview.stop'?{stopped:browserPreview.stopForThread(m.payload?.sessionId,m.payload?.threadId)}
        :await services.handle({id:String(m.id),action:String(m.action) as BridgeRequest['action'],payload:m.payload&&typeof m.payload==='object'?m.payload:{}}));
      if(socket===ws)send({type:'response',id:m.id,result});
    }
    catch(e){const err=e instanceof BridgeError?e:new BridgeError('computer_error','电脑处理失败，请查看本机状态');if(socket===ws)send({type:'response',id:m.id,error:{code:err.code,message:err.message,uncertain:err.uncertain}});}
  });
  ws.on('error',()=>{});
  ws.on('close',code=>{
    clearInterval(proxyBackpressure);proxyBackpressure=undefined;usageSending=false;
    void browserPreview.stop();dropVoiceStreams();
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
// Running-turn content is pushed at most once per window; changes within it are merged into one frame.
// The first change after a quiet window goes out at once, so a reply's first words are not held back.
const LIVE_DELAY=40;
const liveIds=new Set<string>();let liveTimer:NodeJS.Timeout|undefined,liveSentAt=0;
function scheduleLive(id:string){
  liveIds.add(id);if(liveTimer)return;
  liveTimer=setTimeout(()=>{
    liveTimer=undefined;liveSentAt=Date.now();const ids=[...liveIds];liveIds.clear();
    for(const threadId of ids){try{const frame=control.liveFrame(threadId);if(frame)send({type:'live',...frame});}catch{}}
  },Math.max(0,LIVE_DELAY-(Date.now()-liveSentAt)));
}
control.on('stream',(id:string)=>scheduleLive(id));
control.on('change',(id:string|null)=>{
  if(id)scheduleLive(id);
  dirtyIds.add(id);if(dirty)return;
  dirty=setTimeout(()=>{dirty=undefined;try{for(const threadId of dirtyIds)send({type:'changed',threadId,generation:control.generation});}catch{}dirtyIds.clear();},CHANGE_DELAY);
});
connect();
// Keep the relay connection independent of Codex startup and recovery.
const codexStarted=useCodex?control.start():undefined;
codexStarted?.catch(error=>console.error('Codex 暂不可用，连接器会在后台重试：',error instanceof Error?error.message:error));
if(guest&&process.env.BRIDGE_GUEST_CHECK!=='0'){
  const report=(label:string,result:CheckResult)=>console.log(result.ok?`${label}：测试通过，可以使用${result.message?`（${result.message}）`:''}`:`${label}：${result.message}`);
  if(codexStarted){
    console.log('Codex：正在发送一条测试消息…');
    void codexStarted.then(()=>checkCodex(control.runtime,guest.workspace),()=>({ok:false,message:'Codex 没能启动，请查看下方错误'})).then(result=>report('Codex',result));
  }
  if(available.includes('claude')){
    console.log('Claude Code：正在发送一条测试消息…');
    void checkClaude(sdkQuery as unknown as ClaudeLoader,guest.workspace).then(result=>report('Claude Code',result));
  }
}
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;clearTimeout(retry);clearTimeout(dirty);clearTimeout(liveTimer);void browserPreview.stop();closeVoiceStreams();services.close();socket?.close();control.close();process.exit(0);});
