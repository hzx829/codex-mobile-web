import {useEffect,useRef,useState} from 'react';
import {ConversationStatus,ConversationTurn,PendingMessage,connectionLost} from './conversation';
import {ThreadMenu} from './thread-menu';
import {ContextIndicator,ThreadStatusPanel,contextSummary} from './thread-status';
import {optimisticDelivered,optimisticMessage,OPTIMISTIC_ACCEPTED_MS,type OptimisticMessage} from './optimistic';
import {useVoiceInput} from './use-voice-input';
import type {MenuPoint} from './popover';
import type {ThreadActions} from './antigravity-sidebar';
import {voiceProviderLabel,type VoiceProvider} from '../src/shared/voice';
import {ThreadHeader,useComposerHeight,workspaceName} from './chat-layout';
import {IconButton} from './icon-button';
import {QueuedMessages} from './queued-messages';
import {Icon} from './icons';
import {useStableEvent} from './use-event';
import {operationId} from './client';
import {GuestProjectForm} from './claude-projects';
import {useComposerAttachments} from './composer-attachments';
import {AddOptions,Composer,useAttachmentPickers} from './composer';
import {ModelMenu} from './model-picker';
import {listedModel,modelDisplayName,reasoningLabel,resolveModelSelection,type ModelSelection} from '../src/shared/models';
import {PermissionMenu,type PermissionOption} from './permission-picker';
import {SheetPanel} from './sheet';
import {uploadAttachments,type UploadProgress} from './file-upload';
import {MAX_IMAGES,MAX_TOTAL_IMAGE_BYTES,imageBytes} from '../src/shared/images';
import type {Json,QueuedMessage,RequestAction,SessionView,TurnView} from '../src/shared/types';
import {SenderScope} from './senders';
import {paneActions,pageToRestore,savedPage,type PaneAction} from './artifact-pane';

type Props={
  machine:string;machineName:string;connected:boolean;conversationId:string;inert:boolean;previewError:string;guest?:boolean;
  /** Where a new session starts: a project folder or '' to choose; null while a saved session is open. */
  newCwd:string|null;created:(id:string)=>void;
  /** Opens a session copied from this one. */
  forked:(id:string)=>void;
  call:(action:RequestAction,payload?:Json)=>Promise<any>;go:(id:string)=>void;
  openFile:(path:string)=>void;openPreview:(url:string)=>void;showPage:(page:PaneAction)=>void;showFiles:()=>void;showImage:(url:string,title:string)=>void;
  copyText:(text:string)=>Promise<void>;clearPreviewError:()=>void;
  /** Codex-style extras: a turn's file changes, voice input and the session menu (rename, copy, archive). */
  showDiff:(turn:TurnView)=>void;voiceMode:VoiceProvider;actions?:(thread:Json)=>ThreadActions;
  /** Opens the voice input settings, shared with the other apps. */
  chooseVoice:()=>void;
};
type Request={id:string;kind:'permission'|'question'|'plan';tool:string;title:string;detail:string;canRemember:boolean;rememberScope?:'session'|'project'|'user';questions?:{question:string;header:string;multiSelect:boolean;options:{label:string;description:string}[]}[]};
const FIRST_MESSAGE='第一条消息不能改写。可以在会话菜单里“复制会话”，或新建会话';
const userIds=(view:Json|null):string[]=>view?.turns?view.turns.flatMap((turn:TurnView)=>turn.items.filter(item=>item.role==='user').map(item=>item.id)):[];
function headerPoint(element:HTMLElement):MenuPoint{const rect=element.getBoundingClientRect();return {x:rect.right,y:rect.bottom+8,align:'end'};}
type Place={id:string;path:string};
const OTHER='__other';
const MODES:PermissionOption[]=[
  {id:'default',label:'按需审批',description:'按 Claude Code 的规则，需要时请你审批'},
  {id:'acceptEdits',label:'自动接受编辑',description:'文件修改自动接受，命令仍需审批'},
  {id:'plan',label:'只做计划',description:'只读分析并给出计划，你确认后才执行'},
  {id:'bypassPermissions',label:'跳过权限确认',description:'不再请求任何审批，直接执行（慎用）',elevated:true},
];
/** A session without a mode of its own runs in the connector's default mode (older connectors: Claude Code's default). */
const modeLabel=(mode:string)=>MODES.find(m=>m.id===mode)?.label||mode;
/** Where "remember" saves the rule, as the connector reports it; older connectors do not say. */
const REMEMBER={session:'本会话允许',project:'本项目始终允许',user:'始终允许'} as const;
/** The level Claude Code marks as recommended; shown until one is chosen here. */
const RECOMMENDED_EFFORT='medium';
function load(key:string){try{return localStorage.getItem(key)||'';}catch{return '';}}
/** The last model chosen for new sessions; "default" was a list entry before the list dropped it. */
function storedModel(machine:string){const value=load(`claude:${machine}:model`);return value==='default'?'':value;}
/** The model list last read from this computer, so the composer names the model before the list is read again. */
function storedModels(machine:string):Json[]|null{try{const list=JSON.parse(load(`claude:${machine}:models`)||'null');return Array.isArray(list)?list:null;}catch{return null;}}
function store(key:string,value:string){try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}}

