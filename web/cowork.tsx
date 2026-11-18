import {useEffect,useState} from 'react';
import {coworkThreadUrl} from '../src/shared/cowork';
import type {Json,RequestAction} from '../src/shared/types';
import {ThreadHeader} from './chat-layout';
import {IconButton} from './icon-button';
import {useStableEvent} from './use-event';

type CoworkView={title:string;messages:{id:string;role:'user'|'assistant';text:string}[]};
type Props={id:string;inert:boolean;machineName:string;connected:boolean;back:()=>void;call:(action:RequestAction,payload?:Json)=>Promise<CoworkView>};

export function CoworkPanel({id,inert,machineName,connected,back,call}:Props){
  const [view,setView]=useState<CoworkView|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,refresh]=useState(0);
  const read=useStableEvent(()=>call('cowork.read',{conversationId:id}));
  useEffect(()=>{
    if(!connected){setLoading(false);return;}
    let active=true;
    setLoading(true);setError('');
    void read().then(value=>{if(active)setView(value);},error=>{if(active)setError(error?.message||'读取 Cowork 会话失败');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[connected,id,read,revision]);
  const url=coworkThreadUrl(id);
  return <main className="thread-panel" inert={inert}>
    <ThreadHeader title={view?.title||'Cowork 会话'} project="Cowork" machineName={machineName} connected={connected} back={back}>
      <IconButton icon="refresh" label="刷新会话" disabled={!connected||loading} onClick={()=>refresh(value=>value+1)}/>
    </ThreadHeader>
    <div className="timeline"><div className="timeline-content">
      {loading&&!view&&<p className="muted" role="status">正在读取 Cowork 会话…</p>}
      {!connected&&<p className="muted" role="status">电脑离线，连接后可刷新会话。</p>}
      {error&&<p className="error" role="alert">{error}</p>}
      {view?.messages.map(message=><article key={message.id} className={`message ${message.role}`}><small>{message.role==='user'?'你':'Claude'}</small><div className="cowork-message">{message.text}</div></article>)}
    </div></div>
    <footer className="composer-area">
      {url&&<a href={url} target="_blank" rel="noreferrer">在 Claude 中打开</a>}
      {view&&<small>显示网页已载入的文字。续聊和附件在 Claude 中查看。</small>}
    </footer>
  </main>;
}
