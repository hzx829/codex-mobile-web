import type { Json, SessionView, MessageItem, TurnView } from '../shared/types.js';

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
export function normalizeItem(item:Json):MessageItem {
  const result:MessageItem={id:item.id,type:item.type,role:'activity',text:''};
  switch(item.type) {
    case 'userMessage': result.role='user';result.text=contentText(item.content);result.images=(item.content||[]).filter((x:Json)=>x.type==='image'&&/^data:image\/(png|jpeg|webp|gif);base64,/.test(x.url||'')).map((x:Json)=>x.url);break;
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
export function normalizeSession(raw:Json,source:SessionView['source'],requests:Json[],limit=20):SessionView {
  const all=source==='desktop'?desktopTurns(raw):raw.turns||[];
  const active=all.filter((t:Json)=>t.status==='inProgress').at(-1);
  const turns:TurnView[]=all.slice(-limit).map((t:Json,index:number)=>{
    const id=t.turnId||t.id;
    const items:MessageItem[]=(t.items||[]).map(normalizeItem);
    if(t.params?.input?.length&&!items.some(i=>i.role==='user'))items.unshift(normalizeItem({id:id+':input',type:'userMessage',content:t.params.input}));
    return {id:id||`historical-${index}`,status:t.status,items,diff:bounded(t.diff)||undefined,error:t.error?.message};
  });
  const runtimeActive=raw.threadRuntimeStatus?.type==='active'||raw.status?.type==='active';
  const unresolvedActive=runtimeActive&&!active;
  return {id:raw.id,title:raw.title||raw.name||raw.preview?.slice(0,80)||'新会话',cwd:raw.cwd||'',model:raw.latestModel||raw.model||'',provider:raw.modelProvider||'',source,
    activeTurnId:active?.turnId||active?.id||null,turns,requests:requests.filter(r=>!r.completed),canControl:source!=='history'&&!unresolvedActive,hasMore:all.length>limit,
    notice:unresolvedActive?'正在同步运行中的任务，暂不能操作':undefined};
}
