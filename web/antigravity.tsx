import {useEffect,useRef,useState} from 'react';
import {AntigravityMessages,antigravityIssueText} from './antigravity-messages';
import {AntigravityModelPicker} from './antigravity-model-picker';
import {connectionLost,ConversationStatus} from './conversation';
import {SendMessageButton,ThreadHeader,submitOnDesktop,useComposerHeight,workspaceName} from './chat-layout';
import {IconButton} from './icon-button';
import {Icon} from './icons';
import {useStableEvent} from './use-event';
import {operationId} from './client';
import type {Json,RequestAction} from '../src/shared/types';
function saved(key:string){try{return localStorage.getItem(key)||'';}catch{return '';}}
function store(key:string,value:string){try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}}
type Props={
  inert:boolean;openFile:(path:string)=>void;openPreview:(url:string)=>void;previewError:string;machine:string;connected:boolean;
  conversationId:string;call:(action:RequestAction,payload?:Json)=>Promise<any>;go:(id:string)=>void;
  /** Without a conversation: the project (list id) a new conversation starts in, '' to choose one; `created` opens the new conversation. */
  newProject?:string|null;created?:(id:string)=>void;
  machineName:string;showFiles:()=>void;copyText:(text:string)=>Promise<void>;clearPreviewError:()=>void;
};

