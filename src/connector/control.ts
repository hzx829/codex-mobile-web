import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AppServer, resolveCodex } from './app-server.js';
import { resolve } from 'node:path';
import { Desktop } from './desktop.js';
import { Ledger } from './ledger.js';
import { codexRetryText, desktopTurns, normalizeSession, normalizeTurn, turnPage } from './normalize.js';
import { LiveDiff, RuntimeLive, type LiveFrame } from './live.js';
import { approvalResult } from './approvals.js';
import { createGuestProject, guestWorkspace, projectDirectory, readProjectFile, downloadProjectFile, openProjectDownload, workspaceProjects } from './project.js';
import { nativeProjects, indexedSessions, indexedProjectPaths } from './projects.js';
import { indexedTurnHasWriter, readPaginatedHistory } from './paginated-history.js';
import { BridgeError, textRequired, turnFinished, type Json, type BridgeRequest, type SessionView, type ContextUsage, type ThreadStatus, type TurnCursor, type TurnView } from '../shared/types.js';
import {imageBytes} from '../shared/images.js';
import {validateAttachments,uploadId,fileAttachment} from '../shared/attachments.js';
import {startUpload,appendUpload,attachmentLinks,UploadBody} from './attachments.js';
import {contextUsage,accountLimits} from './usage.js';
import {codexBase,codexTokens} from './usage-meter.js';
import {markCodexSenders} from './message-senders.js';
import {readModels,reasoningEffort} from './models.js';
import {revertThread} from './revert.js';
import {fastTier} from '../shared/models.js';
import {transcribeVoice} from './voice.js';
import {sessionSnapshot} from './session-snapshot.js';
import type {ThreadSource} from './thread-hub.js';
import {step,stepSync} from './trace.js';

/** A phone keeps a thread watched by reading it; the poll renews well within this. */
const WATCH_MS=30_000;

/** Where the running turn of a desktop state lives, so patches can be attributed to it. */
function liveLocation(state:Json):{key:string;turn:Json;path:(string|number)[];container:string[]}|null {
  const history=state?.turnHistory?.history;
  if(state?.turnHistory?.kind==='canonical'&&history?.entitiesByKey) {
    const keys:string[]=history.islands?.flatMap((island:Json)=>island.entries?.map((e:Json)=>e.value||e.key)||[])||[];
    const key=keys.at(-1),turn=key?history.entitiesByKey[key]:undefined;
    return key&&turn?{key,turn,path:['turnHistory','history','entitiesByKey',key],container:['turnHistory']}:null;
  }
  const turns=state?.turns;if(!Array.isArray(turns)||!turns.length)return null;
  const turn=turns.at(-1);
  return {key:String(turn?.turnId||turn?.id||''),turn,path:['turns',turns.length-1],container:['turns']};
}
const startsWith=(path:unknown,prefix:(string|number)[])=>Array.isArray(path)&&path.length>=prefix.length&&prefix.every((key,index)=>path[index]===key);
/** Everything the phone shows about a desktop thread except the running turn's items. States are never mutated, so this is cached per state. */
const metas=new WeakMap<object,string>();
function desktopMeta(state:Json){
  let meta=metas.get(state);
  if(meta===undefined){
    const view=normalizeSession(state,'desktop',state.requests||[],1);
    meta=JSON.stringify({...view,turns:view.turns.map(turn=>[turn.id,turn.status,turn.error,turn.items.map(item=>item.id)])});
    metas.set(state,meta);
  }
  return meta;
}

function approvalPolicy(value:unknown):'on-request'|'never'|undefined {
  if(value===undefined||value===null||value==='')return undefined;
  if(value==='on-request'||value==='never')return value;
  throw new BridgeError('invalid','审批策略无效');
}

