import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AppServer } from './app-server.js';
import { Desktop } from './desktop.js';
import { Ledger } from './ledger.js';
import { normalizeSession } from './normalize.js';
import { approvalResult } from './approvals.js';
import { projectDirectory, readProjectFile, downloadProjectFile } from './project.js';
import { nativeProjects, indexedSessions } from './projects.js';
import { readPaginatedHistory } from './paginated-history.js';
import { BridgeError, textRequired, type Json, type BridgeRequest, type SessionView, type ContextUsage, type ThreadStatus } from '../shared/types.js';
import {imageDataUrl,MAX_IMAGES} from '../shared/images.js';
import {contextUsage,accountLimits} from './usage.js';

function approvalPolicy(value:unknown):'on-request'|'never'|undefined {
  if(value===undefined||value===null||value==='')return undefined;
  if(value==='on-request'||value==='never')return value;
  throw new BridgeError('invalid','审批策略无效');
}

export class Control extends EventEmitter {
  generation=randomUUID();
  private loaded=new Set<string>();
  private settings=new Map<string,Json>();
  private diffs=new Map<string,string>();
  private starting=new Map<string,string>();
  private contexts=new Map<string,ContextUsage|null>();
  private locks=new Map<string,Promise<unknown>>();
  constructor(public ledger:Ledger,public runtime=new AppServer(),public desktop=new Desktop(),private projects=nativeProjects,private history=readPaginatedHistory,private listSessions=indexedSessions) {
    super();
    runtime.on('event',(e:Json)=>{
      if(e.method==='turn/diff/updated')this.diffs.set(e.params.turnId,e.params.diff);
      if(e.method==='turn/completed')this.starting.delete(e.params.threadId);
      if(e.method==='thread/tokenUsage/updated')this.contexts.set(e.params.threadId,contextUsage(e.params.tokenUsage));
      if(e.method==='thread/compacted')this.contexts.delete(e.params.threadId);
      this.emit('change',e.params?.threadId||e.params?.thread?.id||null);
    });
    runtime.on('offline',()=>{this.loaded.clear();this.starting.clear();this.settings.clear();this.contexts.clear();this.generation=randomUUID();this.emit('change',null);});
    desktop.on('change',(id:string)=>this.emit('change',id));
    desktop.on('resync',(id:string)=>{this.emit('change',id);});
    desktop.on('offline',()=>{this.generation=randomUUID();this.emit('change',null);});
  }
  async start(){await this.runtime.start();await this.desktop.connect().catch(()=>{});}
  async handle(req:BridgeRequest):Promise<any> {
    const p=req.payload||{};
    if(req.action==='operation.read')return this.ledger.read(textRequired(p.opId,'操作标识',100));
    if(['session.create','session.resume','session.rename','session.archive','session.unarchive','turn.send','turn.stop','request.respond'].includes(req.action)) {
      const opId=textRequired(p.opId,'操作标识',100),key=p.threadId||'new';
      return this.ledger.run(opId,{action:req.action,...p},()=>this.exclusive(key,()=>this.mutate(req.action,p)));
    }
    if(req.action==='info') {
      const cwd=p.cwd?textRequired(p.cwd,'目录'):undefined;
      const config=await this.runtime.rpc('config/read',{includeLayers:false,cwd});
      const models=await this.runtime.rpc('model/list',{}).catch(()=>({data:[]}));
      const c=config.config||{};
      const projects=await this.projects(c);
      return {projects,roots:projects.map(p=>p.path),desktopOnline:Boolean(this.desktop.clientId),model:c.model||'',provider:c.model_provider||'openai',effort:c.model_reasoning_effort||'',approvalPolicy:c.approval_policy||'',models:models.data||[],generation:this.generation};
    }
    if(req.action==='sessions.list') {
      const cwd=p.cwd?textRequired(p.cwd,'目录'):undefined;
      const search=p.search?.trim()?textRequired(p.search,'搜索内容',200):undefined;
      if(p.refresh===true)await this.runtime.rpc('thread/list',{limit:1,useStateDbOnly:false},3000).catch(()=>{});
      // The desktop-owned thread can block app-server thread/list; the state index remains readable.
      const page=this.listSessions({cwd,archived:Boolean(p.archived),search,cursor:p.cursor});
      return {...page,data:page.data.map(thread=>({...thread,status:this.desktop.states.get(thread.id)?.state.threadRuntimeStatus}))};
    }
    if(req.action==='session.read')return this.read(textRequired(p.threadId,'会话'),Math.min(100,Math.max(5,Number(p.limit)||20)));
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
      return req.action==='file.read'?readProjectFile(session.cwd,path):downloadProjectFile(session.cwd,path,textRequired(p.revision,'文件版本',64),p.offset);
    }
    throw new BridgeError('unsupported','此操作暂不支持');
  }
  async read(id:string,limit=20):Promise<SessionView> {
    let view:SessionView;
    if(this.loaded.has(id)) {
      const {raw,hasMore,notice,resumeUnavailable}=await this.runtimeThread(id,limit);
      Object.assign(raw,this.settings.get(id));
      view=normalizeSession(raw,'connector',[...this.runtime.requests.values()].filter(r=>r.params?.threadId===id),limit);
      view.contextUsage=this.contexts.get(id)||null;
      view.hasMore=hasMore||view.hasMore;
      if(notice)view.notice=notice;
      if(resumeUnavailable)view.resumeUnavailable=true;
      let starting=this.starting.get(id);
      if(starting&&raw.turns?.some((t:Json)=>t.id===starting&&t.status!=='inProgress')){this.starting.delete(id);starting=undefined;}
      if(starting&&!view.activeTurnId){view.activeTurnId=starting;view.running=true;view.canControl=false;view.notice='Codex 正在开始这一轮，稍后即可补充或停止';}
      else if(starting&&view.activeTurnId===starting)this.starting.delete(id);
      for(const turn of view.turns)turn.diff=this.diffs.get(turn.id)||turn.diff;
    } else {
      try {
        const raw=await this.desktop.follow(id);
        view=normalizeSession(raw,'desktop',raw.requests||[],limit);
      } catch(e) {
        const {raw,hasMore,notice,resumeUnavailable}=await this.runtimeThread(id,limit);
        view=normalizeSession(raw,'history',[],limit);
        view.hasMore=hasMore||view.hasMore;
        view.resumeUnavailable=resumeUnavailable;
        view.notice=notice||(resumeUnavailable?'当前运行端未接入。此分页会话可查看历史，暂不能在这里继续；请在 Codex 桌面操作。':'当前运行端未接入，只能查看历史。确认电脑上的任务已结束后，可在这里继续。');
      }
    }
    view.generation=this.generation;return view;
  }
  private async runtimeThread(id:string,limit:number):Promise<{raw:Json;hasMore:boolean;notice?:string;resumeUnavailable?:boolean}> {
    try {
      const r=await this.runtime.rpc('thread/read',{threadId:id,includeTurns:true});
      return {raw:r.thread,hasMore:false,resumeUnavailable:r.thread.historyMode==='paginated'&&!this.loaded.has(id)};
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
        const page=this.history(id,limit);
        const resumeUnavailable=!this.loaded.has(id);
        if(page)return {raw:{...thread.thread,turns:page.turns},hasMore:page.hasMore,resumeUnavailable};
        return {raw:{...thread.thread,turns:[]},hasMore:false,resumeUnavailable,
          notice:resumeUnavailable?'此会话的分页历史暂时无法读取，请在 Codex 桌面查看完整记录。':undefined};
      };
      if(unsupportedTurns)return indexed();
      try {
        const page=await this.runtime.rpc('thread/turns/list',{threadId:id,limit,sortDirection:'desc',itemsView:'full'});
        const turns=page.data||page.turns||page.items||[];
        return {raw:{...thread.thread,turns:[...turns].reverse()},hasMore:Boolean(page.nextCursor)};
      } catch(error) {
        if(!(error instanceof BridgeError)||!/list_turns is not supported yet/i.test(error.message))throw error;
        return indexed();
      }
    }
  }
  private async mutate(action:string,p:Json):Promise<Json> {
    if(action==='session.create') {
      const cwd=await projectDirectory(textRequired(p.cwd,'项目目录'));
      const options:Json={cwd,historyMode:'legacy'};if(p.model)options.model=textRequired(p.model,'模型',200);
      const policy=approvalPolicy(p.approvalPolicy);if(policy)options.approvalPolicy=policy;
      const r=await this.runtime.rpc('thread/start',options);
      this.loaded.add(r.thread.id);this.ledger.claim(r.thread.id);this.settings.set(r.thread.id,{model:r.model,modelProvider:r.modelProvider,approvalPolicy:r.approvalPolicy||policy,sessionId:r.thread.sessionId||r.thread.id});
      this.emit('change',r.thread.id);return {threadId:r.thread.id,model:r.model,provider:r.modelProvider};
    }
    const id=textRequired(p.threadId,'会话');
    if(action==='session.rename') {
      const name=textRequired(p.name,'会话名称',200);
      await this.runtime.rpc('thread/name/set',{threadId:id,name});
      this.emit('change',id);return {threadId:id,name};
    }
    if(action==='session.unarchive') {
      await this.runtime.rpc('thread/unarchive',{threadId:id});
      this.emit('change',id);return {threadId:id,archived:false};
    }
    const session=await this.read(id);
    if(action==='session.archive') {
      if(session.running)throw new BridgeError('active','请等当前任务结束后再归档');
      await this.runtime.rpc('thread/archive',{threadId:id});
      this.loaded.delete(id);this.settings.delete(id);this.contexts.delete(id);
      this.emit('change',id);return {threadId:id,archived:true};
    }
    if(action==='session.resume') {
      if(session.source!=='history')throw new BridgeError('already_connected','会话已经接入，请刷新后直接发送');
      if(session.resumeUnavailable)throw new BridgeError('unsupported','此分页会话暂不能在连接器中继续，请在 Codex 桌面操作');
      if(!p.confirmIdle||session.activeTurnId)throw new BridgeError('active','请先在电脑结束原任务，再继续会话');
      const r=await this.runtime.rpc('thread/resume',{threadId:id});
      this.loaded.add(id);this.ledger.claim(id);this.settings.set(id,{model:r.model,modelProvider:r.modelProvider,approvalPolicy:r.approvalPolicy,sessionId:r.thread?.sessionId||id});this.emit('change',id);return {threadId:id,model:r.model,provider:r.modelProvider};
    }
    if(!session.canControl)throw new BridgeError('read_only',session.notice||'当前会话暂不能操作');
    if(p.generation!==this.generation||p.source!==session.source)throw new BridgeError('changed','连接状态已改变，请刷新任务后重试');
    const context={conversationId:id,hostId:this.desktop.states.get(id)?.hostId||'local'};
    if(session.source==='desktop')await this.desktop.request('thread-owner-discovery',context,1500);
    if(action==='turn.send'||action==='turn.stop') {
      if(p.expectedTurnId!==session.activeTurnId)throw new BridgeError('changed','任务已发生变化，输入已保留，请刷新后发送');
      if(action==='turn.stop') {
        if(!session.activeTurnId)throw new BridgeError('finished','任务已经结束');
        if(session.source==='desktop')await this.desktop.request('thread-follower-interrupt-turn',{...context,mode:'user-stop',expectedTurnId:session.activeTurnId});
        else await this.runtime.rpc('turn/interrupt',{threadId:id,turnId:session.activeTurnId});
        return {threadId:id,turnId:session.activeTurnId,kind:'stop_requested'};
      }
      if(p.images!==undefined&&(!Array.isArray(p.images)||p.images.length>MAX_IMAGES))throw new BridgeError('invalid','最多两张 PNG、JPEG 或 WebP，每张不超过 2 MiB');
      const images=(p.images||[]).map(imageDataUrl);
      const text=images.length&&(p.text===undefined||typeof p.text==='string'&&!p.text.trim())?'':textRequired(p.text,'输入');
      // Desktop renders this input before app-server can supply protocol defaults.
      const input:Json[]=text?[{type:'text',text,text_elements:[]}]:[];
      if(images.length) {
        // Unknown/custom providers remain text-first; only expose images when native metadata confirms them.
        const models=await this.runtime.rpc('model/list',{});
        const model=models.data?.find((m:Json)=>m.model===(!session.activeTurnId&&p.model||session.model));
        if(!model?.inputModalities?.includes('image'))throw new BridgeError('unsupported','当前模型未确认图片能力');
        input.push(...images.map((url:string)=>({type:'image',url})));
      }
      let result:any;
      if(session.activeTurnId) {
        if(p.model||p.effort||p.approvalPolicy)throw new BridgeError('active','运行中补充沿用当前设置；下一轮可以更换');
        const params={input,expectedTurnId:session.activeTurnId};
        result=session.source==='desktop'?await this.desktop.request('thread-follower-steer-turn',{...context,...params}):await this.runtime.rpc('turn/steer',{threadId:id,...params});
      } else {
        const request:Json={threadId:id,input};
        if(p.model)request.model=textRequired(p.model,'模型',200);
        if(p.effort){if(!['none','minimal','low','medium','high','xhigh','max'].includes(p.effort))throw new BridgeError('invalid','推理档位无效');request.effort=p.effort;}
        const policy=approvalPolicy(p.approvalPolicy);if(policy)request.approvalPolicy=policy;
        if(session.source==='desktop')result=await this.desktop.request('thread-follower-start-turn',{...context,turnStart:{request:{...request,clientUserMessageId:p.opId},context:{inheritThreadSettings:true}}});
        else {result=await this.runtime.rpc('turn/start',request);if(result?.turn?.id)this.starting.set(id,result.turn.id);}
        if(session.source==='connector'&&(p.model||policy))this.settings.set(id,{...this.settings.get(id),...(p.model?{model:p.model}:{}),...(policy?{approvalPolicy:policy}:{})});
      }
      this.emit('change',id);
      return {threadId:id,turnId:result?.result?.turn?.id||result?.turn?.id||session.activeTurnId||null,kind:session.activeTurnId?'steer_accepted':'turn_accepted'};
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
  private async exclusive<T>(key:string,fn:()=>Promise<T>):Promise<T> {
    const previous=this.locks.get(key)||Promise.resolve();
    const next=previous.catch(()=>{}).then(fn);this.locks.set(key,next);
    try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}
  }
  close(){this.desktop.close();this.runtime.close();this.ledger.close();}
}
