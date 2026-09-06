import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { AppServer } from './app-server.js';
import { Desktop } from './desktop.js';
import { Ledger } from './ledger.js';
import { normalizeSession } from './normalize.js';
import { approvalResult } from './approvals.js';
import { projectPath, readProjectFile } from './project.js';
import { BridgeError, textRequired, type Json, type BridgeRequest, type SessionView } from '../shared/types.js';

export class Control extends EventEmitter {
  generation=randomUUID();
  private loaded=new Set<string>();
  private settings=new Map<string,Json>();
  private diffs=new Map<string,string>();
  private starting=new Map<string,string>();
  private locks=new Map<string,Promise<unknown>>();
  constructor(public roots:string[],public ledger:Ledger,public runtime=new AppServer(),public desktop=new Desktop()) {
    super();
    runtime.on('event',(e:Json)=>{
      if(e.method==='turn/diff/updated')this.diffs.set(e.params.turnId,e.params.diff);
      if(e.method==='turn/completed')this.starting.delete(e.params.threadId);
      this.emit('change',e.params?.threadId||e.params?.thread?.id||null);
    });
    runtime.on('offline',()=>{this.loaded.clear();this.starting.clear();this.settings.clear();this.generation=randomUUID();this.emit('change',null);});
    desktop.on('change',(id:string)=>this.emit('change',id));
    desktop.on('resync',(id:string)=>{this.emit('change',id);});
    desktop.on('offline',()=>{this.generation=randomUUID();this.emit('change',null);});
  }
  async start(){await this.runtime.start();await this.desktop.connect().catch(()=>{});}
  async handle(req:BridgeRequest):Promise<any> {
    const p=req.payload||{};
    if(req.action==='operation.read')return this.ledger.read(textRequired(p.opId,'操作标识',100));
    if(['session.create','session.resume','turn.send','turn.stop','request.respond'].includes(req.action)) {
      const opId=textRequired(p.opId,'操作标识',100),key=p.threadId||'new';
      return this.ledger.run(opId,{action:req.action,...p},()=>this.exclusive(key,()=>this.mutate(req.action,p)));
    }
    if(req.action==='info') {
      const cwd=p.cwd?await projectPath(this.roots,textRequired(p.cwd,'目录')):this.roots[0];
      const config=await this.runtime.rpc('config/read',{includeLayers:false,cwd});
      const models=await this.runtime.rpc('model/list',{}).catch(()=>({data:[]}));
      const c=config.config||{};
      return {roots:this.roots,desktopOnline:Boolean(this.desktop.clientId),model:c.model||'',provider:c.model_provider||'openai',effort:c.model_reasoning_effort||'',models:models.data||[],generation:this.generation};
    }
    if(req.action==='sessions.list') {
      const cwd=p.cwd?await projectPath(this.roots,textRequired(p.cwd,'目录')):undefined;
      const r=await this.runtime.rpc('thread/list',{limit:30,cursor:p.cursor||null,modelProviders:[],cwd,searchTerm:p.search?.trim()?textRequired(p.search,'搜索内容',200):undefined,sortKey:'updated_at',sourceKinds:['cli','vscode','appServer','exec','unknown']});
      const data=[];
      for(const t of r.data||[]) {
        try {await projectPath(this.roots,t.cwd);data.push({id:t.id,title:t.name||t.preview?.slice(0,100)||'新会话',cwd:t.cwd,model:t.model||'',provider:t.modelProvider,status:t.status,updatedAt:t.updatedAt});}catch{}
      }
      return {data,nextCursor:r.nextCursor};
    }
    if(req.action==='session.read')return this.read(textRequired(p.threadId,'会话'),Math.min(100,Math.max(5,Number(p.limit)||20)));
    if(req.action==='file.read') {const session=await this.read(textRequired(p.threadId,'会话'),5);return readProjectFile(this.roots,session.cwd,textRequired(p.path,'文件路径'));}
    throw new BridgeError('unsupported','此操作暂不支持');
  }
  async read(id:string,limit=20):Promise<SessionView> {
    let view:SessionView;
    if(this.loaded.has(id)) {
      const r=await this.runtime.rpc('thread/read',{threadId:id,includeTurns:true}).catch(e=>{
        if(e instanceof BridgeError&&/not materialized yet/.test(e.message))return this.runtime.rpc('thread/read',{threadId:id,includeTurns:false});
        throw e;
      });
      const raw={...r.thread,...this.settings.get(id)};
      view=normalizeSession(raw,'connector',[...this.runtime.requests.values()].filter(r=>r.params?.threadId===id),limit);
      let starting=this.starting.get(id);
      if(starting&&raw.turns?.some((t:Json)=>t.id===starting&&t.status!=='inProgress')){this.starting.delete(id);starting=undefined;}
      if(starting&&!view.activeTurnId){view.activeTurnId=starting;view.canControl=false;view.notice='Codex 正在开始这一轮，稍后即可补充或停止';}
      else if(starting&&view.activeTurnId===starting)this.starting.delete(id);
      for(const turn of view.turns)turn.diff=this.diffs.get(turn.id)||turn.diff;
    } else {
      try {
        const raw=await this.desktop.follow(id);
        view=normalizeSession(raw,'desktop',raw.requests||[],limit);
      } catch(e) {
        const r=await this.runtime.rpc('thread/read',{threadId:id,includeTurns:true});
        view=normalizeSession(r.thread,'history',[],limit);
        view.notice='当前运行端未接入，只能查看历史。确认电脑上的任务已结束后，可在这里继续。';
      }
    }
    await projectPath(this.roots,view.cwd);
    view.generation=this.generation;return view;
  }
  private async mutate(action:string,p:Json):Promise<Json> {
    if(action==='session.create') {
      const cwd=await projectPath(this.roots,textRequired(p.cwd,'项目目录'));
      if(!(await stat(cwd)).isDirectory())throw new BridgeError('invalid','项目目录无效');
      const options:Json={cwd};if(p.model)options.model=textRequired(p.model,'模型',200);
      const r=await this.runtime.rpc('thread/start',options);
      this.loaded.add(r.thread.id);this.ledger.claim(r.thread.id);this.settings.set(r.thread.id,{model:r.model,modelProvider:r.modelProvider});
      this.emit('change',r.thread.id);return {threadId:r.thread.id,model:r.model,provider:r.modelProvider};
    }
    const id=textRequired(p.threadId,'会话');
    const session=await this.read(id);
    if(action==='session.resume') {
      if(session.source!=='history')throw new BridgeError('already_connected','会话已经接入，请刷新后直接发送');
      if(!p.confirmIdle||session.activeTurnId)throw new BridgeError('active','请先在电脑结束原任务，再继续会话');
      const r=await this.runtime.rpc('thread/resume',{threadId:id});
      this.loaded.add(id);this.ledger.claim(id);this.settings.set(id,{model:r.model,modelProvider:r.modelProvider});this.emit('change',id);return {threadId:id,model:r.model,provider:r.modelProvider};
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
      const text=textRequired(p.text,'输入');
      const input:Json[]=[{type:'text',text}];
      if(p.images?.length) {
        if(!Array.isArray(p.images)||p.images.length>2||p.images.some((x:any)=>typeof x!=='string'||x.length>3_000_000||!/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(x)))throw new BridgeError('invalid','最多两张 PNG、JPEG 或 WebP，每张不超过 2 MiB');
        // Unknown/custom providers remain text-first; only expose images when native metadata confirms them.
        const models=await this.runtime.rpc('model/list',{});
        const model=models.data?.find((m:Json)=>m.model===session.model);
        if(!model?.inputModalities?.includes('image'))throw new BridgeError('unsupported','当前模型未确认图片能力');
        input.push(...p.images.map((url:string)=>({type:'image',url})));
      }
      let result:any;
      if(session.activeTurnId) {
        if(p.model||p.effort)throw new BridgeError('active','运行中补充沿用当前模型；下一轮可以更换');
        const params={input,expectedTurnId:session.activeTurnId};
        result=session.source==='desktop'?await this.desktop.request('thread-follower-steer-turn',{...context,...params}):await this.runtime.rpc('turn/steer',{threadId:id,...params});
      } else {
        const request:Json={threadId:id,input};
        if(p.model)request.model=textRequired(p.model,'模型',200);
        if(p.effort){if(!['none','minimal','low','medium','high','xhigh','max'].includes(p.effort))throw new BridgeError('invalid','推理档位无效');request.effort=p.effort;}
        if(session.source==='desktop')result=await this.desktop.request('thread-follower-start-turn',{...context,turnStart:{request:{...request,clientUserMessageId:p.opId},context:{inheritThreadSettings:true}}});
        else {result=await this.runtime.rpc('turn/start',request);if(result?.turn?.id)this.starting.set(id,result.turn.id);}
        if(p.model&&session.source==='connector')this.settings.set(id,{...this.settings.get(id),model:p.model});
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