/** Turns a followed thread sends at a time (older ones come by page), and how often it is read again regardless. */
const SYNC_WINDOW=20,SYNC_REREAD_MS=10_000;
export class Control extends EventEmitter {
  bundleHash='';
  generation=randomUUID();
  /** Whether the relay forwards live frames; an older relay only forwards change notices. */
  livePush=true;
  private loaded=new Set<string>();
  private settings=new Map<string,Json>();
  private diffs=new Map<string,string>();
  private starting=new Map<string,string>();
  private retries=new Map<string,{turnId:string;text:string}>();
  private contexts=new Map<string,ContextUsage|null>();
  /** Turns started from a phone until they finish: the operation that started each, and for desktop turns the token total before it. */
  private turnStarts=new Map<string,{threadId:string;opId:string;desktop:boolean;model:string;base?:Json;at:number}>();
  /** Per running turn, Codex's cumulative token total before the turn and after its latest model call. */
  private turnTokens=new Map<string,{threadId:string;base:Json;total:Json}>();
  private locks=new Map<string,Promise<unknown>>();
  private live=new RuntimeLive();
  private liveDiff=new LiveDiff();
  private watchers=new Map<string,number>();
  private reloading=false;
  get updating(){return this.reloading;}
  private reloadLease?:NodeJS.Timeout;
  private queueTimer:NodeJS.Timeout;
  private draining=false;
  private closed=false;
  private restartTimer?:NodeJS.Timeout;
  private restartDelay=1000;
  constructor(public ledger:Ledger,public runtime=new AppServer(),public desktop=new Desktop(),private projects=nativeProjects,private history=readPaginatedHistory,private listSessions=indexedSessions,private externalTurnRunning=indexedTurnHasWriter) {
    super();
    runtime.on('event',(e:Json)=>{
      const {threadId,turnId}=e.params||{};
      const itemsOnly=this.live.apply(e),hadRetry=this.retries.has(threadId);
      if(e.method==='error'&&e.params.willRetry===true&&threadId&&turnId&&this.loaded.has(threadId)){
        this.retries.set(threadId,{turnId,text:codexRetryText(e.params.error?.message,e.params.error?.codexErrorInfo)});
      }
      const retry=this.retries.get(threadId);
      if(retry&&(e.method==='thread/closed'||e.method==='turn/started'||e.method==='turn/completed'||
        retry.turnId===turnId&&(e.method==='item/started'||e.method==='item/agentMessage/delta'||e.method==='error'&&e.params.willRetry===false)))this.retries.delete(threadId);
      if(e.method==='turn/diff/updated')this.diffs.set(e.params.turnId,e.params.diff);
      if(e.method==='turn/completed')this.starting.delete(e.params.threadId);
      if(e.method==='thread/closed'){this.loaded.delete(e.params.threadId);this.starting.delete(e.params.threadId);}
      if(e.method==='thread/tokenUsage/updated'){
        this.contexts.set(e.params.threadId,contextUsage(e.params.tokenUsage));
        const usage=e.params.tokenUsage;
        if(threadId&&turnId&&usage?.total)this.turnTokens.set(turnId,{threadId,base:this.turnTokens.get(turnId)?.base??codexBase(usage.total,usage.last),total:usage.total});
      }
      if(e.method==='turn/completed'&&typeof e.params.turn?.id==='string')this.finishTurn(e.params.threadId,e.params.turn.id);
      if(e.method==='thread/compacted')this.contexts.delete(e.params.threadId);
      if(e.method==='thread/settings/updated')this.rememberSettings(e.params.threadId,e.params.threadSettings);
      if(e.method==='turn/completed')this.scheduleRelease(e.params.threadId);
      // A watching phone receives item content as live frames; anything else needs a fresh read.
      if(itemsOnly&&this.loaded.has(threadId)&&this.watched(threadId)&&hadRetry===this.retries.has(threadId))this.emit('stream',threadId);
      else this.emit('change',e.params?.threadId||e.params?.thread?.id||null);
    });
    runtime.on('offline',()=>{this.turnTokens.clear();for(const [id,start] of this.turnStarts)if(!start.desktop)this.turnStarts.delete(id);this.loaded.clear();this.starting.clear();this.retries.clear();this.settings.clear();this.contexts.clear();this.live.clear();this.liveDiff.clear();this.generation=randomUUID();this.emit('change',null);this.scheduleRestart();});
    desktop.on('change',(id:string,detail?:Json)=>{
      this.finishDesktopTurns(id);
      if(!this.loaded.has(id)&&this.watched(id)&&this.desktopItemsOnly(id,detail))this.emit('stream',id);
      else this.emit('change',id);
    });
    desktop.on('resync',(id:string)=>{this.emit('change',id);});
    desktop.on('offline',()=>{this.liveDiff.clear();this.generation=randomUUID();this.emit('change',null);});
    this.queueTimer=setInterval(()=>void this.drainQueue(),1000);this.queueTimer.unref();
  }
  /** Starts Codex; on failure keeps retrying in the background so other apps on this connector stay usable. */
  async start(){
    try{await this.runtime.start();this.restartDelay=1000;}
    catch(error){this.scheduleRestart();throw error;}
    finally{await this.desktop.connect().catch(()=>{});}
  }
  private scheduleRestart(){
    if(this.closed||this.reloading||this.restartTimer)return;
    const delay=this.restartDelay;this.restartDelay=Math.min(60_000,delay*2);
    this.restartTimer=setTimeout(()=>{
      this.restartTimer=undefined;
      if(this.closed||this.reloading)return;
      Promise.resolve().then(()=>this.runtime.start()).then(()=>{this.restartDelay=1000;this.emit('change',null);},()=>this.scheduleRestart());
    },delay);
    this.restartTimer.unref?.();
  }
  async handle(req:BridgeRequest):Promise<any> {
    const p=req.payload||{};
    if(req.action==='operation.read')return this.ledger.read(textRequired(p.opId,'操作标识',100));
    if(req.action==='runtime.reload')return this.reloadRuntime(p);
    if(this.reloading)throw new BridgeError('maintenance','连接器正在适配 Codex 更新，请稍后刷新');
    if(req.action==='project.create'){
      if(!guestWorkspace())throw new BridgeError('unsupported','此操作仅在借用电脑时可用');
      return this.ledger.run(textRequired(p.opId,'操作标识',100),{action:req.action,name:p.name},()=>createGuestProject(p.name));
    }
    if(req.action==='voice.transcribe')return transcribeVoice(this.runtime,p);
    if(req.action==='file.uploadStart'||req.action==='file.uploadChunk'){
      const threadId=textRequired(p.threadId,'会话'),id=uploadId(p.id);
      return this.exclusive(`upload:${id}`,async()=>{
        if(req.action==='file.uploadChunk')return appendUpload(this.ledger,threadId,id,p.offset,p.body instanceof UploadBody?p.body:p.data);
        const session=await this.read(threadId,5);
        if(session.source==='history')throw new BridgeError('read_only',session.notice||'请先接入当前会话');
        return startUpload(this.ledger,threadId,session.cwd,p);
      });
    }
    if(['session.create','session.fork','session.resume','session.rename','session.archive','session.unarchive','turn.send','turn.cancelQueued','turn.withdrawQueued','turn.steerQueued','turn.edit','turn.stop','request.respond'].includes(req.action)) {
      const opId=textRequired(p.opId,'操作标识',100),key=p.threadId||'new';
      return this.ledger.run(opId,{action:req.action,...p},()=>this.exclusive(key,async()=>{
        try {
          const result=await this.mutate(req.action,p);
          if(p.threadId&&!['turn.send','turn.edit','turn.steerQueued','request.respond'].includes(req.action))this.scheduleRelease(p.threadId);
          return result;
        }catch(error){if(p.threadId)this.scheduleRelease(p.threadId);throw error;}
      }));
    }
    if(req.action==='info') {
      const requested=p.cwd?textRequired(p.cwd,'目录'):undefined;
      const cwd=guestWorkspace()?requested?await projectDirectory(requested):guestWorkspace():requested;
      const config=await this.runtime.rpc('config/read',{includeLayers:false,cwd});
      const models=await readModels(this.runtime);
      const c=config.config||{};
      let projects;
      if(guestWorkspace()){
        let paths:string[]=[];
        try {paths=indexedProjectPaths();}catch(error){
          if((error as {errcode?:number}).errcode!==14)throw error; // The app-server may still be creating the state DB.
        }
        projects=await workspaceProjects(paths);
      }else projects=await this.projects(c);
      return {projects,roots:projects.map(p=>p.path),desktopOnline:Boolean(this.desktop.clientId),model:c.model||'',provider:c.model_provider||'openai',effort:c.model_reasoning_effort||'',approvalPolicy:c.approval_policy||'',serviceTier:c.service_tier??null,models:models.data||[],runtime:{bin:this.runtime.bin,version:this.runtime.version,bundleHash:this.bundleHash},generation:this.generation};
    }
    if(req.action==='sessions.list') {
      const requested=p.cwd?textRequired(p.cwd,'目录'):undefined;
      const cwd=requested&&guestWorkspace()?await projectDirectory(requested):requested;
      const search=p.search?.trim()?textRequired(p.search,'搜索内容',200):undefined;
      if(p.refresh===true)await this.runtime.rpc('thread/list',{limit:1,useStateDbOnly:false},3000).catch(()=>{});
      // The desktop-owned thread can block app-server thread/list; the state index remains readable.
      const page=this.listSessions({cwd,archived:Boolean(p.archived),search,cursor:p.cursor});
      const threads=guestWorkspace()?await Promise.all(page.data.map(async thread=>{
        const path=await projectDirectory(thread.cwd).catch(()=>undefined);
        return path?{...thread,cwd:path}:null;
      })):page.data;
      return {...page,data:threads.flatMap(thread=>thread?[{...thread,status:this.desktop.states.get(thread.id)?.state.threadRuntimeStatus}]:[])};
    }
    if(req.action==='session.read') {
      const cursor:TurnCursor|undefined=p.cursor==null?undefined:{before:textRequired(p.cursor.before,'历史位置',200)};
      if(cursor&&p.cursor.native!=null)cursor.native=textRequired(p.cursor.native,'历史游标',4000);
      const view=await step('read',()=>this.read(textRequired(p.threadId,'会话'),Math.min(100,Math.max(1,Math.floor(Number(p.limit)||20))),cursor));
      if(!cursor&&p.watch===true){this.watch(view.id);this.liveDiff.prime(view.id,this.generation,view.turns.at(-1));}
      markCodexSenders(view.turns,this.ledger.senders('codex',view.id));
      return stepSync('snapshot',()=>sessionSnapshot(view,cursor?undefined:p.known));
    }
    if(req.action==='session.status') {
      const session=await this.read(textRequired(p.threadId,'会话'),5);
      const status:ThreadStatus={threadId:session.id,limits:[]};
      if(session.provider&&session.provider!=='openai')return {...status,limitsNotice:'当前提供商未提供额度信息'};
      try {status.limits=accountLimits(await this.runtime.rpc('account/rateLimits/read',{},8000));}catch{/* Accounts without usage metadata remain unavailable, never zero. */}
      if(!status.limits.length)status.limitsNotice='运行端暂未提供额度信息';
      return status;
    }
    if(req.action==='file.read'||req.action==='file.download') {
      const session=await this.read(textRequired(p.threadId,'会话'),5),path=textRequired(p.path,'文件路径');
      // `stream`: set only by the connector itself for a download through the relay's data channel (src/connector/blob.ts).
      return req.action==='file.read'?readProjectFile(session.cwd,path):p.stream===true?openProjectDownload(session.cwd,path,textRequired(p.revision,'文件版本',64),p.range) as unknown as Json
        :downloadProjectFile(session.cwd,path,textRequired(p.revision,'文件版本',64),p.offset);
    }
    throw new BridgeError('unsupported','此操作暂不支持');
  }
  async read(id:string,limit=20,cursor?:TurnCursor):Promise<SessionView> {
    let view:SessionView,nativeCursor:string|undefined;
    if(this.loaded.has(id)) {
      const requestedAt=this.live.mark();
      const {raw,hasMore,notice,resumeUnavailable,nextCursor}=await this.runtimeThread(id,limit,cursor);
      nativeCursor=nextCursor;
      if(!cursor){
        // thread/read only has completed items; overlay the running turn from notifications.
        this.live.rememberBase(id,raw.turns?.at(-1),requestedAt);
        raw.turns=this.live.merge(id,raw.turns||[]);
      }
      for(const [key,value] of Object.entries(this.settings.get(id)||{}))if(raw[key]===undefined||raw[key]===null||raw[key]==='')raw[key]=value;
      view=normalizeSession(raw,'connector',[...this.runtime.requests.values()].filter(r=>r.params?.threadId===id),limit);
      view.contextUsage=this.contexts.get(id)||null;
      view.hasMore=hasMore||view.hasMore;
      if(notice)view.notice=notice;
      if(resumeUnavailable)view.resumeUnavailable=true;
      for(const turn of view.turns)turn.diff=this.diffs.get(turn.id)||turn.diff;
    } else {
      try {
        const raw=await this.desktop.follow(id);
        view=await this.desktopView(raw,id,limit,cursor);
        nativeCursor=view.nextCursor?.native;
      } catch(e) {
        if(e instanceof BridgeError&&e.code==='changed')throw e;
        const {raw,hasMore,notice,resumeUnavailable,nextCursor}=await this.runtimeThread(id,limit,cursor);
        nativeCursor=nextCursor;
        const tail=raw.turns?.at(-1);
        // An unloaded App Server may report an unfinished turn owned by another process as interrupted.
        const externalRunning=!cursor&&raw.status?.type==='notLoaded'&&typeof tail?.id==='string'&&
          (tail.status==='inProgress'||tail.status==='interrupted'&&tail.completedAt==null&&!tail.error)&&
          await this.externalTurnRunning(id,tail.id);
        if(externalRunning)raw.turns=[...raw.turns.slice(0,-1),{...tail,status:'inProgress'}];
        const managed=Boolean(guestWorkspace()||this.ledger.owns(id))&&!resumeUnavailable&&!externalRunning;
        for(const [key,value] of Object.entries(this.settings.get(id)||{}))if(raw[key]===undefined||raw[key]===null||raw[key]==='')raw[key]=value;
        view=normalizeSession(raw,managed?'connector':'history',[],limit);
        if(managed){view.contextUsage=this.contexts.get(id)||null;for(const turn of view.turns)turn.diff=this.diffs.get(turn.id)||turn.diff;}
        view.hasMore=hasMore||view.hasMore;
        view.resumeUnavailable=resumeUnavailable;
        if(externalRunning)view.notice='此任务正在另一个 Codex 进程中运行，这里只能查看进度。';
        else if(!managed)view.notice=guestWorkspace()?'这条会话的历史格式暂不支持继续。':notice||(resumeUnavailable?'当前运行端未接入。此分页会话可查看历史，暂不能在这里继续；请在 Codex 桌面操作。':'当前运行端未接入，只能查看历史。确认电脑上的任务已结束后，可在这里继续。');
      }
    }
    if(guestWorkspace())view.cwd=await projectDirectory(view.cwd);
    view.nextCursor=view.hasMore&&view.turns.length?{before:view.turns[0].id,...nativeCursor?{native:nativeCursor}:{}}:null;
    const starting=this.starting.get(id);
    if(starting&&!cursor&&view.source!=='history') {
      if(view.activeTurnId||view.turns.some(turn=>turn.id===starting&&turnFinished(turn.status)))this.starting.delete(id);
      else {view.activeTurnId=starting;view.running=true;view.canControl=false;view.notice='Codex 正在开始这一轮，稍后即可补充或停止';}
    }
    const retry=this.retries.get(id);
    if(!cursor&&view.source==='connector'&&retry&&retry.turnId===view.activeTurnId)view.retry=retry.text;
    view.queuedMessages=this.ledger.queued(id).map(message=>({id:message.id,text:message.payload.text,imageCount:message.payload.images?.length||0,fileNames:message.payload.files?.map((file:Json)=>file.name)||[],imageBytes:(message.payload.images||[]).reduce((sum:number,url:string)=>sum+imageBytes(url),0),state:message.state,error:message.error}));
    view.generation=this.generation;return view;
  }
  private async desktopView(raw:Json,id:string,limit:number,cursor?:TurnCursor):Promise<SessionView> {
    const live=desktopTurns(raw),history=raw.turnHistory?.history;
    const partial=history?.isComplete===false||history?.islands?.length>1||raw.turnsPagination?.hasLoadedOldest===false||live.some(turn=>turn.itemsPagination?.hasLoadedOldest===false);
    if(!partial)return normalizeSession(raw,'desktop',raw.requests||[],limit,cursor?.before);
    // A desktop snapshot may contain only a window of history or partial turn items.
    // Read a bounded persisted page and overlay the live state without expanding the desktop's history.
    let page=this.history(id,limit,undefined,cursor?.before),nativeCursor:string|undefined;
    if(!page){const result=await this.runtimeThread(id,limit,cursor);page={turns:result.raw.turns||[],hasMore:result.hasMore};nativeCursor=result.nextCursor;}
    const liveById=new Map(live.map(turn=>[turn.turnId||turn.id,turn]));
    const turns=page.turns.map(turn=>{
      const latest=liveById.get(turn.id||turn.turnId);if(!latest)return turn;
      const items=latest.itemsPagination?.hasLoadedOldest===false
        ?[...new Map([...turn.items||[],...latest.items||[]].map(item=>[item.id,item])).values()]:latest.items;
      return {...turn,...latest,items};
    });
    if(!cursor){
      const tail=history?.islands?.at(-1);
      const recent:Json[]=tail?tail.entries.map((entry:Json)=>history.entitiesByKey[entry.value||entry.key]).filter(Boolean):live;
      const last=recent.findIndex(turn=>(turn.turnId||turn.id)===(turns.at(-1)?.turnId||turns.at(-1)?.id));
      const ids=new Set(turns.map(turn=>turn.turnId||turn.id));
      turns.push(...recent.slice(last+1).filter(turn=>!ids.has(turn.turnId||turn.id)));
    }
    const view=normalizeSession({...raw,turnHistory:undefined,turns},'desktop',raw.requests||[],limit);
    view.hasMore=page.hasMore||view.hasMore;
    if(nativeCursor&&(page.turns[0]?.id||page.turns[0]?.turnId)===view.turns[0]?.id)view.nextCursor={before:view.turns[0].id,native:nativeCursor};
    return view;
  }
  private async runtimeThread(id:string,limit:number,cursor?:TurnCursor):Promise<{raw:Json;hasMore:boolean;nextCursor?:string;notice?:string;resumeUnavailable?:boolean}> {
    try {
      const r=await this.runtime.rpc('thread/read',{threadId:id,includeTurns:true});
      const page=turnPage(r.thread.turns||[],limit,cursor?.before);
      return {raw:{...r.thread,turns:page.turns},hasMore:page.hasMore};
    } catch(e) {
      const paginated=e instanceof BridgeError&&/paginated[_\s]threads?.*(?:do not support|is not supported)/i.test(e.message);
      const unsupportedTurns=e instanceof BridgeError&&/list_turns is not supported yet/i.test(e.message);
      if(!paginated&&!unsupportedTurns) {
        if(e instanceof BridgeError&&/not materialized yet/.test(e.message)) {
          const r=await this.runtime.rpc('thread/read',{threadId:id,includeTurns:false});
          return {raw:r.thread,hasMore:false};
        }
        throw e;
      }
      const thread=await this.runtime.rpc('thread/read',{threadId:id,includeTurns:false});
      const indexed=()=>{
        const page=this.history(id,limit,undefined,cursor?.before);
        const resumeUnavailable=!this.loaded.has(id);
        if(page)return {raw:{...thread.thread,turns:page.turns},hasMore:page.hasMore,resumeUnavailable};
        if(cursor)throw new BridgeError('changed','历史位置已变化，请重新打开会话');
        return {raw:{...thread.thread,turns:[]},hasMore:false,resumeUnavailable,
          notice:resumeUnavailable?'此会话的分页历史暂时无法读取，请在 Codex 桌面查看完整记录。':undefined};
      };
      if(unsupportedTurns)return indexed();
      if(cursor&&!cursor.native){const page=this.history(id,limit,undefined,cursor.before);if(page)return {raw:{...thread.thread,turns:page.turns},hasMore:page.hasMore};}
      try {
        let native=cursor?.native,seeking=Boolean(cursor&&!native);const seen=new Set<string>();
        for(;;){
          if(native){if(seen.has(native))throw new BridgeError('changed','历史游标未前进，请重新打开会话');seen.add(native);}
          const page=await this.runtime.rpc('thread/turns/list',{threadId:id,limit,sortDirection:'desc',itemsView:'full',...native?{cursor:native}:{}});
          let turns:Json[]=[...page.data||page.turns||page.items||[]].reverse();
          if(seeking){
            const index=turns.findIndex(turn=>turn.id===cursor!.before);
            if(index>=0){turns=turns.slice(0,index);seeking=false;}
            else if(!page.nextCursor)throw new BridgeError('changed','历史位置已变化，请重新打开会话');
          }
          if(page.nextCursor&&seen.has(page.nextCursor))throw new BridgeError('changed','历史游标未前进，请重新打开会话');
          if(!seeking&&(turns.length||!page.nextCursor))return {raw:{...thread.thread,turns},hasMore:Boolean(page.nextCursor),nextCursor:page.nextCursor||undefined};
          native=page.nextCursor;
        }
      } catch(error) {
        if(!(error instanceof BridgeError)||!/list_turns is not supported yet/i.test(error.message))throw error;
        return indexed();
      }
    }
  }
  /** Called for each phone read with watch=true; frames stop when reads stop. */
  watch(id:string){this.watchers.set(id,Date.now()+WATCH_MS);}
  watched(id:unknown):id is string {
    if(!this.livePush||typeof id!=='string')return false;
    const until=this.watchers.get(id);if(!until)return false;
    if(until>=Date.now())return true;
    this.watchers.delete(id);this.liveDiff.forget(id);return false;
  }
  /** Counts of changes per thread (structure, stream) and for all threads, which the subscription source's version follows. */
  private syncCounts=new Map<string,{structure:number;stream:number}>();
  private syncAll=0;
  /** The last full read for each followed thread, reused until something besides the running turn's items changed. */
  private syncReads=new Map<string,{key:string;value:Promise<SessionView>}>();
  private syncCount(id:string){let count=this.syncCounts.get(id);if(!count){count={structure:0,stream:0};this.syncCounts.set(id,count);}return count;}
  /** Which full read a thread's state comes from; changes every ten seconds as well, as the page's own refresh did. */
  private syncKey(id:string){return `${this.generation}:${this.syncAll}:${this.syncCount(id).structure}:${Math.floor(Date.now()/SYNC_REREAD_MS)}`;}
  private syncRead(id:string){
    const key=this.syncKey(id),cached=this.syncReads.get(id);
    if(cached?.key===key)return cached.value;
    const value=this.read(id,SYNC_WINDOW).then(view=>{markCodexSenders(view.turns,this.ledger.senders('codex',view.id));return view;});
    this.syncReads.delete(id);this.syncReads.set(id,{key,value});
    if(this.syncReads.size>16)this.syncReads.delete(this.syncReads.keys().next().value!);
    value.catch(()=>{if(this.syncReads.get(id)?.value===value)this.syncReads.delete(id);});
    return value;
  }
  /**
   * What the subscription hub (src/connector/thread-hub.ts) follows: the newest turns of a thread. A running turn's new
   * words only change that turn, built from the runtime's notifications or the desktop's patches as live frames were,
   * without reading the thread again.
   */
  readonly syncSource:ThreadSource={
    window:SYNC_WINDOW,
    version:async id=>{this.watch(id);const count=this.syncCount(id);return `${this.syncKey(id)}:${count.stream}`;},
    state:async id=>{
      this.watch(id);
      const view=await this.syncRead(id),{turns,hasMore:_more,nextCursor:_cursor,...head}=view;
      let entries:TurnView[]=turns;
      const live=this.liveTurn(id),at=live?turns.findIndex(turn=>turn.id===live.id):-1;
      if(live&&at>=0){markCodexSenders([live],this.ledger.senders('codex',id));entries=[...turns.slice(0,at),live,...turns.slice(at+1)];}
      return {head,entries,hasMore:Boolean(view.hasMore)};
    },
    page:async(id,before,limit)=>{
      const view=await this.read(id,limit,{before});
      markCodexSenders(view.turns,this.ledger.senders('codex',view.id));
      return {entries:view.turns,hasMore:Boolean(view.hasMore)};
    },
    watch:poke=>{
      this.on('change',(id:string|null)=>{if(id){this.syncCount(id).structure++;poke(id);}else this.syncAll++;});
      this.on('stream',(id:string)=>{if(id){this.syncCount(id).stream++;poke(id);}});
    },
  };
  /** The frame that brings watching phones to the current running turn, if it changed. */
  liveFrame(id:string):LiveFrame|null {
    if(!this.watched(id))return null;
    // A frame may carry the whole turn, which replaces the phone's copy; it keeps the senders a read showed.
    const turn=this.liveTurn(id);
    if(turn)markCodexSenders([turn],this.ledger.senders('codex',id));
    return this.liveDiff.frame(id,this.generation,turn);
  }
  /** The running turn as the phone shows it, built without reading the thread; null when that is not possible. */
  liveTurn(id:string):TurnView|null {
    if(this.loaded.has(id)) {
      const raw=this.live.turn(id);if(!raw)return null;
      const turn=normalizeTurn(raw),diff=this.diffs.get(turn.id)||turn.diff;
      return diff===turn.diff?turn:{...turn,diff};
    }
    const state=this.desktop.states.get(id)?.state;if(!state)return null;
    const turn=desktopTurns(state).at(-1);
    if(!turn||turn.status!=='inProgress'||turn.itemsPagination?.hasLoadedOldest===false)return null;
    return normalizeTurn(turn);
  }
  /** True when desktop patches only changed the running turn's items, so a frame covers them. */
  private desktopItemsOnly(id:string,detail?:Json):boolean {
    const patches=detail?.patches,previous=detail?.previous,next=this.desktop.states.get(id)?.state;
    if(!Array.isArray(patches)||!patches.length||!previous||!next)return false;
    const before=liveLocation(previous),after=liveLocation(next);
    if(!before||!after||before.key!==after.key)return false;
    let other=false;
    for(const patch of patches) {
      if(startsWith(patch?.path,before.path))continue;
      if(startsWith(patch?.path,before.container))return false;
      other=true;
    }
    const a=before.turn,b=after.turn;
    if(b.status!=='inProgress'||a.status!==b.status||(a.turnId||a.id)!==(b.turnId||b.id)||JSON.stringify(a.error??null)!==JSON.stringify(b.error??null))return false;
    return !other||desktopMeta(previous)===desktopMeta(next);
  }
  private editedInput(raw:Json,turnId:string,itemId:string,text:string):{input:Json[];numTurns:number} {
    const turns:Json[]=raw.turnHistory?.kind==='canonical'?desktopTurns(raw):raw.turns||[];
    const index=turns.findIndex(value=>(value.turnId||value.id)===turnId),turn=turns[index];
    if(!turn||!turnFinished(turn.status))throw new BridgeError('changed','原消息已变化，请刷新后重试');
    if(turns.slice(index).some(value=>value.status==='inProgress'))throw new BridgeError('active','请等当前任务结束后再编辑');
    if(turn.items?.filter((value:Json)=>value.type==='userMessage').length>1)throw new BridgeError('unsupported','这轮有多条用户消息，暂不能编辑');
    const item=turn.items?.find((value:Json)=>value.id===itemId&&value.type==='userMessage');
    const original=item?.content||(itemId===`${turnId}:input`?turn.params?.input:null);
    if(!Array.isArray(original)||!original.length)throw new BridgeError('changed','原消息已变化，请刷新后重试');
    const allowed=new Set(['text','image','localImage','audio','localAudio','skill','mention']);
    if(original.some((value:Json)=>!allowed.has(value.type)))throw new BridgeError('unsupported','这条消息包含暂不能重发的附件');
    let replaced=false;
    const input=original.flatMap((value:Json)=>{
      if(value.type!=='text')return [value];
      if(replaced)return [];
      replaced=true;return [{type:'text',text,text_elements:[]}];
    });
    if(!replaced)input.unshift({type:'text',text,text_elements:[]});
    return {input,numTurns:turns.length-index};
  }
  private async mutate(action:string,p:Json):Promise<Json> {
    if(action==='session.create') {
      const cwd=await projectDirectory(textRequired(p.cwd,'项目目录'));
      const options:Json={cwd,historyMode:'legacy'};if(p.model)options.model=textRequired(p.model,'模型',200);
      const policy=approvalPolicy(p.approvalPolicy);if(policy)options.approvalPolicy=policy;
      const r=await this.runtime.rpc('thread/start',options);
      this.loaded.add(r.thread.id);this.ledger.claim(r.thread.id);this.settings.set(r.thread.id,{model:r.model,modelProvider:r.modelProvider,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy||policy,sessionId:r.thread.sessionId||r.thread.id});
      this.emit('change',r.thread.id);return {threadId:r.thread.id,model:r.model,provider:r.modelProvider};
    }
    const id=textRequired(p.threadId,'会话');
    if(action==='turn.cancelQueued'||action==='turn.withdrawQueued') {
      const queuedId=textRequired(p.queuedId,'排队消息',100);
      const message=this.ledger.cancelQueued(id,queuedId);
      this.emit('change',id);return {threadId:id,queuedId,kind:action==='turn.withdrawQueued'?'queue_withdrawn':'queue_cancelled',...(action==='turn.withdrawQueued'?{message}:{})};
    }
    if(action==='turn.steerQueued') {
      const queuedId=textRequired(p.queuedId,'排队消息',100);
      const message=this.ledger.queued(id).find(message=>message.id===queuedId);
      if(!message)throw new BridgeError('changed','消息已经发送或移出队列，请刷新');
      if(message.state!=='queued')throw new BridgeError('active','这条消息暂不能追加，请核实发送状态');
      const session=await this.read(id);
      if(!session.activeTurnId||session.activeTurnId!==p.expectedTurnId||session.source!==message.payload.source||p.source!==session.source||p.generation!==this.generation)
        throw new BridgeError('changed','当前任务已变化，消息仍在队列中');
      if(!session.canControl)throw new BridgeError('read_only',session.notice||'当前任务暂不能追加');
      this.ledger.sending(queuedId);
      try {
        const result=await this.mutate('turn.send',{threadId:id,source:p.source,generation:p.generation,expectedTurnId:p.expectedTurnId,opId:p.opId,text:message.payload.text,images:message.payload.images,files:message.payload.files,mode:'steer'});
        this.ledger.finishQueued(queuedId,result);
        return {...result,queuedId};
      } catch(error) {
        const failure=error instanceof BridgeError?error:new BridgeError('unexpected','追加结果待核实，不会自动重发',true);
        this.ledger.finishQueued(queuedId,{},failure);throw failure;
      } finally {this.emit('change',id);}
    }
    if(action==='session.fork') {
      const lastTurnId=textRequired(p.lastTurnId,'分叉位置',200);
      const source=await this.read(id,100);
      let page=source,selected=page.turns.find(turn=>turn.id===lastTurnId);
      while(!selected&&page.nextCursor){page=await this.read(id,100,page.nextCursor);selected=page.turns.find(turn=>turn.id===lastTurnId);}
      if(!selected||!selected.canFork)throw new BridgeError('changed','分叉位置已变化，请刷新后重试');
      const r=await this.runtime.rpc('thread/fork',{threadId:id,lastTurnId});
      if(!r?.thread?.id)throw new BridgeError('unexpected','分叉结果未返回新会话，请刷新列表核实',true);
      const forkId=r.thread.id;
      this.loaded.add(forkId);this.ledger.claim(forkId);
      this.settings.set(forkId,{model:r.model,modelProvider:r.modelProvider,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy,sessionId:r.thread.sessionId||forkId});
      const title=`${source.title.slice(0,180)}（分叉）`;
      try {await this.runtime.rpc('thread/name/set',{threadId:forkId,name:title});}
      catch {this.emit('change',forkId);throw new BridgeError('partial',`分叉已创建，但标题保存未获确认。新会话：${forkId}`,true);}
      finally {await this.exclusive(forkId,()=>this.releaseIdle(forkId)).catch(()=>{});}
      this.emit('change',forkId);return {threadId:forkId,title,cwd:r.thread.cwd||source.cwd};
    }
    if(action==='session.rename') {
      if(guestWorkspace())await this.checkThreadDirectory(id);
      const name=textRequired(p.name,'会话名称',200);
      await this.runtime.rpc('thread/name/set',{threadId:id,name});
      this.emit('change',id);return {threadId:id,name};
    }
    if(action==='session.unarchive') {
      if(guestWorkspace())await this.checkThreadDirectory(id);
      await this.runtime.rpc('thread/unarchive',{threadId:id});
      this.emit('change',id);return {threadId:id,archived:false};
    }
    const session=await this.read(id);
    if(action==='session.archive') {
      if(session.running)throw new BridgeError('active','请等当前任务结束后再归档');
      if(this.ledger.queued(id).length)throw new BridgeError('active','请先处理排队消息再归档');
      await this.runtime.rpc('thread/archive',{threadId:id});
      this.loaded.delete(id);this.settings.delete(id);this.contexts.delete(id);
      this.emit('change',id);return {threadId:id,archived:true};
    }
    if(action==='session.resume') {
      if(session.source!=='history')throw new BridgeError('already_connected','会话已经接入，请刷新后直接发送');
      if(session.resumeUnavailable)throw new BridgeError('unsupported','此分页会话暂不能在连接器中继续，请在 Codex 桌面操作');
      if(!p.confirmIdle||session.running)throw new BridgeError('active','请先在电脑结束原任务，再继续会话');
      const r=await this.runtime.rpc('thread/resume',{threadId:id});
      this.loaded.add(id);this.ledger.claim(id);this.settings.set(id,{model:r.model,modelProvider:r.modelProvider,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy,sessionId:r.thread?.sessionId||id});this.emit('change',id);return {threadId:id,model:r.model,provider:r.modelProvider};
    }
    if(p.generation!==this.generation||p.source!==session.source)throw new BridgeError('changed','连接状态已改变，请刷新任务后重试');
    if(action==='turn.send'&&p.mode==='queue') {
      if(session.source==='history')throw new BridgeError('read_only',session.notice||'当前会话暂不能操作');
      await this.turnInput(p,p.model||session.model);
      const settings=await this.turnSettings(p,session.model);
      this.ledger.enqueue(p.opId,id,{threadId:id,source:session.source,text:p.text||'',images:p.images||[],files:(p.files||[]).map(fileAttachment),...settings});
      this.emit('change',id);return {threadId:id,kind:'queued'};
    }
    if(!session.canControl)throw new BridgeError('read_only',session.notice||'当前会话暂不能操作');
    if(session.source==='connector'&&!this.loaded.has(id)&&(action==='turn.send'||action==='turn.edit')) {
      // Resume by ID: app-server's native ownership lock rejects another application's active thread.
      const r=await this.runtime.rpc('thread/resume',{threadId:id});
      this.loaded.add(id);this.rememberSettings(id,{model:r.model,modelProvider:r.modelProvider,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy});
      const connected=await this.read(id);
      if(connected.running||connected.activeTurnId!==session.activeTurnId)throw new BridgeError('changed','任务已发生变化，输入已保留，请刷新后发送');
    }
    const context={conversationId:id,hostId:this.desktop.states.get(id)?.hostId||'local'};
    if(session.source==='desktop')await this.desktop.request('thread-owner-discovery',context,1500);
    if(action==='turn.edit') {
      if(session.running||p.expectedTurnId!==session.activeTurnId)throw new BridgeError('active','请等当前任务结束后再编辑');
      const turnId=textRequired(p.turnId,'轮次',200),itemId=textRequired(p.itemId,'消息',200),text=textRequired(p.text,'输入');
      const settings=await this.turnSettings(p,session.model);
      if(session.source==='desktop') {
        const latest=session.turns.filter(turn=>turn.items.some(item=>item.role==='user')).at(-1);
        if(latest?.id!==turnId)throw new BridgeError('unsupported','桌面会话目前只能编辑最近一条用户消息');
        if(Object.keys(settings).length) {
          const updated=await this.desktop.request('thread-follower-update-thread-settings',{...context,threadSettings:settings});
          if(updated?.applied!==true)throw new BridgeError('changed','模型设置未获确认，请刷新后重试');
        }
        await this.desktop.request('thread-follower-edit-last-user-turn',{...context,turnId,message:text});
      } else {
        let page=await this.runtimeThread(id,100);const raw=page.raw;
        while(!raw.turns.some((turn:Json)=>turn.id===turnId)&&page.hasMore){
          const before=raw.turns[0]?.id;if(!before)break;
          page=await this.runtimeThread(id,100,{before,...page.nextCursor?{native:page.nextCursor}:{}});
          if(!page.raw.turns?.length)break;
          raw.turns=[...page.raw.turns,...raw.turns];
        }
        const {input,numTurns}=this.editedInput(raw,turnId,itemId,text);
        await revertThread(this.runtime,raw,turnId,numTurns);
        this.loaded.add(id);
        this.contexts.delete(id);
        for(const turn of raw.turns.slice(-numTurns))this.diffs.delete(turn.id||turn.turnId);
        try {const result=await this.runtime.rpc('turn/start',{threadId:id,input,...settings});if(!result?.turn?.id)throw new Error('turn/start did not return a turn');this.starting.set(id,result.turn.id);this.startTurn(id,result.turn.id,p.opId,false,settings.model||session.model);this.ledger.recordSender({service:'codex',threadId:id,opId:p.opId,kind:'start',turnId:result.turn.id});this.rememberSettings(id,settings);}
        catch {this.emit('change',id);throw new BridgeError('partial','后续聊天已回退，但重发未获确认。请刷新会话核实后再发送。',true);}
      }
      this.emit('change',id);return {threadId:id,kind:'edited'};
    }
    if(action==='turn.send'||action==='turn.stop') {
      if(action==='turn.send'&&p.mode!==undefined&&p.mode!=='steer')throw new BridgeError('invalid','发送方式无效');
      if(p.expectedTurnId!==session.activeTurnId)throw new BridgeError('changed','任务已发生变化，输入已保留，请刷新后发送');
      if(action==='turn.stop') {
        if(!session.activeTurnId)throw new BridgeError('finished','任务已经结束');
        if(session.source==='desktop')await this.desktop.request('thread-follower-interrupt-turn',{...context,mode:'user-stop',expectedTurnId:session.activeTurnId});
        else await this.runtime.rpc('turn/interrupt',{threadId:id,turnId:session.activeTurnId});
        return {threadId:id,turnId:session.activeTurnId,kind:'stop_requested'};
      }
      if(session.activeTurnId&&(p.model||p.effort||p.approvalPolicy||p.serviceTier!==undefined))throw new BridgeError('active','运行中补充沿用当前设置；下一轮可以更换');
      const settings=session.activeTurnId?{}:await this.turnSettings(p,session.model);
      const input=await this.turnInput(p,!session.activeTurnId&&p.model||session.model);
      let result:any;
      if(session.activeTurnId) {
        const params={input,expectedTurnId:session.activeTurnId};
        const text=input.filter(item=>item.type==='text').map(item=>item.text).join('\n');
        const restoreMessage={id:p.opId,text,cwd:session.cwd,createdAt:Date.now(),context:{prompt:text,workspaceRoots:session.cwd?[session.cwd]:[],textElements:[],imageAttachments:[],fileAttachments:[],pastedTextAttachments:[],addedFiles:[],commentAttachments:[],mcpAppModelContextAttachments:[]}};
        result=session.source==='desktop'?await this.desktop.request('thread-follower-steer-turn',{...context,...params,restoreMessage,clientUserMessageId:p.opId,attachments:[]}):await this.runtime.rpc('turn/steer',{threadId:id,...params});
      } else {
        const request:Json={threadId:id,input,...settings};
        if(session.source==='desktop')result=await this.startDesktopTurn(context,{...request,clientUserMessageId:p.opId});
        else result=await this.runtime.rpc('turn/start',request);
        const started=result?.result?.turn?.id||result?.turn?.id;
        if(!started)throw new BridgeError('unexpected','发送结果未返回轮次，请刷新会话核实',true);
        this.starting.set(id,started);
        this.startTurn(id,started,p.opId,session.source==='desktop',settings.model||session.model);
        if(session.source==='connector') {
          this.rememberSettings(id,settings);
          void this.refreshDesktop(id);
        }
      }
      // The message joins the running turn (steer) or starts the new one; either way its sender is remembered by that turn.
      const sentTurn=session.activeTurnId||result?.result?.turn?.id||result?.turn?.id;
      if(sentTurn)this.ledger.recordSender({service:'codex',threadId:id,opId:p.opId,kind:session.activeTurnId?'steer':'start',turnId:sentTurn});
      this.emit('change',id);
      return {threadId:id,turnId:result?.result?.turn?.id||result?.turn?.id||result?.result?.turnId||result?.turnId||session.activeTurnId||null,kind:session.activeTurnId?'steer_accepted':'turn_accepted'};
    }
    if(action==='request.respond') {
      const req=session.requests.find(r=>String(r.id)===String(p.requestId));
      if(!req)throw new BridgeError('expired','该请求已经处理或失效');
      const {method,result,field}=approvalResult(req,p.response||{});
      if(session.source==='desktop')await this.desktop.request(method,{...context,requestId:req.id,[field]:field==='decision'?result.decision:result});
      else await this.runtime.respond(String(req.id),result);
      this.emit('change',id);return {threadId:id,requestId:req.id,kind:'response_submitted'};
    }
    throw new BridgeError('unsupported','此操作暂不支持');
  }
  private async checkThreadDirectory(threadId:string) {
    const result=await this.runtime.rpc('thread/read',{threadId,includeTurns:false});
    await projectDirectory(result.thread.cwd);
  }
  private async startDesktopTurn(context:Json,request:Json):Promise<Json> {
    try {
      return await this.desktop.request('thread-follower-start-turn',{...context,turnStart:{request,context:{inheritThreadSettings:true}}});
    } catch(error) {
      if(!(error instanceof BridgeError)||!error.uncertain)throw error;
      // A timed-out desktop request may still start. Confirm this exact input from
      // the live stream, never from another active turn or an optimistic placeholder.
      const turnId=await new Promise<string|undefined>(resolve=>{
        const finish=(id?:string)=>{clearTimeout(timer);this.desktop.off('change',changed);this.desktop.off('offline',offline);resolve(id);};
        const changed=(id:string)=>{
          if(id!==context.conversationId)return;
          const raw=this.desktop.states.get(id)?.state;
          const turn=raw&&desktopTurns(raw).find(turn=>(turn.turnId||turn.id)&&(
            turn.params?.clientUserMessageId===request.clientUserMessageId||
            turn.items?.some((item:Json)=>item.type==='userMessage'&&item.clientId===request.clientUserMessageId)));
          if(turn)finish(turn.turnId||turn.id);
        };
        const offline=()=>finish();
        const timer=setTimeout(finish,3000);
        this.desktop.on('change',changed);this.desktop.once('offline',offline);
        changed(context.conversationId);
        if(!this.desktop.clientId)finish();
      });
      if(!turnId)throw error;
      return {result:{turn:{id:turnId}}};
    }
  }
  private async exclusive<T>(key:string,fn:()=>Promise<T>):Promise<T> {
    const previous=this.locks.get(key)||Promise.resolve();
    const next=previous.catch(()=>{}).then(fn);this.locks.set(key,next);
    try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}
  }
  private scheduleRelease(id:string) {
    if(!id||!this.loaded.has(id)||this.closed)return;
    void this.exclusive(id,()=>this.releaseIdle(id)).catch(()=>{});
  }
  private async refreshDesktop(id:string) {
    if(this.closed)return;
    try {await this.desktop.refreshThread(id);}
    catch {this.emit('diagnostic','desktop_thread_refresh_failed');}
  }
  private async releaseIdle(id:string) {
    if(this.closed||this.reloading||!this.loaded.has(id)||this.ledger.queued(id).some(message=>message.state==='queued'||message.state==='sending'))return;
    const session=await this.read(id,1);
    // Empty legacy threads have not been persisted yet. Keep their first send possible.
    if(this.closed||this.reloading||session.running||session.requests.length||!session.turns.length)return;
    await this.runtime.unsubscribe(id);
    this.loaded.delete(id);this.starting.delete(id);this.emit('change',id);
    // The final title and legacy history are durable once the native writer closes.
    void this.refreshDesktop(id);
  }
  private async turnSettings(p:Json,currentModel:string):Promise<Json> {
    const settings:Json={};
    if(p.model)settings.model=textRequired(p.model,'模型',200);
    if(p.effort)settings.effort=await reasoningEffort(this.runtime,p.effort,settings.model||currentModel);
    const policy=approvalPolicy(p.approvalPolicy);if(policy)settings.approvalPolicy=policy;
    if(p.serviceTier!==undefined) {
      if(p.serviceTier!==null) {
        const catalog=await readModels(this.runtime),model=catalog.data?.find((m:Json)=>m.model===(settings.model||currentModel));
        if(typeof p.serviceTier!=='string'||!fastTier(model)||p.serviceTier!==fastTier(model))throw new BridgeError('invalid','当前模型不支持所选极速档位');
      }
      settings.serviceTier=p.serviceTier;
    }
    return settings;
  }
  private async turnInput(p:Json,modelId:string):Promise<Json[]> {
    const {images,files}=validateAttachments(p.images===undefined?[]:p.images,p.files===undefined?[]:p.files);
    const text=(images.length||files.length)&&(p.text===undefined||typeof p.text==='string'&&!p.text.trim())?'':textRequired(p.text,'输入');
    // Desktop renders the original input before app-server supplies defaults.
    const input:Json[]=text?[{type:'text',text,text_elements:[]}]:[];
    if(images.length) {
      const models=await readModels(this.runtime),model=models.data?.find((m:Json)=>m.model===modelId);
      if(!model?.inputModalities?.includes('image'))throw new BridgeError('unsupported','当前模型未确认图片能力');
      input.push(...images.map((url:string)=>({type:'image',url})));
    }
    if(files.length){
      const attachments=await attachmentLinks(this.ledger,p.threadId,files);
      if(text)input[0].text+=`\n\n${attachments}`;
      else input.unshift({type:'text',text:attachments,text_elements:[]});
    }
    return input;
  }
  /** Remembers who started a turn; a desktop turn also keeps the token total it starts from. */
  private startTurn(threadId:string,turnId:string,opId:string,desktop:boolean,model:string){
    const now=Date.now();
    for(const [id,start] of this.turnStarts)if(now-start.at>12*3600_000)this.turnStarts.delete(id);
    const base=desktop?this.desktop.states.get(threadId)?.state?.latestTokenUsageInfo?.total:undefined;
    this.turnStarts.set(turnId,{threadId,opId,desktop,model:model||'',base,at:now});
  }
  /** Records a finished Codex turn with the tokens it used, when known. */
  private finishTurn(threadId:string,turnId:string,total?:Json){
    const start=this.turnStarts.get(turnId),tokens=this.turnTokens.get(turnId);
    this.turnStarts.delete(turnId);this.turnTokens.delete(turnId);
    if(!start&&!tokens)return;
    const model=start?.model||this.settings.get(threadId)?.model||'';
    const base=tokens?.base??start?.base,end=tokens?.total??total;
    try{this.ledger.recordUsage({id:`codex:${threadId}:${turnId}`,service:'codex',threadId,turnId,opId:start?.opId,models:base&&end?[codexTokens(model,base,end)]:[]});}
    catch(error){console.error('用量记录失败：',(error as Error).message);}
  }
  /** Desktop turns end in the desktop's snapshot, which also carries the thread's token total. */
  private finishDesktopTurns(threadId:string){
    for(const [turnId,start] of this.turnStarts){
      if(!start.desktop||start.threadId!==threadId)continue;
      const state=this.desktop.states.get(threadId)?.state;if(!state)continue;
      const turn=desktopTurns(state).find(item=>(item.turnId||item.id)===turnId);
      if(turn&&turnFinished(turn.status))this.finishTurn(threadId,turnId,state.latestTokenUsageInfo?.total);
    }
  }
  async drainQueue() {
    if(this.draining||this.reloading||this.closed)return;
    this.draining=true;
    try {
      for(const id of new Set(this.ledger.queued().map(message=>message.threadId))) {
        if(this.closed||this.reloading)return;
        await this.exclusive(id,async()=>{
          if(this.closed||this.reloading)return;
          const message=this.ledger.queued(id)[0];
          if(!message||message.state!=='queued')return;
          let session:SessionView;
          try{session=await this.read(id);}catch{return;}
          if(this.closed||session.running||!session.canControl||session.source!==message.payload.source)return;
          this.ledger.sending(message.id);
          try {
            const result=await this.mutate('turn.send',{...message.payload,opId:message.id,generation:this.generation,expectedTurnId:null});
            if(this.closed)return;
            this.ledger.finishQueued(message.id,result);
          } catch(error) {
            if(this.closed)return;
            this.ledger.finishQueued(message.id,{},error instanceof BridgeError?error:new BridgeError('unexpected','排队消息发送结果待核实，不会自动重发',true));
          }
          this.emit('change',id);
        });
      }
    } finally {this.draining=false;}
  }
  private rememberSettings(id:string,settings:Json) {
    this.settings.set(id,{...this.settings.get(id),...settings,...(settings.effort?{reasoningEffort:settings.effort}:{})});
  }
  private async reloadRuntime(p:Json):Promise<Json> {
    if(p.generation!==this.generation)throw new BridgeError('changed','连接器已变化，请重新检查');
    const bin=resolveCodex(),path=(value:string)=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
    if(typeof p.expectedBin!=='string'||path(p.expectedBin)!==path(bin))throw new BridgeError('changed','Codex 安装或执行端配置已变化，请重新检查');
    if(this.reloading||this.locks.size||this.starting.size||this.runtime.requests.size||this.ledger.queued().length||this.ledger.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE state='pending'").get()?.n)
      throw new BridgeError('active','连接器有任务或操作尚未结束，稍后再适配');
    // Set this before the first await, so a new turn cannot race the idle check.
    this.reloading=true;
    const previousBin=this.runtime.bin,savedSettings=new Map(this.settings),ids=[...this.loaded];
    let stopped=false,prepared=false;
    const restore=async()=>{
      for(const id of ids){
        const r=await this.runtime.rpc('thread/resume',{threadId:id});
        this.loaded.add(id);this.settings.set(id,{...savedSettings.get(id),model:r.model,modelProvider:r.modelProvider,serviceTier:r.serviceTier,approvalPolicy:r.approvalPolicy});
      }
    };
    try {
      for(const id of ids){
        const view=await this.read(id,5);
        if(view.running||view.activeTurnId||view.requests.length)throw new BridgeError('active','连接器任务仍在运行，稍后再适配');
        if(!view.turns.length)throw new BridgeError('active','连接器有尚未保存首轮的空会话，完成首轮后再适配');
      }
      if(p.prepareOnly===true){
        prepared=true;
        this.reloadLease=setTimeout(()=>{this.reloading=false;this.reloadLease=undefined;if(!this.runtime.child)this.scheduleRestart();this.emit('change',null);},60000);
        this.reloadLease.unref();
        return {prepared:true,generation:this.generation,threadIds:ids,runtime:{bin:this.runtime.bin,version:this.runtime.version,bundleHash:this.bundleHash},leaseMs:60000};
      }
      await this.runtime.stop();stopped=true;
      this.runtime.bin=bin;await this.runtime.start();await restore();
      this.emit('change',null);
      return {runtime:{bin:this.runtime.bin,version:this.runtime.version,bundleHash:this.bundleHash},generation:this.generation,restored:ids.length};
    }catch(error){
      if(stopped){
        try{await this.runtime.stop();this.runtime.bin=previousBin;await this.runtime.start();await restore();}
        catch{throw new BridgeError('runtime_error','Codex 切换与原运行端恢复失败，需要核实连接器状态',true);}
        throw new BridgeError('runtime_error','Codex 切换失败，已恢复原运行端；请修复适配后重试');
      }
      throw error;
    }finally{if(!prepared){this.reloading=false;if(!this.runtime.child)this.scheduleRestart();}}
  }
  close(){this.closed=true;clearTimeout(this.restartTimer);clearInterval(this.queueTimer);clearTimeout(this.reloadLease);this.desktop.close();this.runtime.close();this.ledger.close();}
}