/** Claude Code sessions on the connected computer: live view, composer, approvals and questions. */
export function ClaudeCodePanel(props:Props){
  const {machine,machineName,connected,conversationId,newCwd,inert,previewError,guest,call,go,openFile,openPreview,showFiles,showImage,copyText,clearPreviewError}=props;
  const creating=!conversationId;
  const scope=`claude:${machine}:${conversationId||'new'}`;
  const [view,setView]=useState<Json|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[watchError,setWatchError]=useState('');
  const [draft,setDraft]=useState(()=>load(`${scope}:draft`)),[pending,setPending]=useState(()=>load(`${scope}:pending`));
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null);
  // A saved session keeps its own model and effort until changed here; the last choice only seeds new sessions.
  const [model,setModel]=useState(()=>creating?storedModel(machine):''),[effort,setEffort]=useState(()=>creating?load(`claude:${machine}:effort`):''),[mode,setMode]=useState('');
  const [outgoing,setOutgoing]=useState<OptimisticMessage|null>(null),[menuPoint,setMenuPoint]=useState<MenuPoint|null>(null),[statusPoint,setStatusPoint]=useState<MenuPoint|null>(null);
  const [models,setModels]=useState<Json[]|null>(()=>storedModels(machine)),[modelsError,setModelsError]=useState(''),[adding,setAdding]=useState(false),[cwd,setCwd]=useState(''),[target,setTarget]=useState(newCwd||''),[places,setPlaces]=useState<Place[]>([]),[defaultMode,setDefaultMode]=useState('');
  const request=useRef(call);request.current=call;
  const alive=useRef(true),modelsRead=useRef(false),lock=useRef(false),scroll=useRef<HTMLDivElement>(null),stick=useRef(true),composer=useRef<HTMLTextAreaElement>(null);
  useComposerHeight(composer,draft,true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  function edit(text:string){setDraft(text);store(`${scope}:draft`,text);}
  function remember(op:string){setPending(op);store(`${scope}:pending`,op);}
  function failed(e:any){if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用 Claude Code。':e?.message||'Claude Code 操作失败');}
  const refresh=useStableEvent(async(clearError=true)=>{
    if(!connected||creating)return;
    setBusy(true);
    try{const next=await request.current('claude.read',{conversationId});if(alive.current){setView(next);if(clearError)setError('');setWatchError('');}}
    catch(e){failed(e);}
    finally{if(alive.current)setBusy(false);}
  });
  useEffect(()=>{void refresh();},[connected,conversationId,refresh]);
  useEffect(()=>{
    if(!creating||!connected)return;
    request.current('claude.list',{}).then(page=>{if(!alive.current)return;const list:Place[]=page.projects||[];setPlaces(list);setDefaultMode(page.defaultPermissionMode||'');setTarget(old=>old||list[0]?.id||(guest?'':OTHER));}).catch(failed);
  },[creating,connected,guest]);
  useEffect(()=>{
    if(!connected||!view?.revision)return;
    let active=true,inflight=false,timer:ReturnType<typeof setTimeout>;
    async function watch(){
      if(!active||inflight||document.visibilityState!=='visible')return;
      inflight=true;let retry=0;
      try{
        const next=await request.current('claude.watch',{conversationId,revision:view!.revision});
        if(!active)return;
        setWatchError('');
        if(!next.unchanged){setView(next);return;}
      }catch{if(active)setWatchError('与电脑的会话同步中断，正在重连…');retry=2500;}
      finally{inflight=false;}
      if(active)timer=setTimeout(watch,retry);
    }
    void watch();
    document.addEventListener('visibilitychange',watch);
    return()=>{active=false;clearTimeout(timer);document.removeEventListener('visibilitychange',watch);};
  },[connected,conversationId,view?.revision]);
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[view,outgoing]);
  // claude.ai pages follow Claude's own app: the conversation's page comes back with it, and a publish or an open call brings a page up.
  const pagesSeen=useRef<Map<string,string>|null>(null),showPage=useStableEvent(props.showPage);
  useEffect(()=>{
    if(!view?.turns||!conversationId)return;
    if(!pagesSeen.current){
      paneActions(view.turns,pagesSeen.current=new Map(),true);
      const page=pageToRestore(view.turns,savedPage(machine,conversationId));
      if(page)showPage(page);
    }else for(const page of paneActions(view.turns,pagesSeen.current))showPage(page);
  },[view,conversationId,machine,showPage]);
  // A sent message shows at once, until the conversation has it (or a while after the computer accepted it).
  useEffect(()=>{if(outgoing&&optimisticDelivered(outgoing,{turns:view?.turns||[]} as unknown as SessionView))setOutgoing(null);},[view,outgoing]);
  useEffect(()=>{if(!outgoing?.acceptedAt)return;const timer=setTimeout(()=>setOutgoing(null),OPTIMISTIC_ACCEPTED_MS);return()=>clearTimeout(timer);},[outgoing?.acceptedAt]);
  const voice=useVoiceInput(props.voiceMode,scope,connected,{
    keyboard:()=>{composer.current?.focus();setNotice('请使用系统键盘上的麦克风听写。');},
    request:(action,payload)=>request.current(action,payload),
    draft:()=>draft,setDraft:edit,
    error:failed,
  });
  const voiceBusy=voice.state!=='idle';
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice]);

  /** `prepare` runs once the panel is locked, before the operation is recorded: uploads go there. */
  async function mutate(action:'claude.create'|'claude.send'|'claude.stop'|'claude.respond'|'claude.fork'|'claude.edit'|'claude.steerQueued'|'claude.withdrawQueued'|'claude.cancelQueued',payload:Json,onAccepted?:(result:Json)=>void,prepare?:()=>Promise<Json>){
    if(lock.current||pending||!connected)return false;
    lock.current=true;setBusy(true);setError('');
    if(prepare)try{payload={...payload,...await prepare()};}
    catch(e){failed(e);lock.current=false;if(alive.current){setBusy(false);setUploadProgress(null);}return false;}
    finally{if(alive.current)setUploadProgress(null);}
    const opId=operationId();remember(opId);
    try{
      const result=await request.current(action,{...payload,opId});
      if(!alive.current)return false;
      if(result.state==='accepted'){remember('');onAccepted?.(result);return true;}
      if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新会话查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);void refresh(false);}
    return false;
  }
  async function check(){
    if(lock.current||!pending||!connected)return;lock.current=true;setBusy(true);
    try{
      const result=await request.current('claude.operation',{opId:pending});
      if(!alive.current)return;
      if(result.state==='accepted'){remember('');setError('');if(result.conversationId&&creating){edit('');props.created(result.conversationId);}else if(result.conversationId)props.forked(result.conversationId);else if(result.submitted||result.kind==='queued')cleared();}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError('结果尚未确认。请刷新会话并在电脑核实；系统不会自动重发。');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(false);
  }
  useEffect(()=>{if(connected&&pending)void check();},[connected]);

  const running=Boolean(view?.running),external=Boolean(view?.external&&!view?.controlled);
  // A project from the list, or an unlisted folder passed in.
  const chosen=places.find(place=>place.id===target)||(target&&target!==OTHER?{id:target,path:target}:undefined);
  const startPath=target===OTHER?cwd.trim():chosen?.path||'';
  // Older connectors start a session with skipping allowed only when it is chosen then; newer ones say so with canBypass.
  const bypassLater=Boolean(view?.canBypass),oneShotBypass=!bypassLater;
  const selectedMode=mode==='bypassPermissions'&&view?.controlled&&!bypassLater?'':mode;
  const effectiveMode=view?.permissionMode||view?.defaultPermissionMode||defaultMode||'default';
  const queued:QueuedMessage[]=view?.queuedMessages||[];
  // As in Codex: behind a running turn or waiting messages, a plain send waits on the computer until the turn ends.
  const queueNext=!creating&&(running||queued.length>0);
  function cleared(){edit('');setImages([]);setFiles([]);}
  /** Uploads the documents into the project on the computer, then the message refers to them. */
  function upload(scope:Json){
    const selected=files;
    return selected.length?async()=>({files:await uploadAttachments(request.current,{prefix:'claude.',scope},selected,value=>{if(alive.current)setUploadProgress(value);})}):undefined;
  }
  /** Behind a running turn the message waits on the computer; from the queue it can join the turn or interrupt it. */
  async function send(){
    if(attachments.loading||voiceBusy)return;
    const text=draft.trim();
    if(!text&&!images.length&&!files.length)return;
    const settings={...(model?{model}:{}),...(sentEffort?{effort:sentEffort}:{}),...(selectedMode?{permissionMode:selectedMode}:{})};
    if(creating){
      if(!startPath){setError('请选择项目');return;}
      stick.current=true;
      await mutate('claude.create',{cwd:startPath,text,images,...settings},result=>{cleared();props.created(result.conversationId);},upload({cwd:startPath}));
      return;
    }
    if(external&&!window.confirm('电脑上的 Claude Code 可能还在运行这条会话。确认那边已经结束，由手机继续？'))return;
    if(!keepCache())return;
    stick.current=true;
    // Queued messages appear in the queue; everything else appears in the conversation now.
    const message=queueNext?null:{...optimisticMessage(scope,{turns:view?.turns||[]} as unknown as SessionView,text,images,files.map(file=>file.name)),baseline:userIds(view)};
    if(message)setOutgoing(message);
    const accepted=await mutate('claude.send',{conversationId,text,images,...settings,...(external?{confirmIdle:true}:{})},
      result=>{cleared();if(selectedMode==='bypassPermissions'&&oneShotBypass)setMode('');
        setNotice(result.kind==='queued'?'已加入队列，当前任务结束后发送':result.kind==='steer_accepted'?'已追加到当前任务':result.kind==='sent_now'?'已立即发送':'');},upload({conversationId}));
    if(message)setOutgoing(old=>old!==message?old:accepted?{...message,acceptedAt:Date.now()}:null);
  }
  function withdrawQueued(queuedId:string){
    void mutate('claude.withdrawQueued',{conversationId,queuedId},result=>{
      const message=result.message||{};
      edit([draft.trim(),message.text].filter(Boolean).join('\n\n'));
      setImages(old=>[...old,...(message.images||[])]);
      if(message.model)setModel(message.model);
      if(message.effort)setEffort(message.effort);
      setMode(message.permissionMode||'');
      setNotice('已撤回到输入框');
      requestAnimationFrame(()=>composer.current?.focus());
    });
  }
  /** Rewrites a sent message: the session continues from the turn before it, as Codex does. */
  async function resend(turnId:string,text:string){
    if(external&&!window.confirm('电脑上的 Claude Code 可能还在运行这条会话。确认那边已经结束，由手机继续？'))return;
    if(!keepCache())return;
    const settings={...(model?{model}:{}),...(sentEffort?{effort:sentEffort}:{}),...(selectedMode&&(selectedMode!=='bypassPermissions'||bypassLater)?{permissionMode:selectedMode}:{})};
    stick.current=true;
    await mutate('claude.edit',{conversationId,turnId,text,...settings,...(external?{confirmIdle:true}:{})});
  }
  /** Read once per page; the composer needs the names before the picker opens. */
  async function openModels(){
    if(modelsRead.current||!connected)return;
    modelsRead.current=true;setModelsError('');
    try{
      const result=await request.current('claude.models',{cwd:view?.cwd||startPath||undefined}),list=result.models||[];
      store(`claude:${machine}:models`,JSON.stringify(list));
      if(alive.current)setModels(list);
    }catch(e:any){modelsRead.current=false;if(alive.current)setModelsError(e?.message||'模型列表读取失败');}
  }
  // A new session reads it at once; an open one waits for its project, which can change the list.
  const modelsCwd=creating?'':view?.cwd;
  useEffect(()=>{if(creating||modelsCwd)void openModels();},[connected,modelsCwd]);
  // A model without effort keeps the last level for the next model that has it.
  function chooseModel(value:ModelSelection){setModel(value.model);setEffort(value.effort);store(`claude:${machine}:model`,value.model);if(value.effort)store(`claude:${machine}:effort`,value.effort);}

  const copy=useStableEvent((text:string)=>void copyText(text).catch(()=>setError('复制失败，请长按选择文字')));
  // A fork is a new Claude Code session holding the transcript up to the end of this turn.
  const editTurn=useStableEvent((turnId:string,_item:string,text:string)=>resend(turnId,text));
  const diff=useStableEvent((turn:TurnView)=>props.showDiff(turn));
  const fork=useStableEvent((turn:TurnView)=>{
    if(!turn.canFork||!turn.anchor){setNotice(turn.status==='inProgress'?'请等这一轮结束后再分叉':'这一轮暂不能分叉，请刷新后重试');return;}
    void mutate('claude.fork',{conversationId,upToMessageId:turn.anchor},result=>props.forked(result.conversationId));
  });
  const followup=useStableEvent((text:string)=>{edit(draft.trim()?`${draft.trimEnd()}\n\n${text}`:text);composer.current?.focus();});
  const turns:TurnView[]=view?.turns||[];
  const requests:Request[]=view?.requests||[];
  const status=!connected?connectionLost:watchError||(pending&&busy?'正在等待电脑确认…':'');
  const canWrite=connected&&!busy&&!pending&&(creating?(!guest||Boolean(startPath)):Boolean(view));
  // Photos are compressed into the message; other files are uploaded to the project when it is sent.
  const attachments=useComposerAttachments({disabled:!canWrite,notify:setError,added:()=>setAdding(false)});
  const {images,files,setImages,setFiles}=attachments,canSend=canWrite&&!attachments.loading&&!voiceBusy;
  const pick=useAttachmentPickers(chosen=>void attachments.add(chosen));
  const drafted=Boolean(draft.trim()||images.length||files.length);
  const attachmentCount=attachments.count;
  const title=creating?'新的 Claude Code 会话':view?.title||'正在打开…';
  const project=creating?(startPath?workspaceName(startPath):'选择项目'):view?.cwd?workspaceName(view.cwd):'Claude Code';
  // Codex-shaped entries for the shared picker. Older connectors list no effort levels: then only the model is chosen.
  // Claude Code lists its default as a model of its own; the recommended tag already says it, so the list leaves it out.
  const defaultEntry=(models||[]).find(item=>item.id==='default');
  const pickerModels:Json[]=(models||[]).filter(item=>item!==defaultEntry).map(item=>({model:item.id,displayName:item.label,description:item.description,resolvedModel:item.resolvedModel,
    supportedReasoningEfforts:(item.efforts||[]).map((level:string)=>({reasoningEffort:level})),
    ...(item.efforts?.includes(RECOMMENDED_EFFORT)?{defaultReasoningEffort:RECOMMENDED_EFFORT}:{})}));
  const tuning=!models||pickerModels.some(item=>item.supportedReasoningEfforts.length);
  // What the session runs on now: its own model matched to the list, or the model Claude Code's default resolves to for a new one.
  const listed=creating?listedModel(pickerModels,defaultEntry?.resolvedModel)||pickerModels[0]:listedModel(pickerModels,view?.model);
  // As in Claude Code, effort is never "default": the session's own level, else the last one chosen here, else the recommended one.
  const currentModel={model:listed?.model||view?.model||'',effort:view?.effort||load(`claude:${machine}:effort`)||RECOMMENDED_EFFORT};
  const selection=resolveModelSelection(pickerModels,{model,effort},currentModel);
  // The level shown is the level sent; none for a model that takes no effort.
  const sentEffort=models&&!selection.efforts.length?'':selection.effort;
  const currentLabel=modelDisplayName(listed,view?.model)||'默认模型';
  const modelLabel=modelDisplayName(selection.model,selection.id)||'默认模型',effortLabel=reasoningLabel(sentEffort);
  // Prompt caches belong to one model, and an effort change drops the cached conversation too, so the next message
  // reads the whole conversation again at full price. Only a change from what the session is known to run on is asked about.
  const changedModel=Boolean(!creating&&model&&listed&&model!==listed.model);
  const changedEffort=Boolean(!creating&&!changedModel&&view?.effort&&sentEffort&&sentEffort!==view.effort);
  function keepCache(){
    if(!turns.length||!changedModel&&!changedEffort)return true;
    const change=changedModel?`模型从 ${currentLabel} 换成 ${modelLabel}`:`思考强度从 ${reasoningLabel(view?.effort||'')} 改成 ${effortLabel}`;
    return window.confirm(`${change}后，这条会话已有的提示缓存将无法复用，下一条消息会按全价重新读取全部上下文，响应也会变慢。继续发送？`);
  }
  const controlledRun=running&&Boolean(view?.controlled);
  return <main className="thread-panel" inert={inert}>
    <ThreadHeader title={title} project={project} machineName={machineName} connected={connected} back={()=>go('')}>
      {!creating&&<>
        <button type="button" className="icon-button" aria-haspopup="dialog" aria-label={`会话状态：${contextSummary(view?.contextUsage)}`} title="上下文" disabled={!view} onClick={e=>setStatusPoint(headerPoint(e.currentTarget))}><ContextIndicator usage={view?.contextUsage}/></button>
        <button type="button" className="icon-button" aria-haspopup="dialog" aria-label="会话操作" title="会话操作" disabled={!view} onClick={e=>setMenuPoint(headerPoint(e.currentTarget))}><Icon name="more"/></button>
      </>}
    </ThreadHeader>
    {view?.notice&&<div className="banner">{view.notice}</div>}
    <div className={`timeline ${creating?'is-empty':''}`} ref={scroll} onScroll={()=>{const el=scroll.current!;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}}><div className="timeline-content">
      {creating?<div className="new-chat-welcome"><h1>交给 Claude Code</h1>
        <label className="claude-project"><Icon name="folder" size={18}/><select aria-label="项目" value={target} onChange={e=>setTarget(e.target.value)}>
          {!target&&<option value="">{guest?'选择或新建项目':'正在读取项目…'}</option>}
          {places.map(place=><option key={place.id} value={place.id}>{workspaceName(place.path)}</option>)}
          {chosen&&!places.includes(chosen as Place)&&<option value={chosen.id}>{workspaceName(chosen.path)}</option>}
          {!guest&&<option value={OTHER}>其他文件夹…</option>}
        </select></label>
        {guest?<details className="other-project" open={!startPath||undefined}><summary>新建项目</summary>
          <GuestProjectForm connected={connected&&!busy} call={call} select={path=>{setPlaces(old=>old.some(item=>item.id===path)?old:[...old,{id:path,path}]);setTarget(path);}}/>
        </details>:target===OTHER&&<label className="claude-project"><input autoFocus aria-label="文件夹路径" placeholder="电脑上的完整路径" value={cwd} onChange={e=>setCwd(e.target.value)}/></label>}
        {startPath&&<p className="muted">{startPath}</p>}</div>:<>
        {view?.truncated&&<p className="muted">仅显示近期记录，完整会话可在电脑查看。</p>}
        {!view&&busy&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
        <SenderScope senders={turns.flatMap(turn=>turn.items.map(item=>item.sender))}>{turns.map(turn=><ConversationTurn key={turn.id} turn={turn} running={running} source="connector"  latestUser={false} disabled={!canWrite}
          openFile={openFile} openPreview={openPreview} onFollowup={followup} onCopy={copy} onEdit={editTurn} onFork={fork} onDiff={diff} onBlocked={setNotice} editBlocked={!view?.truncated&&turn.id===turns[0]?.id?FIRST_MESSAGE:undefined}/>)}</SenderScope>
        {outgoing&&<PendingMessage message={outgoing} openFile={openFile} openPreview={openPreview} onFollowup={followup}/>}
        {view&&!turns.length&&!running&&<p className="muted">这条会话还没有可显示的消息。</p>}
        {view?.error&&<ConversationStatus>{view.error}</ConversationStatus>}
      </>}
      {status&&<ConversationStatus>{status}</ConversationStatus>}
    </div></div>
    <footer className="composer-area">
      <div className="request-stack">{requests.map(item=><ClaudeRequestCard key={`${conversationId}:${item.id}`} request={item} disabled={!connected||busy||Boolean(pending)}
        respond={(decision,answers)=>void mutate('claude.respond',{conversationId,requestId:item.id,decision,...(answers?{answers}:{})})}/>)}</div>
      {(error||previewError)&&<div className="feedback error" role="alert"><span>{error||previewError}</span><IconButton icon="close" label="关闭提示" onClick={()=>{setError('');clearPreviewError();}}/></div>}
      {notice&&<div className="feedback" role="status">{notice}</div>}
      {pending&&!busy&&<div className="pending"><button onClick={()=>void check()} disabled={!connected}>核实操作结果</button><button onClick={()=>{if(window.confirm('请先在会话和电脑上确认操作结果。解除提示不会重发消息。')){remember('');setError('');}}}>我已核实</button></div>}
      {running&&view?.controlled&&<div className="running-status"><i className="dot online"/>Claude Code 正在处理</div>}
      {!creating&&<QueuedMessages messages={queued} disabled={!connected||busy||Boolean(pending)} canSteer={controlledRun} withdrawBlocked={voiceBusy||attachments.loading}
        attachmentsFull={message=>attachmentCount+message.imageCount>MAX_IMAGES||images.reduce((sum,url)=>sum+imageBytes(url),0)+(message.imageBytes||0)>MAX_TOTAL_IMAGE_BYTES}
        onSteer={queuedId=>void mutate('claude.steerQueued',{conversationId,queuedId},()=>setNotice('已追加到当前任务'))}
        onNow={queuedId=>void mutate('claude.steerQueued',{conversationId,queuedId,mode:'now'},result=>setNotice(result.kind==='sent_now'?'已立即发送':'已追加到当前任务'))}
        onWithdraw={withdrawQueued} onCancel={queuedId=>void mutate('claude.cancelQueued',{conversationId,queuedId},()=>setNotice('已删除排队消息'))}/>}
      <Composer attachments={attachments} input={composer} draft={draft} edit={edit} maxLength={100_000} readOnly={Boolean(pending)} submit={()=>void send()}
        placeholder={creating?'想让 Claude Code 做什么？':queueNext?'当前任务完成后发送…':`在 ${machineName} 上继续…`}
        locked={busy} showImage={showImage} uploadProgress={uploadProgress}
        voice={voice} voiceMode={props.voiceMode} voiceDisabled={busy} onVoiceStart={()=>{setError('');setNotice('');}} connected={connected}
        add={()=>setAdding(true)} addDisabled={!canWrite||attachments.loading}
        permission={<PermissionMenu options={MODES.filter(option=>option.id!=='bypassPermissions'||creating||!view?.controlled||bypassLater)} value={selectedMode}
          current={{id:effectiveMode,label:modeLabel(effectiveMode)}} disabled={!connected||busy} onChange={setMode}/>}
        model={<ModelMenu label={modelLabel} details={effortLabel?[effortLabel]:[]} title="选择 Claude Code 模型" tuning={tuning} speed={false} resettable={false} disabled={!connected||busy} opened={()=>void openModels()}
          models={pickerModels} value={{model,effort}} current={currentModel}
          currentLabel={currentLabel} onChange={chooseModel}
          status={modelsError?<p role="alert">{modelsError} <button type="button" onClick={()=>void openModels()}>重试</button></p>:!models?<p role="status">正在读取模型…</p>:!models.length&&<p role="status">没有可选模型</p>}/>}
        running={controlledRun?{stop:()=>void mutate('claude.stop',{conversationId}),disabled:!connected||busy||Boolean(pending),queue:true}:undefined}
        send={{label:queueNext?'完成后发送':'发送消息',sending:Boolean(pending&&busy),disabled:!canSend||!drafted||creating&&!startPath}}/>
      {pick.inputs}
    </footer>
    {adding&&<SheetPanel title="添加与选项" close={()=>setAdding(false)}>
      <AddOptions attachments={attachments} pick={pick} disabled={!canWrite} connected={connected} error={error}
        voiceLabel={voiceProviderLabel(props.voiceMode)} chooseVoice={()=>{setAdding(false);props.chooseVoice();}}
        projectFiles={creating?undefined:()=>{setAdding(false);showFiles();}} refresh={creating?undefined:()=>{setAdding(false);void refresh();}}/>
    </SheetPanel>}
    {menuPoint&&view&&<ThreadMenu thread={{id:conversationId,title:view.title,status:running?{type:'active'}:undefined}} point={menuPoint} preference={{}} sections={[]} archived={false} compact connected={connected}
      close={()=>setMenuPoint(null)} copy={()=>copyText(conversationId)} {...(props.actions?.({id:conversationId,title:view.title})||{})}/>}
    {statusPoint&&view&&<ThreadStatusPanel point={statusPoint} view={{...view,source:'connector'} as unknown as SessionView} threadId={conversationId} cwd={view.cwd} connected={connected} close={()=>setStatusPoint(null)}
      copy={()=>copyText(conversationId)} read={async()=>({threadId:conversationId,limits:[],limitsNotice:'Claude Code 不提供额度信息，可在电脑上运行 /usage 查看'})}/>}
  </main>;
}

function ClaudeRequestCard({request,disabled,respond}:{request:Request;disabled:boolean;respond:(decision:'allow'|'allowSession'|'deny',answers?:Record<string,string>)=>void}){
  const [answers,setAnswers]=useState<Record<string,string[]>>({});
  const [other,setOther]=useState<Record<string,string>>({});
  if(request.kind==='question'){
    const value=(question:string)=>[...(answers[question]||[]),...(other[question]?.trim()?[other[question].trim()]:[])].join(', ');
    const complete=request.questions?.every(q=>value(q.question));
    return <div className="request"><strong>{request.title}</strong>
      {request.questions?.map(q=><div className="claude-question" key={q.question}><p>{q.header&&<small>{q.header} · </small>}{q.question}</p>
        <div className="choices">{q.options.map(option=>{const chosen=answers[q.question]?.includes(option.label);return <button type="button" key={option.label} title={option.description} className={chosen?'chosen':''} disabled={disabled}
          onClick={()=>setAnswers(old=>{const current=old[q.question]||[];return {...old,[q.question]:q.multiSelect?chosen?current.filter(x=>x!==option.label):[...current,option.label]:[option.label]};})}>{option.label}</button>;})}</div>
        <input placeholder="其他回答（可选）" value={other[q.question]||''} disabled={disabled} onChange={e=>setOther(old=>({...old,[q.question]:e.target.value}))}/></div>)}
      <div className="choices"><button className="primary" disabled={disabled||!complete} onClick={()=>respond('allow',Object.fromEntries((request.questions||[]).map(q=>[q.question,value(q.question)])))}>提交回答</button>
        <button disabled={disabled} onClick={()=>respond('deny')}>跳过</button></div></div>;
  }
  return <div className="request"><strong>{request.title}</strong>{request.detail&&<pre>{request.detail}</pre>}
    <div className="choices">
      <button disabled={disabled} onClick={()=>respond('allow')}>{request.kind==='plan'?'开始执行':'允许一次'}</button>
      {request.canRemember&&<button disabled={disabled} onClick={()=>respond('allowSession')}>{request.rememberScope?REMEMBER[request.rememberScope]:'允许并记住'}</button>}
      <button disabled={disabled} onClick={()=>respond('deny')}>{request.kind==='plan'?'继续规划':'拒绝'}</button>
    </div></div>;
}
