import {useEffect,useRef,useState,type ReactNode} from 'react';
import {AntigravityMessages,antigravityIssueText} from './antigravity-messages';
import {AntigravityModelPicker} from './antigravity-model-picker';
import {connectionLost,ConversationStatus} from './conversation';
import {SendMessageButton,ThreadHeader,submitOnDesktop,useComposerHeight,workspaceName} from './chat-layout';
import {IconButton} from './icon-button';
import {useStableEvent} from './use-event';
import {Icon} from './icons';
import {operationId} from './client';
import type {Json,RequestAction} from '../src/shared/types';
import './chatgpt.css';

export function chatgptId(value:string){
  try{
    const url=new URL(value);
    return url.origin==='https://chatgpt.com'?url.pathname.match(/\/c\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i)?.[1]||'':'';
  }catch{return '';}
}
function saved(key:string){try{return localStorage.getItem(key)||'';}catch{return '';}}
function store(key:string,value:string){try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}}
type Props={inert:boolean;openFile:(path:string)=>void;openPreview:(url:string)=>void;previewError:string;machine:string;connected:boolean;conversationId:string;call:(action:RequestAction,payload?:Json)=>Promise<any>;go:(id:string)=>void}
  & ({service:'chatgpt';switcher:ReactNode;back:()=>void}|{service:'antigravity';machineName:string;showFiles:()=>void;copyText:(text:string)=>Promise<void>;clearPreviewError:()=>void});

