import {useEffect,useRef,useState} from 'react';
import {useComposerAttachments} from './composer-attachments';
import {useVoiceInput} from './use-voice-input';
import {AddOptions,Composer,useAttachmentPickers} from './composer';
import {QueuedMessages} from './queued-messages';
import {PermissionMenu,type PermissionOption} from './permission-picker';
import {ApprovalCard} from './approval-card';
import {SheetPanel} from './sheet';
import {voiceProviderLabel,type VoiceProvider} from '../src/shared/voice';
import {uploadAttachments,type UploadProgress} from './file-upload';
import {cachedView,rememberView,threadKey} from './session-cache';
import {traceOpen} from './trace';
import {seedOf,useSyncedPanel,useThreadSync} from './use-thread-sync';
import type {SyncLink} from './sync/engine';
import {MAX_ATTACHMENTS} from '../src/shared/attachments';
import {MAX_TOTAL_IMAGE_BYTES,imageBytes} from '../src/shared/images';
import {AntigravityErrorNotice,AntigravityMessages,antigravityIssueText} from './antigravity-messages';
import {AntigravityModelPicker,antigravityModelSupportsImages,type AntigravityCatalog} from './antigravity-model-picker';
import {connectionLost,ConversationStatus,elapsedLabel} from './conversation';
import {ThreadHeader,useComposerHeight,workspaceName} from './chat-layout';
import {IconButton} from './icon-button';
import {Icon} from './icons';
import {useStableEvent} from './use-event';
import {operationId} from './client';
import type {AntigravityBackgroundTask,ApprovalRequest,Json,QueuedMessage,RequestAction} from '../src/shared/types';
import {SenderScope} from './senders';
import {useTurnNotice,watchWhileHidden} from './turn-notify';

const IMAGES_BLOCKED='请更新这台电脑上的连接器后再给 Antigravity 发送图片。';
const MODEL_IMAGES_BLOCKED='当前所选模型不支持图片，请更换模型或移除图片。';

/**
 * Antigravity's Local Permissions, worded to align organically with Claude Code's mode menu
 * so switching between the two apps keeps the same mental model.
 */
export const ANTIGRAVITY_MODES:PermissionOption[]=[
  {id:'AGENT_PERMISSION_PRESET_AUTO',label:'自动',description:'自动判断是否允许执行命令'},
  {id:'AGENT_PERMISSION_PRESET_DEFAULT',label:'按需审批',description:'敏感操作前询问确认'},
  {id:'AGENT_PERMISSION_PRESET_REQUEST_REVIEW',label:'手动',description:'每条命令都需要你确认'},
  {id:'AGENT_PERMISSION_PRESET_TURBO',label:'跳过权限确认',description:'不加限制地自动执行所有命令',elevated:true},
];
const modeLabel=(mode:string)=>ANTIGRAVITY_MODES.find(item=>item.id===mode)?.label||mode;

function saved(key:string){try{return localStorage.getItem(key)||'';}catch{return '';}}
function store(key:string,value:string){try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}}
function storedCatalog(machine:string):AntigravityCatalog|null{
  try{
    const parsed=JSON.parse(saved(`antigravity:${machine}:catalog`)||'null');
    return parsed&&Array.isArray(parsed.models)?parsed:null;
  }catch{return null;}
}

type Props={
  inert:boolean;openFile:(path:string)=>void;openPreview:(url:string)=>void;previewError:string;machine:string;connected:boolean;
  conversationId:string;call:(action:RequestAction,payload?:Json)=>Promise<any>;go:(id:string)=>void;
  /** Without a conversation: the project (list id) a new conversation starts in, '' to choose one; `created` opens the new conversation. */
  newProject?:string|null;created?:(id:string)=>void;
  machineName:string;showFiles:()=>void;showImage:(url:string,title:string)=>void;copyText:(text:string)=>Promise<void>;clearPreviewError:()=>void;
  /** Voice provider chosen for Antigravity; `chooseVoice` opens this app's voice settings. */
  voiceMode:VoiceProvider;chooseVoice:()=>void;
  /** Set when the computer's connector pushes this app's conversations (`sync.antigravity`): the conversation follows it. */
  sync?:SyncLink;
};

