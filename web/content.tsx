import {useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {Json} from '../src/shared/types';
export function SafeMarkdown({text,openFile}:{text:string;openFile:(path:string)=>void}){
  return <Markdown remarkPlugins={[remarkGfm]} components={{img:({alt})=><span className="muted">[图片：{alt||'请在电脑查看'}]</span>,a:({href,children})=>{
    if(!href)return <span>{children}</span>;
    if(/^https?:\/\//i.test(href))return <a href={href} target="_blank" rel="noreferrer noopener">{children} ↗</a>;
    if(/^[a-z]+:/i.test(href)&&!/^[a-z]:[\\/]/i.test(href))return <span>{children}</span>;
    return <button className="inline-link" onClick={()=>{try{openFile(decodeURIComponent(href).replace(/:\d+(?::\d+)?$/,''));}catch{openFile(href);}}}>{children}</button>;
  }}}>{text}</Markdown>;
}
export function RequestCard({request:r,disabled,respond}:{request:Json;disabled:boolean;respond:(response:Json)=>void}){
  const [answers,setAnswers]=useState<Json>({}),[scope,setScope]=useState('turn');
  const p=r.params||{},method=r.method;
  if(method==='item/tool/requestUserInput')return <div className="request"><strong>Codex 需要你补充信息</strong>{p.questions?.map((q:Json)=><label key={q.id}>{q.question}{q.options?.length>0&&<div className="choices">{q.options.map((o:Json)=><button type="button" disabled={disabled} className={answers[q.id]===o.label?'chosen':''} key={o.label} onClick={()=>setAnswers({...answers,[q.id]:o.label})} title={o.description}>{o.label}</button>)}</div>}<input type={q.isSecret?'password':'text'} value={answers[q.id]||''} onChange={e=>setAnswers({...answers,[q.id]:e.target.value})} placeholder="选择选项或输入回答"/></label>)}<button disabled={disabled||p.questions?.some((q:Json)=>!answers[q.id]?.trim())} onClick={()=>respond({answers:Object.fromEntries(p.questions.map((q:Json)=>[q.id,{answers:[answers[q.id]]}]))})}>提交回答</button></div>;
  if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval')return <div className="request"><strong>{method.includes('commandExecution')?'允许执行这条命令？':'允许修改文件？'}</strong><pre>{p.command||p.reason||'Codex 请求你的确认'}</pre><div className="choices">{(p.availableDecisions||['accept','acceptForSession','decline','cancel']).map((decision:any)=><button disabled={disabled} key={JSON.stringify(decision)} onClick={()=>respond({decision})}>{({accept:'允许一次',acceptForSession:'本会话允许',decline:'拒绝',cancel:'取消'} as Json)[String(decision)]||(decision.acceptWithExecpolicyAmendment?'允许并记住命令规则':decision.applyNetworkPolicyAmendment?'应用网络规则':'按此规则处理')}</button>)}</div></div>;
  if(method==='item/permissions/requestApproval')return <div className="request"><strong>Codex 请求额外权限</strong><p>{p.reason}</p><details><summary>查看请求范围</summary><pre>{JSON.stringify(p.permissions,null,2)}</pre></details><select value={scope} onChange={e=>setScope(e.target.value)}><option value="turn">仅本轮</option><option value="session">本会话</option></select><button disabled={disabled} onClick={()=>respond({allow:true,scope})}>允许请求范围</button><button disabled={disabled} onClick={()=>respond({allow:false,scope:'turn'})}>拒绝</button></div>;
  if(method==='mcpServer/elicitation/request'){
    const fields=Object.entries(p.requestedSchema?.properties||{}) as [string,Json][];
    const supported=p.mode!=='url'&&fields.every(([,f])=>['string','number','integer','boolean'].includes(f.type));
    const required=p.requestedSchema?.required||[];
    return <div className="request"><strong>{p.serverName} 需要回应</strong><p>{p.message}</p>{!supported?<p>这项表单或外部授权请在电脑端完成。</p>:<form onSubmit={e=>{e.preventDefault();const values:Json={};for(const [key,f]of fields){const value=answers[key];if(value!==undefined&&value!=='')values[key]=f.type==='number'||f.type==='integer'?Number(value):value;}respond({action:'accept',content:values});}}>{fields.map(([key,f])=><label key={key}>{f.title||key}{required.includes(key)?' *':''}{f.type==='boolean'?<select value={String(answers[key]??'')} required={required.includes(key)} onChange={e=>setAnswers({...answers,[key]:e.target.value==='true'})}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>:f.enum?<select required={required.includes(key)} value={answers[key]||''} onChange={e=>setAnswers({...answers,[key]:e.target.value})}><option value="">请选择</option>{f.enum.map((v:any)=><option key={v} value={v}>{v}</option>)}</select>:<input type={f.type==='string'?'text':'number'} step={f.type==='integer'?1:'any'} required={required.includes(key)} value={answers[key]??''} onChange={e=>setAnswers({...answers,[key]:e.target.value})}/>}<small>{f.description}</small></label>)}<button disabled={disabled}>提交</button></form>}<button disabled={disabled} onClick={()=>respond({action:'decline'})}>拒绝</button><button disabled={disabled} onClick={()=>respond({action:'cancel'})}>取消</button></div>;
  }
  return <div className="request">电脑有一项待处理请求，请在 Codex 桌面完成。<small>{method}</small></div>;
}
