import {useEffect,useRef,useState} from 'react';
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
type Props={machine:string;connected:boolean;conversationId:string;call:(action:RequestAction,payload?:Json)=>Promise<any>;go:(id:string)=>void;back:()=>void};

export function ChatGPTPanel({machine,connected,conversationId,call,go,back}:Props){
  const key=`chatgpt:${machine}:${conversationId}`;
  const [bridge,setBridge]=useState<Json|null>(null),[items,setItems]=useState<Json[]>([]),[view,setView]=useState<Json|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState(''),[link,setLink]=useState('');
  const [draft,setDraft]=useState(()=>saved(`${key}:draft`)),[pending,setPending]=useState(()=>saved(`${key}:pending`));
  const lock=useRef(false),alive=useRef(true),scroll=useRef<HTMLDivElement>(null),stick=useRef(true);
  const request=useRef(call);request.current=call;
  function edit(text:string){setDraft(text);store(`${key}:draft`,text);}
  function remember(op:string){setPending(op);store(`${key}:pending`,op);}
  function failed(e:any){if(alive.current)setError(e?.message||'ChatGPT 操作失败');}
  async function refresh(more=false,quiet=false){
    if(!connected||lock.current)return;lock.current=true;setBusy(true);
    try{
      const state=await request.current('chatgpt.status');if(!alive.current)return;setBridge(state);
      if(!state.connected||!state.pageReady)return;
      const value=await request.current(conversationId?'chatgpt.read':'chatgpt.list',conversationId?{conversationId}:{more});
      if(!alive.current)return;
      if(conversationId)setView(value);
      else setItems(old=>more?[...new Map([...old,...value.data].map(item=>[item.id,item])).values()]:value.data);
      if(!quiet)setError('');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{
    alive.current=true;void refresh();
    const timer=conversationId?setInterval(()=>{if(document.visibilityState==='visible')void refresh(false,true);},2500):undefined;
    return()=>{alive.current=false;clearInterval(timer);};
  },[connected]);
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[view]);
  async function check(){
    if(lock.current||!pending||!connected)return;lock.current=true;setBusy(true);
    try{
      const result=await request.current('chatgpt.operation',{opId:pending});
      if(!alive.current)return;
      if(result.state==='accepted'){if(result.submitted)edit('');remember('');setError('');}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError('结果尚未确认。请刷新聊天并在电脑核实；系统不会自动重发。');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh();
  }
  async function mutate(action:'chatgpt.send'|'chatgpt.stop'){
    if(lock.current||pending||!connected)return;lock.current=true;setBusy(true);setError('');
    const opId=operationId();remember(opId);
    try{
      const result=await request.current(action,{conversationId,opId,...(action==='chatgpt.send'?{text:draft}:{})});
      if(!alive.current)return;
      if(result.state==='accepted'){if(action==='chatgpt.send')edit('');remember('');stick.current=true;}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新聊天查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh();
  }
  const ready=connected&&bridge?.connected&&bridge?.pageReady;
  return <main className="chatgpt-panel">
    <header className="chatgpt-header"><button aria-label={conversationId?'返回 ChatGPT 列表':'返回 Codex'} onClick={()=>conversationId?go(''):back()}><Icon name="back"/></button><div><strong>{conversationId?view?.title||'ChatGPT 聊天':'ChatGPT'}</strong><small>{connected?'浏览器账号中的聊天':'电脑未连接'}</small></div><button disabled={!connected||busy} onClick={()=>void refresh()} aria-label="刷新">刷新</button></header>
    {error&&<p className="chatgpt-notice error" role="alert">{error}</p>}
    {connected&&bridge&&(!bridge.connected||!bridge.pageReady)&&<div className="chatgpt-setup"><h2>{bridge.connected?'等待 ChatGPT 页面':'连接 ChatGPT 浏览器'}</h2><p>{bridge.notice||'请在电脑打开已登录的 ChatGPT 页面，并在扩展中连接该标签页。'}</p><ol><li>在电脑扩展管理页加载准备好的 <code>.local/chatgpt-extension</code> 文件夹。</li><li>打开已登录目标账号的 ChatGPT 页面，点击扩展，选择“连接当前 ChatGPT 页面”。</li><li>保持页面打开，在这里刷新。</li></ol></div>}
    {!conversationId?<div className="chatgpt-list">
      <label>筛选已加载聊天<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="聊天标题"/></label>
      <form onSubmit={event=>{event.preventDefault();const id=chatgptId(link.trim());if(id)go(id);else setError('请粘贴 https://chatgpt.com/c/… 聊天链接');}}><input aria-label="ChatGPT 聊天链接" value={link} onChange={event=>setLink(event.target.value)} placeholder="或粘贴 ChatGPT 聊天链接"/><button disabled={!ready||busy}>打开</button></form>
      {items.filter(item=>item.title.toLowerCase().includes(query.toLowerCase())).map(item=><button className="chatgpt-row" key={item.id} onClick={()=>go(item.id)}><Icon name="chat"/><span>{item.title}</span></button>)}
      {ready&&!items.length&&!busy&&<p>侧栏暂未读到聊天。请在电脑展开侧栏，或粘贴聊天链接。</p>}
      {ready&&<button disabled={busy} onClick={()=>void refresh(true)}>{busy?'正在读取…':'加载更多侧栏聊天'}</button>}
      <p className="chatgpt-help">使用扩展选定标签页的账号。搜索只筛选已加载的聊天。</p>
    </div>:<>
      <div className="chatgpt-messages" ref={scroll} onScroll={()=>{const element=scroll.current!;stick.current=element.scrollHeight-element.scrollTop-element.clientHeight<80;}}>
        {view?.messages.map((message:Json)=><article key={message.id} className={`chatgpt-message ${message.role}`}><small>{message.role==='user'?'你':'ChatGPT'}</small><div>{message.text}</div></article>)}
        {!view&&<p>{busy?'正在读取聊天…':'连接浏览器后读取聊天。'}</p>}
        {view?.running&&<p role="status">ChatGPT 正在生成…</p>}
      </div>
      <footer className="chatgpt-footer">
        {pending&&<div className="chatgpt-pending"><span>发送或停止结果待核实</span><button disabled={!connected||busy} onClick={()=>void check()}>核实回执</button><button disabled={busy} onClick={()=>{if(window.confirm('请先在聊天和电脑页面确认操作结果。解除提示不会重发消息。')){remember('');setError('');}}}>我已核实</button></div>}
        <form onSubmit={event=>{event.preventDefault();void mutate('chatgpt.send');}}><textarea aria-label="发送给 ChatGPT" placeholder="继续这个 ChatGPT 聊天…" value={draft} maxLength={50_000} onChange={event=>edit(event.target.value)} rows={3}/><div>{view?.running?<button type="button" disabled={!ready||busy||Boolean(pending)} onClick={()=>void mutate('chatgpt.stop')}>停止生成</button>:<button className="primary" disabled={!ready||!view||busy||Boolean(pending)||!draft.trim()}>发送</button>}</div></form>
        <small>{view?.notice||'使用电脑浏览器中的 ChatGPT，登录和草稿请在电脑处理。'}</small>
      </footer>
    </>}
  </main>;
}