export function BackgroundTasksBar({tasks,onOpen}:{tasks:AntigravityBackgroundTask[];onOpen:()=>void}){
  const count=tasks.length;
  const label=count?`${count} 个后台任务运行中`:'后台任务运行中';
  const title=tasks[0]?.title||'';
  return <button type="button" className="bg-tasks-bar" onClick={onOpen} aria-label={count?`查看 ${count} 个运行中的后台任务`:'查看运行中的后台任务'}>
    <i className="dot online" aria-hidden="true"/>
    <span className="bg-tasks-count">{label}</span>
    {title&&<span className="bg-tasks-title">{title}</span>}
    <span className="bg-tasks-open">查看<Icon name="chevron" size={14}/></span>
  </button>;
}

export function BackgroundTasksPanel({tasks,hasTasks,turnRunning,canOperate,busy,connected,onRefresh,onStop,onCopy}:{
  tasks:AntigravityBackgroundTask[];hasTasks:boolean;turnRunning:boolean;canOperate:boolean;busy:boolean;connected:boolean;
  onRefresh:()=>void;onStop:()=>void;onCopy:(text:string)=>void;
}){
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    if(!tasks.some(task=>task.startedAt))return;
    setNow(Date.now());
    const timer=setInterval(()=>setNow(Date.now()),1000);
    return()=>clearInterval(timer);
  },[tasks]);
  if(!hasTasks)return <p className="muted">当前没有运行中的后台任务。</p>;
  return <div className="bg-tasks-sheet">
    {tasks.length>0?tasks.map(task=>{
      const since=task.startedAt?Date.parse(task.startedAt):NaN;
      return <section className="bg-task-card" key={task.id}>
        <div className="bg-task-head">
          <strong>{task.title}</strong>
          {Number.isFinite(since)&&<span className="bg-task-time">{elapsedLabel(now-since)}</span>}
        </div>
        {task.command&&<div className="bg-task-cmd">
          <code>{task.command}</code>
          <IconButton icon="copy" label="复制命令" onClick={()=>onCopy(task.command!)}/>
        </div>}
        {task.cwd&&<p className="bg-task-cwd">目录：{task.cwd}</p>}
        <pre className="bg-task-output">{task.output||'暂无输出'}</pre>
      </section>;
    }):<p className="muted">Antigravity 报告当前会话仍有后台任务在运行，但未能读取任务详情。你可以继续发送消息，或结束后台任务。</p>}
    {turnRunning&&<p className="muted">当前对话也在处理中，结束后台任务会同时停止本轮回复。</p>}
    <div className="bg-tasks-actions">
      <button type="button" disabled={!connected||busy} onClick={onRefresh}>刷新状态</button>
      <button type="button" className="danger" disabled={!canOperate} onClick={onStop}>{tasks.length>1?'结束全部后台任务':'结束后台任务'}</button>
    </div>
  </div>;
}

