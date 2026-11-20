import {useEffect,useRef,useState} from 'react';
import {AntigravityMessages,antigravityIssueText} from './antigravity-messages';
import {AntigravityModelPicker} from './antigravity-model-picker';
import {connectionLost,ConversationStatus} from './conversation';
import {SendMessageButton,ThreadHeader,submitOnDesktop,useComposerHeight,workspaceName} from './chat-layout';
import {IconButton} from './icon-button';
import {useStableEvent} from './use-event';
import {operationId} from './client';
import type {Json,RequestAction} from '../src/shared/types';
function saved(key:string){try{return localStorage.getItem(key)||'';}catch{return '';}}
function store(key:string,value:string){try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}}
type Props={
  inert:boolean;openFile:(path:string)=>void;openPreview:(url:string)=>void;previewError:string;machine:string;connected:boolean;
  conversationId:string;call:(action:RequestAction,payload?:Json)=>Promise<any>;go:(id:string)=>void;
  machineName:string;showFiles:()=>void;copyText:(text:string)=>Promise<void>;clearPreviewError:()=>void;
};

export function AntigravityPanel(props:Props){
  const {machine,connected,conversationId,call,go,inert,openFile,openPreview,previewError}=props;
  const key=`antigravity:${machine}:${conversationId}`;
  const [view,setView]=useState<Json|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [draft,setDraft]=useState(()=>saved(`${key}:draft`)),[pending,setPending]=useState(()=>saved(`${key}:pending`));
  const [watchError,setWatchError]=useState('');
  const lock=useRef(false),alive=useRef(true),scroll=useRef<HTMLDivElement>(null),stick=useRef(true),composer=useRef<HTMLTextAreaElement>(null);
  useComposerHeight(composer,draft,true);
  const request=useRef(call);request.current=call;
  const [model,setModel]=useState(()=>saved(`${key}:model`));
  const readModels=useStableEvent(()=>request.current('antigravity.models',{conversationId}));
  function selectModel(id:string){setModel(id);store(`${key}:model`,id);}
  function edit(text:string){setDraft(text);store(`${key}:draft`,text);}
  const followup=useStableEvent((text:string)=>{if(!pending){edit(draft?draft+'\n'+text:text);composer.current?.focus();}});
  const copy=useStableEvent((text:string)=>{void props.copyText(text).catch(()=>setError('复制失败，请长按选择文字'));});
  function remember(op:string){setPending(op);store(`${key}:pending`,op);}
  function failed(e:any){if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用 Antigravity。':e?.message||'Antigravity 操作失败');}
  async function refresh(quiet=false){
    if(!connected||lock.current)return;lock.current=true;setBusy(true);
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
      if(result.state==='accepted'){if(result.submitted)edit('');remember('');setError('');}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError('结果尚未确认。请刷新聊天并在电脑核实；系统不会自动重发。');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(true);
  }
  async function mutate(action:'send'|'stop'){
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
  return <main className="thread-panel" inert={inert}>
    <ThreadHeader title={view?.title||'正在打开…'} project={view?.cwd?workspaceName(view.cwd):'Antigravity'} machineName={props.machineName} connected={connected} back={()=>go('')}>
      <IconButton icon="refresh" label="刷新会话" disabled={!connected||busy} onClick={()=>void refresh()}/>
    </ThreadHeader>
    <div className="timeline" ref={scroll} onScroll={trackScroll}><div className="timeline-content">
      {view&&<AntigravityMessages messages={view.messages} running={Boolean(view.running)} openFile={openFile} openPreview={openPreview} onFollowup={followup} onCopy={copy}/>}
      {!view&&busy&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
      {view&&!view.messages.length&&<p className="muted">桌面尚未记录可显示的消息。</p>}
      {antigravityStatus&&<ConversationStatus>{antigravityStatus}</ConversationStatus>}
    </div></div>
    <footer className="composer-area">
      {feedback&&<div className="feedback error" role="alert"><span>{feedback}</span><IconButton icon="close" label="关闭提示" onClick={()=>{setError('');props.clearPreviewError();}}/></div>}
      {pending&&!busy&&<div className="pending">{checkPending}</div>}
      {view?.running&&!antigravityStatus&&<div className="running-status"><i className="dot online"/>Antigravity 正在处理</div>}
      <form className="composer" onSubmit={event=>{event.preventDefault();void mutate('send');}}>
        <textarea ref={composer} aria-label="任务输入" placeholder={`在 ${props.machineName} 上继续…`} readOnly={Boolean(pending)} value={draft} maxLength={50_000} rows={1}
          onChange={event=>edit(event.target.value)} onKeyDown={event=>submitOnDesktop(event,()=>void mutate('send'))}/>
        <div className="composer-toolbar">
          <IconButton icon="file" label="查看项目文件" className="composer-add" disabled={!connected||!view} onClick={props.showFiles}/>
          <AntigravityModelPicker read={readModels} turn={view?.turn||''} value={model} available={connected&&Boolean(view?.supportsModelSelection)} disabled={!canOperate} onChange={selectModel}/>
          <div className="composer-actions">
            {view?.running?<IconButton icon="stop" label="停止当前任务" className="black round stop" disabled={!canOperate} onClick={()=>void mutate('stop')}/>:
              <SendMessageButton sending={sending} label="发送消息" disabled={!canOperate||!view?.canSend||!draft.trim()}/>}
          </div>
        </div>
      </form>
    </footer>
  </main>;
}