export function RemoteChatPanel(props:Props){
  const {service,machine,connected,conversationId,call,go,inert,openFile,openPreview,previewError}=props;
  const isAntigravity=service==='antigravity',name=isAntigravity?'Antigravity':'ChatGPT';
  const key=`${service}:${machine}:${conversationId}`;
  const [bridge,setBridge]=useState<Json|null>(null),[items,setItems]=useState<Json[]>([]),[view,setView]=useState<Json|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[link,setLink]=useState('');
  const [draft,setDraft]=useState(()=>saved(`${key}:draft`)),[pending,setPending]=useState(()=>saved(`${key}:pending`));
  const [watchError,setWatchError]=useState('');
  const lock=useRef(false),alive=useRef(true),scroll=useRef<HTMLDivElement>(null),stick=useRef(true),composer=useRef<HTMLTextAreaElement>(null);
  useComposerHeight(composer,draft,isAntigravity);
  const request=useRef(call);request.current=call;
  const [model,setModel]=useState(()=>saved(`${key}:model`));
  const readModels=useStableEvent(()=>request.current('antigravity.models',{conversationId}));
  function selectModel(id:string){setModel(id);store(`${key}:model`,id);}
  function edit(text:string){setDraft(text);store(`${key}:draft`,text);}
  const followup=useStableEvent((text:string)=>{if(!pending){edit(draft?draft+'\n'+text:text);composer.current?.focus();}});
  const copy=useStableEvent((text:string)=>{if(props.service==='antigravity')void props.copyText(text).catch(()=>setError('复制失败，请长按选择文字'));});
  function remember(op:string){setPending(op);store(`${key}:pending`,op);}
  function failed(e:any){if(alive.current)setError(isAntigravity&&e?.code==='unsupported'?'请更新这台电脑上的连接器以使用 Antigravity。':e?.message||`${name} 操作失败`);}
  async function refresh(more=false,quiet=false){
    if(!connected||lock.current)return;lock.current=true;setBusy(true);
    try{
      if(!isAntigravity){
        const state=await request.current('chatgpt.status');if(!alive.current)return;setBridge(state);
        if(!state.connected||!state.pageReady)return;
      }
      const value=await request.current(conversationId?`${service}.read`:'chatgpt.list',conversationId?{conversationId}:{more});
      if(!alive.current)return;
      if(conversationId){setView(value);setWatchError('');}
      else setItems(old=>more?[...new Map([...old,...value.data].map(item=>[item.id,item])).values()]:value.data);
      if(!quiet)setError('');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{
    alive.current=true;
    return()=>{alive.current=false;};
  },[]);
  useEffect(()=>{
    void refresh(false,isAntigravity);
    const timer=conversationId&&!isAntigravity?setInterval(()=>{if(document.visibilityState==='visible')void refresh(false,true);},2500):undefined;
    return()=>clearInterval(timer);
  },[connected]);
  useEffect(()=>{
    if(!isAntigravity||!connected||!view?.revision)return;
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
  },[isAntigravity,connected,conversationId,view?.revision]);
  async function check(){
    if(lock.current||!pending||!connected)return;lock.current=true;setBusy(true);
    try{
      const result=await request.current(`${service}.operation`,{opId:pending});
      if(!alive.current)return;
      if(result.state==='accepted'){if(result.submitted)edit('');remember('');setError('');}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError('结果尚未确认。请刷新聊天并在电脑核实；系统不会自动重发。');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(false,true);
  }
  async function mutate(action:'send'|'stop'){
    if(lock.current||pending||!connected)return;
    if(action==='send'&&(!draft.trim()||isAntigravity&&!view?.canSend))return;
    if(action==='stop'&&isAntigravity&&!view?.running)return;
    if(action==='send'&&isAntigravity&&model&&!view?.supportsModelSelection){setError('请更新电脑连接器后使用所选模型，或选择“沿用对话设置”。');return;}
    lock.current=true;setBusy(true);setError('');
    const opId=operationId();remember(opId);
    try{
      const result=await request.current(`${service}.${action}`,{conversationId,opId,...(isAntigravity?{turn:view?.turn}:{}),...(action==='send'?{text:draft,...(isAntigravity&&model?{model}:{})}:{})});
      if(!alive.current)return;
      if(result.state==='accepted'){if(action==='send')edit('');remember('');stick.current=true;}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新聊天查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(false,true);
  }
  const ready=connected&&(isAntigravity||bridge?.connected&&bridge?.pageReady);
  const issue=isAntigravity&&view?.issue;
  const antigravityStatus=isAntigravity&&conversationId&&(
    !connected?connectionLost:watchError||
    (pending&&busy?'正在等待电脑确认…':issue?antigravityIssueText(issue,view!.canSend):
      view&&!view.running&&!view.canSend?'正在等待 Antigravity…':'')
  );
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[view,antigravityStatus]);
  const trackScroll=()=>{const element=scroll.current!;stick.current=element.scrollHeight-element.scrollTop-element.clientHeight<80;};
  const checkPending=<><button disabled={!connected||busy} onClick={()=>void check()}>核实操作结果</button><button disabled={busy} onClick={()=>{if(window.confirm('请先在聊天和电脑页面确认操作结果。解除提示不会重发消息。')){remember('');setError('');}}}>我已核实</button></>;
  if(props.service==='antigravity'){
    const feedback=error||previewError,sending=Boolean(pending&&busy&&!view?.running);
    const canOperate=connected&&!busy&&!pending;
    return <main className="thread-panel" inert={inert}>
      <ThreadHeader title={view?.title||'正在打开…'} project={view?.cwd?workspaceName(view.cwd):name} machineName={props.machineName} connected={connected} back={()=>go('')}>
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
  return <main className="chatgpt-panel" inert={inert}>
    <header className="chatgpt-header"><button aria-label={conversationId?'返回 ChatGPT 列表':'返回 Codex'} onClick={()=>conversationId?go(''):props.back()}><Icon name="back"/></button><div><strong>{conversationId?view?.title||name:name}</strong><small>{connected?'浏览器账号中的聊天':'电脑未连接'}</small></div><button disabled={!connected||busy} onClick={()=>void refresh()} aria-label="刷新">刷新</button></header>
    {!conversationId&&props.switcher}
    {(error||previewError)&&<p className="chatgpt-notice error" role="alert">{error||previewError}</p>}
    {connected&&bridge&&(!bridge.connected||!bridge.pageReady)&&<div className="chatgpt-setup"><h2>{bridge.connected?'等待 ChatGPT 页面':'连接 ChatGPT 浏览器'}</h2><p>{bridge.notice||'请在电脑打开已登录的 ChatGPT 页面，并在扩展中连接该标签页。'}</p><ol><li>在电脑扩展管理页加载准备好的 <code>.local/chatgpt-extension</code> 文件夹。</li><li>打开已登录目标账号的 ChatGPT 页面，点击扩展，选择“连接当前页面”。</li><li>保持页面打开，在这里刷新。</li></ol></div>}
    {!conversationId?<div className="chatgpt-list">
      <label>筛选已加载聊天<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="聊天标题"/></label>
      <form onSubmit={event=>{event.preventDefault();const id=chatgptId(link.trim());if(id)go(id);else setError('请粘贴 https://chatgpt.com/c/… 聊天链接');}}><input aria-label="ChatGPT 聊天链接" value={link} onChange={event=>setLink(event.target.value)} placeholder="或粘贴 ChatGPT 聊天链接"/><button disabled={!ready||busy}>打开</button></form>
      {items.filter(item=>item.title.toLowerCase().includes(query.toLowerCase())).map(item=><button className="chatgpt-row" key={item.id} onClick={()=>go(item.id)}><Icon name="chat"/><span>{item.title}</span></button>)}
      {ready&&!items.length&&!busy&&!error&&<p>侧栏暂未读到聊天。请在电脑展开侧栏，或粘贴聊天链接。</p>}
      {ready&&<button disabled={busy} onClick={()=>void refresh(true)}>{busy?'正在读取…':'加载更多聊天'}</button>}
      <p className="chatgpt-help">使用扩展选定标签页的账号。搜索只筛选已加载的聊天。</p>
    </div>:<>
      <div className="chatgpt-messages" ref={scroll} onScroll={trackScroll}>
        {view?.messages.map((message:Json)=><article key={message.id} className={`chatgpt-message ${message.role}`}><small>{message.role==='tool'?'工具':message.role==='user'?'你':name}</small><div>{message.text}</div></article>)}
        {!view&&!error&&<p>{busy?'正在读取聊天…':'连接浏览器后读取聊天。'}</p>}
        {view?.running&&<p role="status">{name} 正在运行…</p>}
      </div>
      <footer className="chatgpt-footer">
        {pending&&<div className="chatgpt-pending"><span>发送或停止结果待核实</span>{checkPending}</div>}
        <form onSubmit={event=>{event.preventDefault();void mutate('send');}}><textarea aria-label="发送给 ChatGPT" placeholder="继续这个 ChatGPT 对话…" readOnly={Boolean(pending)} value={draft} maxLength={50_000} onChange={event=>edit(event.target.value)} rows={3}/><div>
          {view?.running?<button type="button" disabled={!ready||busy||Boolean(pending)} onClick={()=>void mutate('stop')}>停止生成</button>:<button className="primary" disabled={!ready||!view||busy||Boolean(pending)||!draft.trim()}>发送</button>}</div></form>
        <small>{view?.notice||'使用电脑浏览器中的 ChatGPT，登录和草稿请在电脑处理。'}</small>
      </footer>
    </>}
  </main>;
}