export function AntigravityPanel(props:Props){
  const {machine,connected,conversationId,call,go,inert,openFile,openPreview,previewError}=props;
  const creating=!conversationId;
  const key=`antigravity:${machine}:${conversationId||'new'}`;
  const [projects,setProjects]=useState<{id:string;path:string;name?:string}[]|null>(null),[target,setTarget]=useState(props.newProject||'');
  const [view,setView]=useState<Json|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [draft,setDraft]=useState(()=>saved(`${key}:draft`)),[pending,setPending]=useState(()=>saved(`${key}:pending`));
  const [watchError,setWatchError]=useState('');
  const lock=useRef(false),alive=useRef(true),scroll=useRef<HTMLDivElement>(null),stick=useRef(true),composer=useRef<HTMLTextAreaElement>(null);
  useComposerHeight(composer,draft,true);
  const request=useRef(call);request.current=call;
  const [model,setModel]=useState(()=>saved(`${key}:model`));
  const readModels=useStableEvent(()=>request.current('antigravity.models',creating?{project:target}:{conversationId}));
  function selectModel(id:string){setModel(id);store(`${key}:model`,id);}
  function edit(text:string){setDraft(text);store(`${key}:draft`,text);}
  const followup=useStableEvent((text:string)=>{if(!pending){edit(draft?draft+'\n'+text:text);composer.current?.focus();}});
  const copy=useStableEvent((text:string)=>{void props.copyText(text).catch(()=>setError('复制失败，请长按选择文字'));});
  function remember(op:string){setPending(op);store(`${key}:pending`,op);}
  function failed(e:any){if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用 Antigravity。':e?.message||'Antigravity 操作失败');}
  async function refresh(quiet=false){
    if(!connected||lock.current||creating)return;lock.current=true;setBusy(true);
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
    void refresh(true);
  },[connected]);
  useEffect(()=>{
    if(!creating||!connected)return;
    request.current('antigravity.list',{}).then(page=>{
      if(!alive.current)return;
      setProjects(page.projects||[]);setTarget(old=>old||page.projects?.[0]?.id||'');
    }).catch(failed);
  },[creating,connected]);
  useEffect(()=>{
    if(!connected||!view?.revision)return;
    let active=true,inflight=false;
    let timer:ReturnType<typeof setTimeout>;
    async function watch(){
      if(!active||inflight||document.visibilityState!=='visible')return;
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
            return {...current,...next,messages:[...current.messages.slice(0,next.keep),...next.messages]};
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
  },[connected,conversationId,view?.revision]);
  async function check(){
    if(lock.current||!pending||!connected)return;lock.current=true;setBusy(true);
    try{
      const result=await request.current('antigravity.operation',{opId:pending});
      if(!alive.current)return;
      if(result.state==='accepted'){if(result.submitted)edit('');remember('');setError('');if(creating&&result.conversationId)opened(result);}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError('结果尚未确认。请刷新聊天并在电脑核实；系统不会自动重发。');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(true);
  }
  /** Opens a conversation this page created, keeping the message as its draft when the desktop's receipt was lost. */
  function opened(result:Json){
    if(!result.submitted)store(`antigravity:${machine}:${result.conversationId}:draft`,draft);
    edit('');props.created?.(result.conversationId);
  }
  async function start(){
    if(lock.current||pending||!connected||!draft.trim())return;
    if(!target){setError('请选择项目');return;}
    lock.current=true;setBusy(true);setError('');
    const opId=operationId();remember(opId);
    try{
      const result=await request.current('antigravity.create',{project:target,text:draft,opId,...(model?{model}:{})});
      if(!alive.current)return;
      if(result.state==='accepted'){remember('');opened(result);}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请在电脑查看是否已新建对话。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  async function mutate(action:'send'|'stop'){
    if(creating){if(action==='send')void start();return;}
    if(lock.current||pending||!connected)return;
    if(action==='send'&&(!draft.trim()||!view?.canSend))return;
    if(action==='stop'&&!view?.running)return;
    if(action==='send'&&model&&!view?.supportsModelSelection){setError('请更新电脑连接器后使用所选模型，或选择“沿用对话设置”。');return;}
    lock.current=true;setBusy(true);setError('');
    const opId=operationId();remember(opId);
    try{
      const result=await request.current(`antigravity.${action}`,{conversationId,opId,turn:view?.turn,...(action==='send'?{text:draft,...(model?{model}:{})}:{})});
      if(!alive.current)return;
      if(result.state==='accepted'){if(action==='send')edit('');remember('');stick.current=true;}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新聊天查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(true);
  }
  const issue=view?.issue;
  const antigravityStatus=(
    !connected?connectionLost:watchError||
    (pending&&busy?'正在等待电脑确认…':issue?antigravityIssueText(issue,view!.canSend):
      view&&!view.running&&!view.canSend?'正在等待 Antigravity…':'')
  );
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[view,antigravityStatus]);
  const trackScroll=()=>{const element=scroll.current!;stick.current=element.scrollHeight-element.scrollTop-element.clientHeight<80;};
  const checkPending=<><button disabled={!connected||busy} onClick={()=>void check()}>核实操作结果</button><button disabled={busy} onClick={()=>{if(window.confirm('请先在聊天和电脑页面确认操作结果。解除提示不会重发消息。')){remember('');setError('');}}}>我已核实</button></>;
  const feedback=error||previewError,sending=Boolean(pending&&busy&&!view?.running);
  const canOperate=connected&&!busy&&!pending;
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
      {view&&<AntigravityMessages messages={view.messages} running={Boolean(view.running)} openFile={openFile} openPreview={openPreview} onFollowup={followup} onCopy={copy}/>}
      {!view&&busy&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
      {view&&!view.messages.length&&<p className="muted">{view.running?'Antigravity 正在开始处理…':'桌面尚未记录可显示的消息。'}</p>}
      {antigravityStatus&&<ConversationStatus>{antigravityStatus}</ConversationStatus>}
    </div></div>
    <footer className="composer-area">
      {feedback&&<div className="feedback error" role="alert"><span>{feedback}</span><IconButton icon="close" label="关闭提示" onClick={()=>{setError('');props.clearPreviewError();}}/></div>}
      {pending&&!busy&&<div className="pending">{checkPending}</div>}
      {view?.running&&!antigravityStatus&&<div className="running-status"><i className="dot online"/>Antigravity 正在处理</div>}
      <form className="composer" onSubmit={event=>{event.preventDefault();void mutate('send');}}>
        <textarea ref={composer} aria-label="任务输入" placeholder={creating?'想让 Antigravity 做什么？':`在 ${props.machineName} 上继续…`} readOnly={Boolean(pending)} value={draft} maxLength={50_000} rows={1}
          onChange={event=>edit(event.target.value)} onKeyDown={event=>submitOnDesktop(event,()=>void mutate('send'))}/>
        <div className="composer-toolbar">
          {!creating&&<IconButton icon="file" label="查看项目文件" className="composer-add" disabled={!connected||!view} onClick={props.showFiles}/>}
          <AntigravityModelPicker read={readModels} turn={creating?target:view?.turn||''} value={model} available={connected&&(creating?Boolean(target):Boolean(view?.supportsModelSelection))} disabled={!canOperate} onChange={selectModel}/>
          <div className="composer-actions">
            {view?.running?<IconButton icon="stop" label="停止当前任务" className="black round stop" disabled={!canOperate} onClick={()=>void mutate('stop')}/>:
              <SendMessageButton sending={sending} label="发送消息" disabled={!canOperate||!(creating?target:view?.canSend)||!draft.trim()}/>}
          </div>
        </div>
      </form>
    </footer>
  </main>;
}
