import type {Json} from '../src/shared/types';

type SavedThread={id:string;title:string;cwd:string;updatedAt:number;archived:boolean};
export type ThreadPreference={pinned?:boolean;unread?:boolean;section?:string;thread?:SavedThread};
export type ThreadPreferences=Record<string,ThreadPreference>;
export function saveThread(thread:Json,archived:boolean):SavedThread {
  return {id:thread.id,title:thread.title,cwd:thread.cwd||'',updatedAt:thread.updatedAt||0,archived};
}
// Keep locally organized threads visible even when they leave the most recent page.
export function visibleThreads(threads:Json[],preferences:ThreadPreferences,project:string,archived:boolean,search:string):Json[] {
  const ids=new Set(threads.map(t=>t.id));
  const saved=Object.values(preferences).filter(p=>p.pinned||p.section).map(p=>p.thread).filter((t):t is SavedThread=>Boolean(t));
  return [...threads,...saved.filter(t=>!ids.has(t.id)&&t.archived===archived&&(!project||t.cwd===project)&&(!search||t.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())))];
}
export function rememberThreads(preferences:ThreadPreferences,threads:Json[],archived:boolean):ThreadPreferences {
  let next=preferences;
  for(const thread of threads){
    const p=preferences[thread.id];if(!p||!p.pinned&&!p.section)continue;
    const saved=saveThread(thread,archived);
    if(JSON.stringify(p.thread)===JSON.stringify(saved))continue;
    if(next===preferences)next={...preferences};
    next[thread.id]={...p,thread:saved};
  }
  return next;
}
export function groupThreads(threads:Json[],preferences:ThreadPreferences,fallback:string){
  const groups=new Map<string,{label:string;threads:Json[]}>();
  for(const thread of threads){
    const p=preferences[thread.id]||{},key=p.pinned?'pinned':p.section?`section:${p.section}`:'recent';
    if(!groups.has(key))groups.set(key,{label:p.pinned?'置顶':p.section||fallback,threads:[]});
    groups.get(key)!.threads.push(thread);
  }
  return [...groups].sort(([a],[b])=>a==='pinned'?-1:b==='pinned'?1:a==='recent'?1:b==='recent'?-1:0).map(([key,group])=>({key,...group}));
}
