import {useEffect,useState} from 'react';
import {Popover,type MenuPoint} from './popover';
import {Icon} from './icons';
import type {ContextUsage,SessionView,ThreadStatus,UsageLimit} from '../src/shared/types';

export function remainingPercent(used:number,total=100){return Math.max(0,Math.min(100,Math.round((1-used/total)*100)));}
const number=(value:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:1}).format(value);
const tokens=(value:number)=>value>=10_000?`${number(value/10_000)}万`:number(value);
export function contextSummary(usage:ContextUsage|null|undefined){
  if(!usage)return '运行端暂未提供上下文用量';
  if(!usage.windowTokens)return `已用 ${tokens(usage.usedTokens)} tokens（上限暂不可用）`;
  return `剩余 ${remainingPercent(usage.usedTokens,usage.windowTokens)}%（已用 ${tokens(usage.usedTokens)} / ${tokens(usage.windowTokens)}）`;
}
export function limitLabel(limit:UsageLimit){
  const minutes=limit.windowMinutes;
  const period=minutes==null?'额度':minutes%1440===0?`${number(minutes/1440)} 天`:minutes%60===0?`${number(minutes/60)} 小时`:`${number(minutes)} 分钟`;
  return `${limit.name?`${limit.name} · `:''}${period}限制`;
}
export function ContextIndicator({usage}:{usage:ContextUsage|null|undefined}){
  const used=usage?.windowTokens?100-remainingPercent(usage.usedTokens,usage.windowTokens):null;
  return <svg className="context-indicator" width="23" height="23" viewBox="0 0 24 24" aria-hidden="true"><circle className="context-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.5"/>{used!==null?<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" pathLength="100" strokeDasharray={`${used} 100`} transform="rotate(-90 12 12)" strokeLinecap="round"/>:<circle cx="12" cy="12" r="1.5" fill="currentColor"/>}</svg>;
}
export function StatusDetails({view,threadId,cwd,connected,status,loading,error,copy}:{view:SessionView|null;threadId:string;cwd:string;connected:boolean;status:ThreadStatus|null;loading:boolean;error:string;copy:()=>void}){
  return <>
    <p className="thread-status-connection">{!connected?'连接已断开':!view?'正在同步会话':view.source==='history'?'历史会话 · 只读':'远程会话已连接'}</p>
    {!connected&&view&&<p className="muted">以下为上次接收的状态。</p>}
    <dl className="thread-status-details">
      <dt>对话线程<button type="button" className="icon-button" aria-label="复制对话线程 ID" onClick={copy}><Icon name="copy" size={21}/></button></dt>
      <dd><input className="status-thread-id" aria-label="对话线程 ID" readOnly value={threadId} onFocus={e=>e.target.select()}/></dd>
      <dt>目录</dt><dd className="status-directory">{cwd||'暂不可用'}</dd>
      <dt>上下文</dt><dd>{contextSummary(view?.contextUsage)}</dd>
      {status?.limits.map(limit=>{
        const reset=limit.resetsAt?new Date(limit.resetsAt*1000):null,valid=reset&&!Number.isNaN(reset.getTime()),expired=valid&&reset.getTime()<=Date.now();
        return <div className="status-limit" key={limit.id}><dt>{limitLabel(limit)}</dt><dd>{expired?'已到重置时间，等待更新':`剩余 ${remainingPercent(limit.usedPercent)}%`}{valid&&!expired&&<>（将于 {new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(reset)} 重置）</>}</dd></div>;
      })}
      {!status?.limits.length&&<><dt>账号额度</dt><dd>{!connected?'连接后获取额度':loading?'正在读取…':error||status?.limitsNotice||'运行端暂未提供额度信息'}</dd></>}
    </dl>
  </>;
}
export function ThreadStatusPanel({point,view,threadId,cwd,connected,close,copy,read}:{point:MenuPoint;view:SessionView|null;threadId:string;cwd:string;connected:boolean;close:()=>void;copy:()=>Promise<void>;read:()=>Promise<ThreadStatus>}){
  const [status,setStatus]=useState<ThreadStatus|null>(null),[loading,setLoading]=useState(connected),[error,setError]=useState(''),[copied,setCopied]=useState('');
  useEffect(()=>{
    if(!connected){setLoading(false);return;}
    let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
    const refresh=async()=>{
      setLoading(true);
      try{const result=await read();if(alive&&result.threadId===threadId){setStatus(result);setError('');}}
      catch{if(alive){setStatus(null);setError('额度读取失败，请重新打开状态面板');}}
      finally{if(alive){setLoading(false);timer=setTimeout(()=>void refresh(),30_000);}}
    };
    void refresh();return()=>{alive=false;clearTimeout(timer);};
  },[threadId,connected]);
  return <Popover point={point} title="状态" label="会话状态" className="thread-status" close={close}>
    <StatusDetails view={view} threadId={threadId} cwd={cwd} connected={connected} status={status} loading={loading} error={error} copy={()=>{void copy().then(()=>setCopied('对话线程 ID 已复制')).catch(()=>setCopied('复制失败，可选择上方 ID 手动复制。'));}}/>
    {copied&&<p className="muted" role="status">{copied}</p>}
  </Popover>;
}