export function AntigravityPanel(props:Props){
  const {machine,connected,conversationId,call,go,inert,openFile,openPreview,previewError}=props;
  const creating=!conversationId;
  const key=`antigravity:${machine}:${conversationId||'new'}`;
  const [projects,setProjects]=useState<{id:string;path:string;name?:string}[]|null>(null),[target,setTarget]=useState(props.newProject||'');
  // A conversation opened before shows what it last held at once, marked `cached` until the read below replaces it.
  const cacheKey=threadKey('antigravity',machine,conversationId);
  const [view,setView]=useState<Json|null>(()=>creating?null:cachedView<Json>(cacheKey));
  const cached=Boolean(view?.cached);
  useEffect(()=>{if(!creating)traceOpen('antigravity',cacheKey,'start');},[]);
  useEffect(()=>{
    if(!view||creating)return;
    traceOpen('antigravity',cacheKey,view.cached?'cached':'fresh');
    if(!view.cached)rememberView(cacheKey,view);
  },[view]);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[submitting,setSubmitting]=useState(false);
  const [draft,setDraft]=useState(()=>saved(`${key}:draft`)),[pending,setPending]=useState(()=>saved(`${key}:pending`));
  const [watchError,setWatchError]=useState('');
  const lock=useRef(false),alive=useRef(true),scroll=useRef<HTMLDivElement>(null),stick=useRef(true),composer=useRef<HTMLTextAreaElement>(null);
  useComposerHeight(composer,draft,true);
  const request=useRef(call);request.current=call;
  // A saved conversation keeps its own model until changed here; the last choice seeds new conversations.
  const [model,setModel]=useState(()=>creating?saved(`antigravity:${machine}:model`):saved(`${key}:model`));
  const [permissionMode,setPermissionMode]=useState('');
  const [defaultMode,setDefaultMode]=useState('');
  const [catalog,setCatalog]=useState<AntigravityCatalog|null>(()=>storedCatalog(machine));
  // Unknown (null) until the desktop's model list for the new conversation's project has been read.
  const [createImages,setCreateImages]=useState<boolean|null>(null),[adding,setAdding]=useState(false),[tasksOpen,setTasksOpen]=useState(false);
  // An older connector drops images without saying so; it only advertises them once it can send them.
  const readModels=useStableEvent(async()=>{
    const result:AntigravityCatalog=await request.current('antigravity.models',creating?{project:target}:{conversationId});
    if(alive.current){
      if(creating)setCreateImages(Boolean(result?.supportsImages));
      if(result?.defaultPermissionMode)setDefaultMode(result.defaultPermissionMode);
      setCatalog(result);
      store(`antigravity:${machine}:catalog`,JSON.stringify({models:result.models,groups:result.groups,defaultModel:result.defaultModel,supportsImages:result.supportsImages,current:null}));
    }
    return result;
  });
  function selectModel(id:string){
    setModel(id);
    if(creating)store(`antigravity:${machine}:model`,id);
    else store(`${key}:model`,id);
  }
  function edit(text:string){setDraft(text);store(`${key}:draft`,text);}
  const [uploadProgress,setUploadProgress]=useState<UploadProgress|null>(null);
  // Photos are compressed into the message; other files are uploaded to the project when it is sent.
  const connectorImages=creating?createImages:view?Boolean(view.supportsImages):null;
  const modelImages=antigravityModelSupportsImages(catalog,model);
  const imagesBlockedReason=connectorImages===false?IMAGES_BLOCKED:modelImages===false?MODEL_IMAGES_BLOCKED:undefined;
  const attachments=useComposerAttachments({disabled:busy||Boolean(pending),imagesBlocked:imagesBlockedReason,notify:setError,added:()=>setAdding(false)});
  const {images,files,setImages,setFiles}=attachments;
  const pick=useAttachmentPickers(chosen=>void attachments.add(chosen));
  function sent(){edit('');setImages([]);setFiles([]);}
  const voice=useVoiceInput(props.voiceMode,key,connected,{
    keyboard:()=>{composer.current?.focus();setNotice('请使用系统键盘上的麦克风听写。');},
    request:(action,payload)=>request.current(action,payload),
    draft:()=>draft,setDraft:edit,
    error:failed,
  });
  const voiceBusy=voice.state!=='idle';
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice]);
  /** Uploads the documents into the project on the computer; the message then links to them. */
  async function upload(scope:Json):Promise<Json>{
    if(!files.length)return {};
    try{return {files:await uploadAttachments(request.current,{prefix:'antigravity.',scope},files,value=>{if(alive.current)setUploadProgress(value);})};}
    finally{if(alive.current)setUploadProgress(null);}
  }
  const imagesBlocked=()=>{if(images.length&&imagesBlockedReason){setError(imagesBlockedReason);return true;}if(images.length&&connectorImages===false){setError(IMAGES_BLOCKED);return true;}return false;};
  const followup=useStableEvent((text:string)=>{if(!pending){edit(draft?draft+'\n'+text:text);composer.current?.focus();}});
  const copy=useStableEvent((text:string)=>{void props.copyText(text).catch(()=>setError('复制失败，请长按选择文字'));});
  function remember(op:string){setPending(op);store(`${key}:pending`,op);}
  function failed(e:any){if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用 Antigravity。':e?.message||'Antigravity 操作失败');}
  // With a connector that pushes conversations, the conversation follows its frames; reads and watches are for older ones.
  const synced=useThreadSync(creating?undefined:props.sync,'antigravity',conversationId,()=>seedOf(cachedView<Json>(cacheKey),'messages'));
  const syncing=Boolean(props.sync&&!creating);
  useSyncedPanel(synced.view,'messages',setView,setError,'请更新这台电脑上的连接器以使用 Antigravity。');
  async function refresh(quiet=false){
    if(!connected||creating)return;
    if(synced.engine.current){if(!quiet)setError('');await synced.engine.current.open();return;}
    if(lock.current)return;lock.current=true;setBusy(true);
    try{
      const value=await request.current('antigravity.read',{conversationId});
      if(!alive.current)return;
      setView(value);setWatchError('');
      if(!quiet)setError('');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{
    alive.current=true;
    return()=>{alive.current=false;};
  },[]);
  useEffect(()=>{
    if(!syncing)void refresh(true);
  },[connected]);
  useEffect(()=>{
    if(!creating||!connected)return;
    request.current('antigravity.list',{}).then(page=>{
      if(!alive.current)return;
      setProjects(page.projects||[]);setTarget(old=>old||page.projects?.[0]?.id||'');
      if(page.defaultPermissionMode)setDefaultMode(page.defaultPermissionMode);
    }).catch(failed);
  },[creating,connected]);
  useEffect(()=>{
    if(!connected||!view?.revision||syncing)return;
    let active=true,inflight=false;
    let timer:ReturnType<typeof setTimeout>;
    async function watch(){
      // Hidden, it keeps watching only for a turn's end to notify.
      if(!active||inflight||document.visibilityState!=='visible'&&!watchWhileHidden(view?.running))return;
      inflight=true;
      let retry=0;
      try{
        const next=await request.current('antigravity.watch',{conversationId,revision:view!.revision});
        if(!active)return;
        setWatchError('');
        if(!next.unchanged){
          setView(current=>{
            if(!current||current.revision!==view!.revision)return current;
            if(!next.base)return next;
            return {
              ...current,...next,
              requests:next.requests||[],
              backgroundTasks:next.backgroundTasks||[],
              queuedMessages:next.queuedMessages||[],
              notIdle:Boolean(next.notIdle),
              messages:[...current.messages.slice(0,next.keep),...next.messages],
            };
          });
          return;
        }
      }catch{if(active)setWatchError('与电脑的对话同步中断，正在重连…');retry=2500;}
      finally{inflight=false;}
      if(active)timer=setTimeout(watch,retry);
    }
    void watch();
    document.addEventListener('visibilitychange',watch);
    return()=>{active=false;clearTimeout(timer);document.removeEventListener('visibilitychange',watch);};
  },[connected,conversationId,view?.revision,syncing]);
  async function check(){
    if(lock.current||!pending||!connected)return;lock.current=true;setBusy(true);
    try{
      const result=await request.current('antigravity.operation',{opId:pending});
      if(!alive.current)return;
      if(result.state==='accepted'){if(result.submitted||result.kind==='queued')sent();remember('');setError('');if(creating&&result.conversationId)opened(result);}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError('结果尚未确认。请刷新聊天并在电脑核实；系统不会自动重发。');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(true);
  }
  /** Opens a conversation this page created, keeping the message as its draft when the desktop's receipt was lost. */
  function opened(result:Json){
    if(!result.submitted)store(`antigravity:${machine}:${result.conversationId}:draft`,draft);
    sent();props.created?.(result.conversationId);
  }
  /** Locks the panel and uploads the documents; null when the upload failed (its error is shown). */
  async function prepare(scope:Json):Promise<Json|null>{
    lock.current=true;setBusy(true);setError('');
    try{return await upload(scope);}
    catch(e){failed(e);lock.current=false;if(alive.current)setBusy(false);return null;}
  }
  // With documents the links carry the message, so typed text is optional.
  const message=()=>({text:draft.trim()?draft:'',...(images.length?{images}:{})});
  async function start(){
    if(lock.current||pending||!connected||!draft.trim()&&!files.length)return;
    if(!target){setError('请选择项目');return;}
    if(imagesBlocked())return;
    const attached=await prepare({project:target});if(!attached)return;
    setSubmitting(true);
    const opId=operationId();remember(opId);
    try{
      const result=await request.current('antigravity.create',{
        project:target,...message(),...attached,opId,
        ...(model?{model}:{}),
        ...(permissionMode?{permissionMode}:{}),
      });
      if(!alive.current)return;
      if(result.state==='accepted'){remember('');opened(result);}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请在电脑查看是否已新建对话。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current){setBusy(false);setSubmitting(false);}}
  }
  const backgroundTasks:AntigravityBackgroundTask[]=Array.isArray(view?.backgroundTasks)?view.backgroundTasks:[];
  const hasBackgroundTasks=backgroundTasks.length>0||Boolean(!view?.running&&view?.notIdle);
  const supportsQueue=Boolean(view?.supportsQueue);
  const queued:QueuedMessage[]=Array.isArray(view?.queuedMessages)?view.queuedMessages:[];
  async function mutate(action:'send'|'stop',options?:{killBackgroundTasks?:boolean}){
    if(action==='send'&&(attachments.loading||voiceBusy))return;
    if(creating){if(action==='send')void start();return;}
    if(lock.current||pending||!connected||cached)return;
    if(action==='send'&&(!draft.trim()&&!files.length||!(supportsQueue?Boolean(view):Boolean(view?.canSend))))return;
    const killBackgroundTasks=action==='stop'&&Boolean(options?.killBackgroundTasks);
    if(action==='stop'&&!view?.running&&!(killBackgroundTasks&&hasBackgroundTasks))return;
    if(action==='send'&&imagesBlocked())return;
    if(action==='send'&&model&&!view?.supportsModelSelection){setError('请更新电脑连接器后使用所选模型，或恢复当前对话模型。');return;}
    let attached:Json|null={};
    if(action==='send')attached=await prepare({conversationId});
    else{lock.current=true;setBusy(true);setError('');}
    if(!attached)return;
    if(action==='send')setSubmitting(true);
    const opId=operationId();remember(opId);
    try{
      const result=await request.current(`antigravity.${action}`,{
        conversationId,opId,turn:view?.turn,
        ...(action==='send'?{...message(),...attached,...(model?{model}:{}),...(permissionMode?{permissionMode}:{})}:{}),
        ...(killBackgroundTasks?{killBackgroundTasks:true}:{}),
      });
      if(!alive.current)return;
      if(result.state==='accepted'){
        if(action==='send'){
          sent();if(permissionMode)setPermissionMode('');
          setNotice(result.kind==='queued'?'已加入队列，当前任务结束后发送':result.kind==='steer_accepted'?'已追加到当前任务':result.kind==='sent_now'?'已立即发送':'');
        }
        if(killBackgroundTasks)setNotice('已请求结束后台任务');
        remember('');stick.current=true;
      }
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新聊天查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current){setBusy(false);setSubmitting(false);}}
    void refresh(true);
  }
  async function queueAction(action:'antigravity.steerQueued'|'antigravity.withdrawQueued'|'antigravity.cancelQueued',payload:Json,onAccepted:(result:Json)=>void){
    if(lock.current||pending||!connected||creating||cached)return;
    lock.current=true;setBusy(true);setError('');
    const opId=operationId();remember(opId);
    try{
      const result=await request.current(action,{...payload,opId});
      if(!alive.current)return;
      if(result.state==='accepted'){remember('');onAccepted(result);}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新聊天查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(true);
  }
  function withdrawQueued(queuedId:string){
    void queueAction('antigravity.withdrawQueued',{conversationId,queuedId},result=>{
      const msg=result.message||{};
      edit([draft.trim(),msg.text].filter(Boolean).join('\n\n'));
      if(Array.isArray(msg.images)&&msg.images.length)setImages(old=>[...old,...msg.images]);
      if(msg.model)selectModel(msg.model);
      setPermissionMode(msg.permissionMode||'');
      setNotice('已撤回到输入框');
      requestAnimationFrame(()=>composer.current?.focus());
    });
  }
  async function respondRequest(requestId:string,decision:'allow'|'allowSession'|'deny',answers?:Record<string,string>){
    if(lock.current||pending||!connected||creating||cached)return;
    lock.current=true;setBusy(true);setError('');
    const opId=operationId();remember(opId);
    try{
      const result=await request.current('antigravity.respond',{conversationId,requestId,decision,...(answers?{answers}:{}),opId});
      if(!alive.current)return;
      if(result.state==='accepted'){remember('');setNotice('回应已提交');}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'确认操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新聊天查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(true);
  }
  const issue=view?.issue;
  const requests:ApprovalRequest[]=view?.requests||[];
  useTurnNotice(key,view&&!cached?Boolean(view.running):undefined,requests.length,()=>({service:'Antigravity',title:view?.title,
    reply:view?.messages?.filter((message:Json)=>message.role==='assistant'&&message.text).at(-1)?.text}));
  const antigravityStatus=(
    !connected?(cached?'与电脑的连接中断，以下是上次打开时的内容。':connectionLost):watchError||
    (pending&&busy?'正在等待电脑确认…':cached?'正在同步最新内容…':issue&&issue.kind!=='error'?antigravityIssueText(issue,view!.canSend):
      view&&!view.running&&!view.canSend&&!requests.length?'正在等待 Antigravity…':'')
  );
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[view,antigravityStatus]);
  const trackScroll=()=>{const element=scroll.current!;stick.current=element.scrollHeight-element.scrollTop-element.clientHeight<80;};
  const checkPending=<><button disabled={!connected||busy} onClick={()=>void check()}>核实操作结果</button><button disabled={busy} onClick={()=>{if(window.confirm('请先在聊天和电脑页面确认操作结果。解除提示不会重发消息。')){remember('');setError('');}}}>我已核实</button></>;
  const feedback=error||previewError,sending=Boolean(pending&&busy&&submitting);
  // A cached view's state may be outdated; nothing is sent from it.
  const canOperate=connected&&!busy&&!pending&&!cached;
  const queueNext=!creating&&supportsQueue&&Boolean(view&&(view.running||!view.canSend||queued.length>0||requests.length>0));
  const canSendNow=creating?Boolean(target):(supportsQueue?Boolean(view):Boolean(view?.canSend));
  const effectiveMode=view?.permissionMode||view?.defaultPermissionMode||defaultMode||'AGENT_PERMISSION_PRESET_DEFAULT';
  const chosen=projects?.find(item=>item.id===target);
  const projectName=(item:{path:string;name?:string})=>item.name||workspaceName(item.path);
  return <main className="thread-panel" inert={inert}>
    <ThreadHeader title={creating?'新的 Antigravity 对话':view?.title||'正在打开…'} project={creating?(chosen?projectName(chosen):'选择项目'):view?.cwd?workspaceName(view.cwd):'Antigravity'} machineName={props.machineName} connected={connected} back={()=>go('')}>
      {!creating&&<IconButton icon="refresh" label="刷新会话" disabled={!connected||busy} onClick={()=>void refresh()}/>}
    </ThreadHeader>
    <div className={`timeline ${creating?'is-empty':''}`} ref={scroll} onScroll={trackScroll}><div className="timeline-content">
      {creating&&<div className="new-chat-welcome"><h1>交给 Antigravity</h1>
        <label className="claude-project"><Icon name="folder" size={18}/><select aria-label="项目" value={target} disabled={Boolean(pending)} onChange={e=>setTarget(e.target.value)}>
          {!target&&<option value="">{!projects?'正在读取项目…':'桌面上还没有项目'}</option>}
          {projects?.map(item=><option key={item.id} value={item.id}>{projectName(item)}</option>)}
        </select></label></div>}
      {view&&<SenderScope senders={view.messages.map((message:{sender?:{id:string;name:string}})=>message.sender)}><AntigravityMessages messages={view.messages} running={Boolean(view.running)} openFile={openFile} openPreview={openPreview} onFollowup={followup} onCopy={copy}/></SenderScope>}
      {!view&&(busy||synced.view?.phase==='syncing'&&!synced.view.error)&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
      {view&&!view.messages.length&&!issue&&<p className="muted">{view.running?'Antigravity 正在开始处理…':'桌面尚未记录可显示的消息。'}</p>}
      {issue?.kind==='error'&&<AntigravityErrorNotice issue={issue}/>}
      {antigravityStatus&&<ConversationStatus>{antigravityStatus}</ConversationStatus>}
    </div></div>
    <footer className="composer-area">
      <div className="request-stack">{requests.map(item=><ApprovalCard key={`${conversationId}:${item.id}`} request={item} disabled={!canOperate} modeLabel={modeLabel}
        respond={(decision,answers)=>void respondRequest(item.id,decision,answers)}/>)}</div>
      {feedback&&<div className="feedback error" role="alert"><span>{feedback}</span><IconButton icon="close" label="关闭提示" onClick={()=>{setError('');props.clearPreviewError();}}/></div>}
      {notice&&<div className="feedback" role="status">{notice}</div>}
      {pending&&!busy&&<div className="pending">{checkPending}</div>}
      {view?.running&&!antigravityStatus&&!requests.length&&<div className="running-status"><i className="dot online"/>Antigravity 正在处理</div>}
      {hasBackgroundTasks&&<BackgroundTasksBar tasks={backgroundTasks} onOpen={()=>setTasksOpen(true)}/>}
      {!creating&&<QueuedMessages messages={queued} disabled={!canOperate} canSteer={Boolean(view?.running)} withdrawBlocked={voiceBusy||attachments.loading}
        nowLabel="立即发送（打断当前回复并发送；保留后台任务）"
        attachmentsFull={message=>attachments.count+message.imageCount>MAX_ATTACHMENTS||images.reduce((sum,url)=>sum+imageBytes(url),0)+(message.imageBytes||0)>MAX_TOTAL_IMAGE_BYTES}
        onSteer={queuedId=>void queueAction('antigravity.steerQueued',{conversationId,queuedId},()=>setNotice('已追加到当前任务'))}
        onNow={queuedId=>void queueAction('antigravity.steerQueued',{conversationId,queuedId,mode:'now'},result=>setNotice(result.kind==='sent_now'?'已立即发送':'已追加到当前任务'))}
        onWithdraw={withdrawQueued}
        onCancel={queuedId=>void queueAction('antigravity.cancelQueued',{conversationId,queuedId},()=>setNotice('已删除排队消息'))}/>}
      <Composer attachments={attachments} input={composer} draft={draft} edit={edit} maxLength={50_000} readOnly={Boolean(pending)} submit={()=>void mutate('send')}
        placeholder={creating?'想让 Antigravity 做什么？':queueNext?'当前任务完成后发送…':view?.running?'当前任务结束后可发送':`在 ${props.machineName} 上继续…`}
        locked={busy||Boolean(pending)} showImage={props.showImage} uploadProgress={uploadProgress}
        voice={voice} voiceMode={props.voiceMode} voiceDisabled={busy||Boolean(pending)} onVoiceStart={()=>{setError('');setNotice('');}} connected={connected}
        add={()=>setAdding(true)} addDisabled={busy||Boolean(pending)||attachments.loading}
        permission={<PermissionMenu options={ANTIGRAVITY_MODES} value={permissionMode} current={{id:effectiveMode,label:modeLabel(effectiveMode)}} disabled={!canOperate} onChange={setPermissionMode}/>}
        model={<AntigravityModelPicker read={readModels} cached={catalog} turn={creating?target:view?.turn||''} value={model} available={connected&&(creating?Boolean(target):Boolean(view?.supportsModelSelection))} disabled={!canOperate} onChange={selectModel}/>}
        running={view?.running?{stop:()=>void mutate('stop'),disabled:!canOperate,queue:supportsQueue}:undefined}
        send={{label:queueNext?'完成后发送':'发送消息',sending,disabled:!canOperate||attachments.loading||voiceBusy||!canSendNow||!draft.trim()&&!files.length}}/>
      {pick.inputs}
    </footer>
    {tasksOpen&&<SheetPanel title="后台任务" close={()=>setTasksOpen(false)}>
      <BackgroundTasksPanel tasks={backgroundTasks} hasTasks={hasBackgroundTasks} turnRunning={Boolean(view?.running)}
        canOperate={canOperate} busy={busy} connected={connected}
        onRefresh={()=>void refresh()} onStop={()=>void mutate('stop',{killBackgroundTasks:true})} onCopy={copy}/>
    </SheetPanel>}
    {adding&&<SheetPanel title="添加与选项" close={()=>setAdding(false)}>
      <AddOptions attachments={attachments} pick={pick} disabled={busy||Boolean(pending)} connected={connected} error={error}
        imagesBlocked={imagesBlockedReason}
        voiceLabel={voiceProviderLabel(props.voiceMode)} chooseVoice={()=>{setAdding(false);props.chooseVoice();}}
        projectFiles={creating?undefined:()=>{setAdding(false);props.showFiles();}} refresh={creating?undefined:()=>{setAdding(false);void refresh();}}/>
    </SheetPanel>}
  </main>;
}
