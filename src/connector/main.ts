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
import { WorkspaceManager, createProjectsHandler, defaultProjectRoot } from './workspace.js';
import { recordClaudeTurn } from './usage-meter.js';
import { ClaudeVoiceAuth, ClaudeVoiceStreams } from './claude-voice.js';
import { traced } from './trace.js';
import { ThreadHub } from './thread-hub.js';
import { BLOB_ACTIONS, BLOB_UPLOADS, receiveBlob, sendBlob } from './blob.js';
import { BlobStore } from './blob-store.js';
import { LocalControlServer, type ActiveTask, type LocalControlStatus } from './local-control.js';
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
// A guest's connector runs on a borrowed computer: its private network is the host's, so only localhost is relayed.
const browserPreview=new BrowserPreview({lan:!guest});
const bridges:ServiceBridge[]=[];
// Subscriptions (docs/sync/DESIGN.md): a phone opens a thread with sync.open and gets its changes as numbered live frames.
const hub=new ThreadHub(frame=>send(frame),()=>Date.now()<traceUntil);
// Images by content for synced messages and for images a phone uploads to send (src/connector/blob-store.ts).
const images=new BlobStore(join(config.dataDir,'images'));
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
let claudeCodeBridge:ClaudeCodeBridge|undefined,antigravityBridge:AntigravityBridge|undefined;
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
  claudeCodeBridge=claudeCode;
  hub.register('claude',claudeCode.syncSource);
  // claude.ai Artifacts open in a browser profile of the connector's own (signed in once from the phone) and reach the phone as static copies.
  // A guest's profile lives in the guest folder, so clearing the guest data removes that sign-in too.
  claudeCode.artifacts=new ArtifactViewer(guest?guest.root:config.dataDir);
  bridges.push({prefix:'claude',handle:(action,payload)=>claudeCode.handle(action,payload),mutations:['claude.create','claude.send','claude.stop','claude.respond','claude.project.save','claude.fork','claude.rename','claude.archive','claude.edit','claude.steerQueued','claude.withdrawQueued','claude.cancelQueued'],
    prepareReload:()=>{if(claudeCode.busy)throw new BridgeError('active','Claude Code 任务仍在运行，请稍后更新');},close:()=>claudeCode.close()});
}
if(!guest){
  const antigravity=new AntigravityBridge(join(homedir(),'.gemini','antigravity'),ledger);
  antigravityBridge=antigravity;
  hub.register('antigravity',antigravity.syncSource);
  bridges.push({prefix:'antigravity',handle:(action,payload)=>antigravity.handle(action,payload),mutations:['antigravity.create','antigravity.send','antigravity.stop','antigravity.respond','antigravity.steerQueued','antigravity.withdrawQueued','antigravity.cancelQueued'],
    prepareReload:()=>{if(antigravity.busy)throw new BridgeError('active','Antigravity 排队消息正在处理，请稍后更新');},close:()=>antigravity.close()});
}
const useCodex=available.includes('codex');
if(useCodex)hub.register('codex',control.syncSource);
const workspace=new WorkspaceManager({projectRoots:config.projectRoots,dataDir:config.dataDir});
const handleProjects=createProjectsHandler({
  workspace,
  ledger,
  availableServices:available,
  registrars:{
    ...(useCodex?{codex:(opId,input)=>control.registerProject(opId,input)}:{}),
    ...(claudeCodeBridge?{claude:(opId,input)=>claudeCodeBridge!.registerProject(opId,input)}:{}),
    ...(antigravityBridge?{antigravity:(opId,input)=>antigravityBridge!.registerProject(opId,input)}:{}),
  },
  onChanged:()=>{control.emit('change',null);},
});
const services=new ServiceRouter(bridges,request=>{
  if(request.action==='projects.roots'||request.action==='projects.browse'||request.action==='projects.create'){
    return handleProjects(request.action,request.payload,requestActor.getStore());
  }
  if(guest&&(request.action==='runtime.reload'||request.action.startsWith('antigravity.')||request.action.startsWith('claude.')))
    throw new BridgeError('unsupported','借用电脑暂不支持此操作');
  if(!useCodex&&!['project.create','operation.read'].includes(request.action))
    throw new BridgeError('unavailable','借用电脑上的 Codex 暂不可用');
  return control.handle(request);
},()=>control.updating);
let socket:WebSocket|undefined,stopping=false,backoff=1000,retry:NodeJS.Timeout|undefined,dirty:NodeJS.Timeout|undefined;
let proxyBackpressure:NodeJS.Timeout|undefined;
let relayState:LocalControlStatus['relay']='connecting',authReason:LocalControlStatus['authReason']=null;
let teamMode=Boolean(config.token?.startsWith('cnt_')),ownToken=Boolean(config.token?.startsWith('cnt_'));
const activeMachineName=config.machineName||hostname();
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
    if(m.type==='ready'){ready=true;clearTimeout(authTimer);backoff=1000;relayState='ok';authReason=null;control.livePush=Array.isArray(m.features)&&m.features.includes('live');
      // Synced messages refer to images only through a relay that serves them.
      hub.images=Array.isArray(m.features)&&m.features.includes('blob.image')?images:null;usageRelay=Array.isArray(m.features)&&m.features.includes('team');
      teamMode=m.teamMode===true||Boolean(config.token?.startsWith('cnt_'));ownToken=m.ownToken===true||Boolean(config.token?.startsWith('cnt_'));
      usageSending=false;console.log('电脑已连接中继');flushUsage();return;}
    if(!ready)return;
    if(m.type==='usage.ack'){if(Array.isArray(m.ids))ledger.ackUsage(m.ids);usageSending=false;flushUsage();return;}
    if(typeof m.type==='string'&&m.type.startsWith('proxy.')){browserPreview.handle(m);return;}
    if(m.type==='preview.stop'){if(typeof m.sessionId==='string'&&typeof m.threadId==='string')browserPreview.stop(m.sessionId,m.threadId);return;}
    // The relay's data channel: a file goes to the relay as one HTTP upload, after the same checks as a chunked download.
    if(m.type==='blob.pull'){
      if(typeof m.stream!=='string'||!BLOB_ACTIONS.has(m.action))return;
      const payload=m.payload&&typeof m.payload==='object'?{...m.payload,stream:true,range:m.range}:{stream:true,range:m.range};
      void sendBlob(config.relayUrl,m.stream,()=>m.action==='blob.image'?images.open(payload.sha):services.handle({id:m.stream,action:m.action,payload}));
      return;
    }
    // An upload part through the data channel: the same chunk action, its bytes streamed instead of base64.
    if(m.type==='blob.push'){
      if(typeof m.stream!=='string'||!BLOB_UPLOADS.has(m.action)||!Number.isSafeInteger(m.length))return;
      const stream=m.stream,payload=m.payload&&typeof m.payload==='object'?m.payload:{};
      void receiveBlob(config.relayUrl,stream,m.length,async body=>{
        // An image to send: kept by content, referred to in the message that follows.
        if(m.action==='blob.image.put'){
          const parts:Buffer[]=[];for await(const chunk of body.stream)parts.push(chunk);
          const bytes=Buffer.concat(parts);if(bytes.length!==body.length)throw new BridgeError('incomplete','图片上传中断，请重试');
          return {ref:'cmw-image:'+images.put(bytes,String(payload.mime))};
        }
        return services.handle({id:stream,action:m.action,payload:{...payload,offset:Number(payload.offset),body}});
      })
        .then(outcome=>{if(socket===ws)try{send({type:'blob.done',stream,...outcome});}catch{}});
      return;
    }
    if(m.type!=='request')return;
    const respond=(promise:Promise<Json>)=>promise.then(result=>{if(socket===ws)send({type:'response',id:m.id,result});},e=>{
      const err=e instanceof BridgeError?e:new BridgeError('computer_error','电脑处理失败，请查看本机状态');
      if(socket===ws)send({type:'response',id:m.id,error:{code:err.code,message:err.message,uncertain:err.uncertain}});
    });
    // Audio is taken in the order it arrives, before anything else can interleave.
    if(typeof m.action==='string'&&m.action.startsWith('voice.stream.')){void respond(handleVoiceStream(m.action,m.payload&&typeof m.payload==='object'?m.payload:{}));return;}
    // A traced request (web/trace.ts) reports how long it took here; live frames carry timings for a while after one.
    const traceOn=m.trace===true;if(traceOn)traceUntil=Date.now()+TRACE_LIVE_MS;
    // Only the data channel above opens files for streaming; a phone cannot ask for it.
    if(m.payload&&typeof m.payload==='object'){delete m.payload.stream;delete m.payload.range;}
    // Images uploaded beforehand arrive as references; the runtimes and the ledger get the data URLs as before.
    if(m.payload&&typeof m.payload==='object'&&m.payload.images!==undefined)try{m.payload.images=await images.resolve(m.payload.images);}
      catch(e){if(socket===ws)send({type:'response',id:m.id,error:{code:(e as BridgeError).code||'invalid',message:(e as Error).message}});return;}
    const started=performance.now();
    try{
      // Operations started by this request record the team member the relay names as its sender.
      const {value:result,trace}=await traced(traceOn,()=>requestActor.run(actorOf(m.actor),async()=>m.action==='preview.start'?(m.payload?.filePath!==undefined?await browserPreview.startFile(m.payload.filePath,m.payload.threadId):await browserPreview.startAddress(m.payload?.url,m.payload?.threadId))
        :m.action==='preview.stop'?{stopped:browserPreview.stopForThread(m.payload?.sessionId,m.payload?.threadId)}
        :m.action==='sync.open'?await hub.open(m.payload&&typeof m.payload==='object'?m.payload:{})
        :m.action==='sync.page'?await hub.page(m.payload&&typeof m.payload==='object'?m.payload:{})
        :await services.handle({id:String(m.id),action:String(m.action) as BridgeRequest['action'],payload:m.payload&&typeof m.payload==='object'?m.payload:{}})));
      if(socket===ws)send({type:'response',id:m.id,result,...trace?{trace}:{}});
    }
    catch(e){const err=e instanceof BridgeError?e:new BridgeError('computer_error','电脑处理失败，请查看本机状态');if(socket===ws)send({type:'response',id:m.id,error:{code:err.code,message:err.message,uncertain:err.uncertain},
      ...traceOn?{trace:{handleMs:Math.round((performance.now()-started)*10)/10,now:Date.now(),steps:{}}}:{}});}
  });
  ws.on('error',()=>{});
  ws.on('close',(code,reason)=>{
    clearInterval(proxyBackpressure);proxyBackpressure=undefined;usageSending=false;
    void browserPreview.stop();dropVoiceStreams();
    clearTimeout(authTimer);clearInterval(pulse);if(stopping)return;
    const reasonText=Buffer.isBuffer(reason)?reason.toString('utf8'):String(reason||'');
    if(code===4401||code===4409){
      relayState=code===4401?'unauthorized':'unreachable';
      authReason=code===4401?(reasonText==='machine_token_mismatch'?'machine_token_mismatch':'invalid_token'):'replaced';
      console.error(code===4401?(guest?'连接 Token 不匹配，请检查中继配置':'连接 Token 不匹配，请在电脑更新配置'):'同一电脑连接已被替换');
      if(guest){services.close();control.close();process.exit(1);}
      return;
    }
    relayState='unreachable';authReason=null;
    retry=setTimeout(connect,backoff+Math.random()*500);backoff=Math.min(15_000,backoff*2);
  });
}
// Structural changes ask phones to read again; bursts within this window share one notice.
const CHANGE_DELAY=60;
// Running-turn content is pushed at most once per window; changes within it are merged into one frame.
// The first change after a quiet window goes out at once, so a reply's first words are not held back.
const LIVE_DELAY=40;
// After a traced request, live frames say when their first change arrived (`at`, this clock) and how long it waited (`queuedMs`).
const TRACE_LIVE_MS=5*60_000;let traceUntil=0;
const liveIds=new Map<string,number>();let liveTimer:NodeJS.Timeout|undefined,liveSentAt=0;
function scheduleLive(id:string){
  if(!liveIds.has(id))liveIds.set(id,Date.now());if(liveTimer)return;
  liveTimer=setTimeout(()=>{
    liveTimer=undefined;liveSentAt=Date.now();const ids=[...liveIds];liveIds.clear();
    const timed=Date.now()<traceUntil;
    for(const [threadId,at] of ids){try{const frame=control.liveFrame(threadId);if(frame)send({type:'live',...frame,...timed?{at,queuedMs:Date.now()-at}:{}});}catch{}}
  },Math.max(0,LIVE_DELAY-(Date.now()-liveSentAt)));
}
control.on('stream',(id:string)=>scheduleLive(id));
control.on('change',(id:string|null)=>{
  if(id)scheduleLive(id);
  dirtyIds.add(id);if(dirty)return;
  dirty=setTimeout(()=>{dirty=undefined;try{for(const threadId of dirtyIds)send({type:'changed',threadId,generation:control.generation});}catch{}dirtyIds.clear();},CHANGE_DELAY);
});
const localControl=new LocalControlServer({
  dataDir:config.dataDir,
  getStatus:async()=>{
    const info=useCodex?await Promise.race([services.handle({id:'local-status',action:'info',payload:{}}).catch(()=>null),new Promise<null>(r=>setTimeout(()=>r(null),2500))]):null;
    const claudeCheck=claudeCodeBridge?.artifacts?await Promise.race([claudeCodeBridge.handle('claude.artifact.login',{op:'check'}).catch(()=>null),new Promise<null>(r=>setTimeout(()=>r(null),2000))]):null;
    const claudeSignIn=claudeCheck&&claudeCheck.available!==false&&(claudeCheck.signedIn==='yes'||claudeCheck.signedIn==='no'||claudeCheck.signedIn==='unknown')?claudeCheck.signedIn:undefined;
    const activeTasks:ActiveTask[]=[
      ...useCodex?control.activeTasks():[],
      ...claudeCodeBridge?.activeTasks()||[],
      ...antigravityBridge?.activeTasks()||[],
    ];
    return {
      relay:relayState,
      authReason,
      connector:relayState==='ok'?'online':'offline',
      teamMode,
      ownToken,
      machineId:config.machineId,
      machineName:activeMachineName,
      services:[...available],
      ...info?.runtime?.version?{codexVersion:String(info.runtime.version)}:{},
      ...info?{desktopOnline:Boolean(info.desktopOnline)}:{},
      ...claudeSignIn?{claudeSignIn}:{},
      activeTasks,
      pendingUsage:ledger.pendingUsageCount(),
      projectRoots:config.projectRoots||[],
      defaultProjectRoot:defaultProjectRoot(),
    };
  },
  handleRequest:(action,payload)=>services.handle({id:'local',action:action as BridgeRequest['action'],payload}),
});
void localControl.start().catch(error=>console.error('本机控制通道未能启动：',error instanceof Error?error.message:error));
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
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;clearTimeout(retry);clearTimeout(dirty);clearTimeout(liveTimer);localControl.close();void browserPreview.stop();closeVoiceStreams();hub.close();services.close();socket?.close();control.close();process.exit(0);});
