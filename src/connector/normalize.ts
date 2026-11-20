import {BridgeError,turnFinished,type Json,type SessionView,type MessageItem,type TurnView} from '../shared/types.js';
import {contextUsage} from './usage.js';

const bounded=(s:unknown)=>typeof s==='string'?(s.length>120_000?s.slice(0,120_000)+'\n\n[内容较长，剩余部分请在电脑查看]':s):'';
const contentText=(c:any):string=>Array.isArray(c)?c.map(x=>typeof x==='string'?x:x.text||'').filter(Boolean).join('\n'):bounded(c);
export function desktopTurns(state:Json):Json[] {
  const history=state.turnHistory?.history;
  if(state.turnHistory?.kind==='canonical'&&history?.entitiesByKey) {
    const keys=history.islands?.flatMap((island:Json)=>island.entries?.map((e:Json)=>e.value||e.key)||[])||[];
    return [...new Set<string>(keys)].map(k=>history.entitiesByKey[k]).filter(Boolean);
  }
  return state.turns||[];
}
export function turnPage(all:Json[],limit:number,before?:string):{turns:Json[];hasMore:boolean} {
  const end=before?all.findIndex(t=>(t.turnId||t.id)===before):all.length;
  if(end<0)throw new BridgeError('changed','历史位置已变化，请重新打开会话');
  return {turns:all.slice(Math.max(0,end-limit),end),hasMore:end>limit};
}
export function normalizeItem(item:Json):MessageItem {
  const result:MessageItem={id:item.id,type:item.type,role:'activity',text:''};
  switch(item.type) {
    case 'steeringUserMessage':
    case 'userMessage': result.role='user';result.text=contentText(item.content||item.input);result.images=(item.content||item.input||[]).filter((x:Json)=>x.type==='image'&&/^data:image\/(png|jpeg|webp|gif);base64,/.test(x.url||'')).map((x:Json)=>x.url);break;
    case 'agentMessage': result.role='assistant';result.text=bounded(item.text);break;
    case 'reasoning': result.text=contentText(item.summary);break;
    case 'plan': result.text=bounded(item.text)||contentText(item.plan?.map((p:Json)=>`${p.status}: ${p.step}`));break;
    case 'commandExecution': result.text=`${item.command||''}\n${item.status||''}${item.exitCode==null?'':` · 退出码 ${item.exitCode}`}\n${bounded(item.aggregatedOutput)}`;break;
    case 'fileChange': result.files=(item.changes||[]).map((c:Json)=>c.path);result.text=(item.changes||[]).map((c:Json)=>`${c.path}\n${bounded(c.diff)}`).join('\n');break;
    case 'mcpToolCall': result.text=`${item.server||''} / ${item.tool||''} · ${item.status||''}\n${item.error?.message||contentText(item.result?.content)}`;break;
    case 'webSearch': result.text=bounded(item.query);break;
    case 'contextCompaction': result.text='上下文已整理';break;
    default: result.text=bounded(item.text)||item.status||item.type;
  }
  result.text=bounded(result.text);return result;
}
function connectionError(info:unknown) {
  return info!=null&&typeof info==='object'&&['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts'].some(key=>Object.hasOwn(info,key));
}
export function codexRetryText(message:unknown,info:unknown,active=true) {
  const progress=typeof message==='string'?/^Reconnecting(?:\.\.\.|…)?\s+(\d+)\s*\/\s*(\d+)\b/i.exec(message.trim()):null;
  const action=progress||connectionError(info)?'重连':'重试';
  return `Codex ${active?'正在':'曾'}${action}${progress?` ${progress[1]}/${progress[2]}`:''}${active?'…':''}`;
}
/** One raw turn as the phone shows it. `index` only names turns that have no ID. */
export function normalizeTurn(t:Json,index=0):TurnView {
  const id=t.turnId||t.id;
  const items:MessageItem[]=[];
  const rawItems:Json[]=t.items||[];
  for(const [index,item] of rawItems.entries()) {
    if(item.type!=='error'){items.push(normalizeItem(item));continue;}
    if(item.willRetry!==true)continue;
    const retry={id:item.id,type:'retry',role:'status',text:codexRetryText(item.message,item.errorInfo,t.status==='inProgress'&&index===rawItems.length-1)};
    if(items.at(-1)?.type==='retry')items[items.length-1]={...retry,id:items.at(-1)!.id};
    else items.push(retry);
  }
  if(t.params?.input?.length&&!items.some(i=>i.role==='user'))items.unshift(normalizeItem({id:id+':input',type:'userMessage',content:t.params.input}));
  const error=t.error||rawItems.findLast(item=>item.type==='error'&&item.willRetry===false);
  const errorText=connectionError(error?.codexErrorInfo??error?.errorInfo)?'Codex 的连接中断，本轮未完成。':t.error?.message;
  return {id:id||`historical-${index}`,status:t.status,items,canFork:Boolean(id)&&turnFinished(t.status),diff:bounded(t.diff)||undefined,error:bounded(errorText)||undefined};
}
export function normalizeSession(raw:Json,source:SessionView['source'],requests:Json[],limit=20,before?:string):SessionView {
  const all=source==='desktop'?desktopTurns(raw):raw.turns||[];
  const active=all.filter((t:Json)=>t.status==='inProgress').at(-1);
  const page=turnPage(all,limit,before);
  const turns:TurnView[]=page.turns.map(normalizeTurn);
  const runtimeActive=raw.threadRuntimeStatus?.type==='active'||raw.status?.type==='active';
  const unresolvedActive=runtimeActive&&!active||Boolean(active&&!active.turnId&&!active.id);
  return {id:raw.id,sessionId:typeof raw.sessionId==='string'&&raw.sessionId?raw.sessionId:raw.id,title:raw.title||raw.name||raw.preview?.slice(0,80)||'新会话',cwd:raw.cwd||'',model:raw.latestModel||raw.model||'',provider:raw.modelProvider||'',effort:raw.latestReasoningEffort||raw.reasoningEffort||'',approvalPolicy:raw.approvalPolicy||raw.threadSettings?.approvalPolicy||'',source,
    serviceTier:raw.latestThreadSettings?.serviceTier!==undefined?raw.latestThreadSettings.serviceTier:raw.threadSettings?.serviceTier!==undefined?raw.threadSettings.serviceTier:raw.serviceTier,
    activeTurnId:active?.turnId||active?.id||null,running:Boolean(active||runtimeActive),contextUsage:contextUsage(raw.latestTokenUsageInfo),turns,requests:requests.filter(r=>!r.completed),canControl:source!=='history'&&!unresolvedActive,hasMore:page.hasMore,nextCursor:page.hasMore&&turns.length?{before:turns[0].id}:null,
    notice:unresolvedActive?'正在同步运行中的任务，暂不能操作':undefined};
}
