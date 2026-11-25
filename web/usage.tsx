import {useEffect,useMemo,useState} from 'react';
import type {Json} from '../src/shared/types';
import type {TeamCall} from './team';

type Row={day:string;userId:string|null;machineId:string;service:string;model:string;turns:number;inputTokens:number|null;cachedInputTokens:number|null;outputTokens:number|null;reasoningTokens:number|null};
type Report={rows:Row[];members:{id:string;name:string}[];machines:{id:string;name:string}[]};
type Totals={turns:number;input:number;cached:number;output:number;reasoning:number;known:boolean};
const RANGES:[number,string][]=[[1,'今天'],[7,'7 天'],[30,'30 天']];
const SERVICES:Record<string,string>={codex:'Codex',claude:'Claude Code',antigravity:'Antigravity'};
const LOCAL='电脑本机';

/** Token counts in the reader's units: in full below 10,000, then 万 and 亿. */
export function formatTokens(value:number|null|undefined){
  if(value===null||value===undefined)return '—';
  if(value<10_000)return value.toLocaleString('zh-CN');
  if(value<100_000_000)return `${(value/10_000).toFixed(value<100_000?1:0)}万`;
  return `${(value/100_000_000).toFixed(1)}亿`;
}
const dayKey=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
/** The local days of the range, oldest first, and the moment the first one starts. */
export function rangeDays(days:number,now=new Date()){
  const start=new Date(now.getFullYear(),now.getMonth(),now.getDate()-(days-1));
  return {since:start.getTime(),days:Array.from({length:days},(_,index)=>dayKey(new Date(start.getFullYear(),start.getMonth(),start.getDate()+index)))};
}
function add(totals:Totals,row:Row){
  totals.turns+=row.turns;
  if(row.inputTokens!==null||row.outputTokens!==null)totals.known=true;
  totals.input+=row.inputTokens||0;totals.cached+=row.cachedInputTokens||0;totals.output+=row.outputTokens||0;totals.reasoning+=row.reasoningTokens||0;
}
const blank=():Totals=>({turns:0,input:0,cached:0,output:0,reasoning:0,known:false});
/** Sums rows by a key, largest token use first. */
export function groupUsage(rows:Row[],key:(row:Row)=>string){
  const groups=new Map<string,Totals>();
  for(const row of rows){const name=key(row);const totals=groups.get(name)||blank();add(totals,row);groups.set(name,totals);}
  return [...groups].sort((a,b)=>b[1].input+b[1].output-(a[1].input+a[1].output)||b[1].turns-a[1].turns);
}
/** The report as CSV, with a byte-order mark so spreadsheet apps read the Chinese names. */
export function usageCsv(rows:Row[],member:(id:string|null)=>string,machine:(id:string)=>string){
  const cell=(value:unknown)=>{const text=value===null||value===undefined?'':String(value);return /[",\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
  const lines=[['日期','成员','电脑','应用','模型','轮次','输入 token','其中缓存','输出 token','其中推理'].join(',')];
  for(const row of rows)lines.push([row.day,member(row.userId),machine(row.machineId),SERVICES[row.service]||row.service,row.model,row.turns,row.inputTokens,row.cachedInputTokens,row.outputTokens,row.reasoningTokens].map(cell).join(','));
  return '﻿'+lines.join('\r\n')+'\r\n';
}

/** Tokens per day as columns; hovering or focusing a column shows its numbers. */
function DailyChart({days,totals}:{days:string[];totals:Map<string,Totals>}){
  const [active,setActive]=useState<number|null>(null);
  const values=days.map(day=>{const item=totals.get(day);return item?item.input+item.output:0;});
  const max=Math.max(...values,0);
  const tick=max?niceTick(max):0;
  const label=(day:string)=>`${Number(day.slice(5,7))}/${Number(day.slice(8))}`;
  const shown=active===null?null:{day:days[active],totals:totals.get(days[active])||blank()};
  return <figure className="usage-chart" onPointerLeave={()=>setActive(null)}>
    <figcaption>每天的 token（输入 + 输出）</figcaption>
    <div className="usage-plot">
      {tick>0&&<span className="usage-tick" style={{bottom:`${tick/Math.max(max,tick)*100}%`}}><i>{formatTokens(tick)}</i></span>}
      <div className="usage-columns" style={{gridTemplateColumns:`repeat(${days.length},minmax(0,1fr))`}}>
        {days.map((day,index)=><button type="button" key={day} className={`usage-column${active===index?' active':''}`} aria-label={`${label(day)}：${formatTokens(values[index])} token，${totals.get(day)?.turns||0} 轮`}
          onPointerEnter={()=>setActive(index)} onFocus={()=>setActive(index)} onBlur={()=>setActive(null)} onClick={()=>setActive(index)}>
          <span style={{height:max?`${values[index]/Math.max(max,tick)*100}%`:'0'}}/>
        </button>)}
      </div>
      {shown&&<div className="usage-tooltip" role="status" style={{left:`clamp(70px, ${(active!+.5)/days.length*100}%, calc(100% - 70px))`}}>
        <b>{formatTokens(shown.totals.input+shown.totals.output)}</b> token · <b>{shown.totals.turns}</b> 轮<small>{label(shown.day)}</small>
      </div>}
    </div>
    <div className="usage-axis"><span>{label(days[0])}</span><span>{label(days.at(-1)!)}</span></div>
  </figure>;
}
/** A round gridline value near the top of the data. */
function niceTick(max:number){const power=10**Math.floor(Math.log10(max));const step=[1,2,5,10].map(n=>n*power).find(n=>n>=max/1.2)||10*power;return step;}

function UsageTable({title,rows,first}:{title:string;rows:[string,Totals][];first:string}){
  if(!rows.length)return null;
  return <table className="usage-table"><caption>{title}</caption>
    <thead><tr><th scope="col">{first}</th><th scope="col">轮次</th><th scope="col">输入</th><th scope="col">输出</th></tr></thead>
    <tbody>{rows.map(([name,totals])=><tr key={name}><th scope="row">{name}</th><td>{totals.turns}</td><td>{totals.known?formatTokens(totals.input):'—'}</td><td>{totals.known?formatTokens(totals.output):'—'}</td></tr>)}</tbody>
  </table>;
}

/** Turns and tokens per day, member and app. Members see their own; admins everyone's, with a member filter. */
export function UsagePanel({team,admin}:{team:TeamCall;admin:boolean}){
  const [range,setRange]=useState(7),[member,setMember]=useState(''),[report,setReport]=useState<Report|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const {since,days}=useMemo(()=>rangeDays(range),[range]);
  useEffect(()=>{
    let alive=true;setBusy(true);setError('');
    team('team.usage',{since,offsetMinutes:-new Date().getTimezoneOffset(),...member?{userId:member}:{}})
      .then(result=>{if(alive)setReport(result as Report);},(failure:Json)=>{if(alive)setError(failure?.message||'读取用量失败');})
      .finally(()=>{if(alive)setBusy(false);});
    return()=>{alive=false;};
  },[since,member]);
  const names=new Map(report?.members.map(item=>[item.id,item.name])),machines=new Map(report?.machines.map(item=>[item.id,item.name]));
  const memberName=(id:string|null)=>id===null?LOCAL:names.get(id)||'（已移除）';
  const rows=report?.rows||[];
  const total=blank();for(const row of rows)add(total,row);
  const byDay=new Map(groupUsage(rows,row=>row.day));
  function exportCsv(){
    const blob=new Blob([usageCsv(rows,memberName,id=>machines.get(id)||id)],{type:'text/csv;charset=utf-8'});
    const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`用量-${days[0]}-${days.at(-1)}.csv`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }
  return <section className="team-section usage">
    <div className="usage-filters">
      <div className="usage-ranges" role="group" aria-label="时间范围">{RANGES.map(([value,label])=><button type="button" key={value} aria-pressed={range===value} className={range===value?'selected':''} onClick={()=>setRange(value)}>{label}</button>)}</div>
      {admin&&<select aria-label="成员" value={member} onChange={e=>setMember(e.target.value)}><option value="">全部成员</option>{report?.members.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}
    </div>
    {error&&<p className="error" role="alert">{error}</p>}
    {!report&&!error&&<div className="list-skeleton" role="status" aria-label="正在读取用量"><div/><div/><div/></div>}
    {report&&<div className={busy?'usage-body loading':'usage-body'}>
      <div className="usage-tiles">
        <div><small>轮次</small><b>{total.turns.toLocaleString('zh-CN')}</b></div>
        <div><small>输入 token</small><b>{total.known?formatTokens(total.input):'—'}</b>{total.known&&total.input>0&&<small>缓存 {Math.round(total.cached/total.input*100)}%</small>}</div>
        <div><small>输出 token</small><b>{total.known?formatTokens(total.output):'—'}</b></div>
      </div>
      {days.length>1&&rows.length>0&&<DailyChart days={days} totals={byDay}/>}
      {!rows.length&&<p className="muted">这段时间还没有记录。连接器更新后，新完成的每一轮会记在发起它的成员名下。</p>}
      {admin&&!member&&<UsageTable title="按成员" first="成员" rows={groupUsage(rows,row=>memberName(row.userId))}/>}
      {(report.machines.length>1||new Set(rows.map(row=>row.machineId)).size>1)&&<UsageTable title="按电脑" first="电脑" rows={groupUsage(rows,row=>machines.get(row.machineId)||row.machineId)}/>}
      <UsageTable title="按应用和模型" first="应用 · 模型" rows={groupUsage(rows,row=>`${SERVICES[row.service]||row.service}${row.model?` · ${row.model}`:''}`)}/>
      <p className="muted">输入含缓存命中；Antigravity 不提供 token 数，只计轮次。用订阅账号登录的电脑，额度由全员共用。</p>
      {rows.length>0&&<button type="button" className="text-button" onClick={exportCsv}>导出 CSV</button>}
    </div>}
  </section>;
}
