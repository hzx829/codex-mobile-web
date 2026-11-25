import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {ChatSearch,HomeHeader,workspaceName} from './chat-layout';
import {IconButton} from './icon-button';
import {relativeTime,ThreadMenu,ThreadRow} from './thread-menu';
import {groupThreads,rememberThreads,visibleThreads,type ThreadPreference,type ThreadPreferences} from './thread-preferences';
import type {MenuPoint} from './popover';
import {SessionListLoader} from './session-list-loader';
import {cachedList,listKey,rememberList} from './session-cache';
import {useStableEvent} from './use-event';
import {isTeamAdmin,mergeMembers,OwnerFilterControl,ownerFilterLabel,type OwnerFilter,type TeamMemberRef,type TeamUser} from './team';
import {loadExpandedProjects,ProjectTree,saveExpandedProjects,type ProjectItem,type ProjectThreadsState} from './project-tree';
import {projectPathKey} from '../src/shared/project-paths';
import type {Json,RequestAction} from '../src/shared/types';

type Project={id:string;path:string;name?:string;projectId?:string;owner?:{id:string;name:string}|null};
type Thread={id:string;title:string;updatedAt:number;running:boolean;cwd?:string;owner?:{id:string;name:string}|null};
type ProjectPage={items:Thread[];offset:number;hasMore:boolean;loading:boolean;error:string};

/** Session actions an app supports beyond pinning and copying the ID, which every app gets. */
export type ThreadActions={rename?:(name:string)=>Promise<void>;archive?:()=>Promise<void>;duplicate?:()=>Promise<void>};
function loadPreferences(key:string):ThreadPreferences{try{return JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{return {};}}
function savePreferences(key:string,values:ThreadPreferences){try{localStorage.setItem(key,JSON.stringify(values));}catch{}}
type Page={data:Thread[];hasMore:boolean;projects?:Project[];notice?:string};

type Props={
  service:'antigravity'|'claude';
  /** List action and wording of the app this sidebar shows; defaults to Antigravity. */
  listAction?:RequestAction;appName?:string;
  /** Starts a new conversation, optionally scoped to a specific project (its list id). */
  onNew?:(project:string)=>void;
  /** Opens the unified project creation dialog when the connector supports `projects.create`. */
  onCreateProject?:()=>void;
  onEditProject?:(project:ProjectItem)=>void;
  onClaudeSettings?:(project:ProjectItem)=>void;
  onRemoveProject?:(project:ProjectItem)=>Promise<void>;
  canManageProjects?:boolean;
  autoExpandKey?:string;
  selected:string;machine:string;machineName:string;connected:boolean;relayOnline:boolean;inert:boolean;revision:number;
  switcher:ReactNode;footer:ReactNode;mobileSettings?:ReactNode;
  projectsCollapsed?:boolean;onToggleProjects?:()=>void;
  me?:TeamUser|null;roster?:TeamMemberRef[];ownerFilter?:OwnerFilter;onOwnerFilterChange?:(next:OwnerFilter)=>void;
  claimOwner?:(threadId:string,userId:string|null)=>Promise<void>;
  copyText:(text:string)=>Promise<void>;threadActions?:(thread:Json)=>ThreadActions;
  /** Narrows the shown sessions, such as to those the signed-in team member started. */
  filter?:(threads:Json[])=>Json[];
  call:(action:RequestAction,payload?:Json)=>Promise<any>;open:(id:string)=>void;chooseComputer:()=>void;
};

export function AntigravitySidebar({
  service,listAction='antigravity.list',appName='Antigravity',filter,
  projectsCollapsed=false,onToggleProjects,me=null,roster=[],ownerFilter='all',onOwnerFilterChange,claimOwner,
  onNew,onCreateProject,onEditProject,onClaudeSettings,onRemoveProject,canManageProjects=false,autoExpandKey='',
  selected,machine,machineName,connected,relayOnline,inert,revision,switcher,footer,mobileSettings,
  copyText,threadActions,call,open,chooseComputer,
}:Props){
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[projects,setProjects]=useState<Project[]>([]);
  const [page,setPage]=useState<{key:string;items:Thread[];offset:number;hasMore:boolean}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const loader=useRef(new SessionListLoader());

  // Expanded project keys persist per app and computer; null means first visit (auto-expand first project).
  const [expandedList,setExpandedList]=useState<string[]|null>(()=>loadExpandedProjects(service,machine));
  const [projectPages,setProjectPages]=useState<Record<string,ProjectPage>>({});
  const projectReqSeq=useRef<Record<string,number>>({});

  // Pins live in this browser, per app and computer, as Codex's do.
  const storage=`${listAction.split('.')[0]}-preferences:${machine}`;
  const [preferenceState,setPreferences]=useState(()=>({key:storage,values:loadPreferences(storage)}));
  const preferences=preferenceState.key===storage?preferenceState.values:loadPreferences(storage);
  const [menu,setMenu]=useState<{thread:Json;point:MenuPoint}|null>(null);

  function changePreference(id:string,patch:ThreadPreference,thread:Json){
    const values=rememberThreads({...preferences,[id]:{...preferences[id],...patch}},[thread],false);
    savePreferences(storage,values);setPreferences({key:storage,values});
  }

  function markAllRead(threadIds:string[]){
    let changed=false;
    const next={...preferences};
    for(const id of threadIds){
      if(next[id]?.unread){
        next[id]={...next[id],unread:false};
        changed=true;
      }
    }
    if(changed){savePreferences(storage,next);setPreferences({key:storage,values:next});}
  }

  const key=JSON.stringify([query]),current=page?.key===key?page:null;
  // The last list read on this computer shows until the fresh one arrives; searches are not kept.
  const listCache=listKey(listAction,machine,''),projectsCache=listKey(listAction,machine,'*projects');
  const items=current?.items||(query?null:cachedList(listCache) as Thread[]|null)||[];
  const matching=query?items.filter(item=>item.title.toLowerCase().includes(query.toLowerCase())):items;
  const shown=visibleThreads(matching,preferences,'',false,query) as Thread[];
  const visible=filter?filter(shown) as Thread[]:shown;

  const shownProjects=projects.length?projects:cachedList(projectsCache) as Project[]|null||[];
  const projectItems=useMemo<ProjectItem[]>(()=>shownProjects.map(item=>({
    key:projectPathKey(item.path)||item.id,
    id:item.id,
    projectId:item.projectId,
    path:item.path,
    name:item.name||workspaceName(item.path),
    owner:item.owner,
  })),[shownProjects]);

  const effectiveExpanded=useMemo(()=>{
    if(expandedList!==null)return new Set(expandedList);
    return projectItems[0]?new Set([projectItems[0].key]):new Set<string>();
  },[expandedList,projectItems]);

  const allLoadedThreads=useMemo(()=>{
    const extra=Object.values(projectPages).flatMap(entry=>entry.items);
    return [...items,...extra];
  },[items,projectPages]);
  const members=useMemo(()=>mergeMembers(roster,allLoadedThreads),[roster,allLoadedThreads]);
  const ownerFiltered=Boolean(me&&ownerFilter!=='all');

  const loadProject=useStableEvent((project:ProjectItem,more=false)=>{
    if(!connected)return;
    const prev=projectPages[project.key];
    const offset=more?prev?.offset||0:0;
    const seq=(projectReqSeq.current[project.key]||0)+1;
    projectReqSeq.current[project.key]=seq;
    const cache=listKey(listAction,machine,project.id||project.path);
    setProjectPages(old=>{
      const existing=old[project.key];
      const seed=existing?.items?.length?existing.items:(cachedList(cache) as Thread[]|null)||[];
      return {...old,[project.key]:{items:seed,offset:existing?.offset||0,hasMore:existing?.hasMore||false,loading:true,error:''}};
    });
    void call(listAction,{project:project.id||project.path,offset}).then((result:Page)=>{
      if(projectReqSeq.current[project.key]!==seq)return;
      if(!offset)rememberList(cache,result.data);
      setPreferences(old=>{
        const base=old.key===storage?old.values:loadPreferences(storage);
        const values=rememberThreads(base,result.data,false);
        if(values!==base)savePreferences(storage,values);
        return {key:storage,values};
      });
      setProjectPages(old=>{
        const prior=offset?old[project.key]?.items||[]:[];
        const merged=offset?[...new Map([...prior,...result.data].map(item=>[item.id,item])).values()]:result.data;
        return {...old,[project.key]:{items:merged,offset:offset+result.data.length,hasMore:Boolean(result.hasMore),loading:false,error:''}};
      });
    }).catch((failure:any)=>{
      if(projectReqSeq.current[project.key]!==seq)return;
      setProjectPages(old=>{
        const existing=old[project.key];
        return {...old,[project.key]:{items:existing?.items||[],offset:existing?.offset||0,hasMore:existing?.hasMore||false,loading:false,error:failure?.message||'读取项目会话失败'}};
      });
    });
  });

  const refreshExpanded=useStableEvent(()=>{
    if(!connected)return;
    for(const item of projectItems){
      if(effectiveExpanded.has(item.key))loadProject(item,false);
    }
  });

  const load=useStableEvent((more=false)=>{
    if(!connected)return;
    const offset=more?current?.offset||0:0;
    void loader.current.load(key,():Promise<Page>=>call(listAction,{project:'',search:query,offset}),{
      start:()=>{setBusy(true);setError('');setNotice('');},
      result:result=>{
        if(result.projects){setProjects(result.projects);rememberList(projectsCache,result.projects);}
        if(!offset&&!query)rememberList(listCache,result.data);
        setPreferences(old=>{const base=old.key===storage?old.values:loadPreferences(storage),values=rememberThreads(base,result.data,false);if(values!==base)savePreferences(storage,values);return {key:storage,values};});
        setNotice(result.notice||'');
        setPage({key,items:offset?[...new Map([...items,...result.data].map(item=>[item.id,item])).values()]:result.data,
          offset:offset+result.data.length,hasMore:result.hasMore});
      },
      error:failure=>setError((failure as {message?:string})?.message||'读取会话失败'),
      finish:()=>setBusy(false),
    });
  });

  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    if(connected){load();refreshExpanded();}else setBusy(false);
    const activeLoader=loader.current;
    return()=>activeLoader.invalidate();
  },[connected,key,revision,load]);

  // Load any expanded projects once the project list arrives.
  const loadedExpandedFor=useRef(new Set<string>());
  useEffect(()=>{
    if(!connected)return;
    for(const item of projectItems){
      if(effectiveExpanded.has(item.key)&&!loadedExpandedFor.current.has(item.key)){
        loadedExpandedFor.current.add(item.key);
        loadProject(item,false);
      }
    }
  },[connected,projectItems,effectiveExpanded,loadProject]);

  // Auto-expand a freshly created project.
  useEffect(()=>{
    if(!autoExpandKey)return;
    const target=projectItems.find(item=>item.key===autoExpandKey||item.id===autoExpandKey);
    if(!target)return;
    setExpandedList(old=>{
      const base=old??[...effectiveExpanded];
      if(base.includes(target.key))return base;
      const next=[...base,target.key];
      saveExpandedProjects(service,machine,next);
      return next;
    });
    if(connected){
      loadedExpandedFor.current.add(target.key);
      loadProject(target,false);
    }
  },[autoExpandKey,projectItems,service,machine,connected,loadProject]);

  function toggleExpand(project:ProjectItem){
    const opening=!effectiveExpanded.has(project.key);
    setExpandedList(old=>{
      const base=old??[...effectiveExpanded];
      const next=opening?[...new Set([...base,project.key])]:base.filter(k=>k!==project.key);
      saveExpandedProjects(service,machine,next);
      return next;
    });
    if(opening&&connected){
      loadedExpandedFor.current.add(project.key);
      loadProject(project,false);
    }
  }

  const projectThreadsMap=useMemo<Record<string,ProjectThreadsState>>(()=>{
    const map:Record<string,ProjectThreadsState>={};
    for(const item of projectItems){
      if(!effectiveExpanded.has(item.key))continue;
      const entry=projectPages[item.key];
      const cache=listKey(listAction,machine,item.id||item.path);
      const rawItems=entry?.items?.length?entry.items
        :(cachedList(cache) as Thread[]|null)
        ||(service==='claude'?items.filter(t=>t.cwd&&projectPathKey(t.cwd)===item.key):[]);
      const merged=visibleThreads(rawItems,preferences,item.path,false,'') as Thread[];
      const filtered=(filter?filter(merged):merged) as Thread[];
      map[item.key]={
        items:filtered.map(t=>({...t,status:t.running?{type:'active'}:undefined})),
        loading:Boolean(entry?.loading),
        hasMore:Boolean(entry?.hasMore),
        error:entry?.error||'',
      };
    }
    return map;
  },[projectItems,effectiveExpanded,projectPages,listAction,machine,service,items,preferences,filter]);

  const refreshAll=()=>{load();refreshExpanded();};
  const heading=query?'搜索结果':'最近';
  const groups=groupThreads(visible,preferences,heading);
  const filterControl=me&&onOwnerFilterChange?<OwnerFilterControl me={me} value={ownerFilter} members={members} change={onOwnerFilterChange}/>:null;
  const showProjectsTree=!query&&(projectItems.length>0||Boolean(onCreateProject));

  return <aside className="home-panel" inert={inert}>
    <HomeHeader machineName={machineName} connected={connected} relayOnline={relayOnline}
      chooseComputer={chooseComputer} mobileSettings={mobileSettings} onRefresh={refreshAll}/>
    {!query&&switcher}
    <div className="home-content">
      {showProjectsTree&&<ProjectTree
        service={service}
        machine={machine}
        projects={projectItems}
        expandedKeys={effectiveExpanded}
        onToggleExpand={toggleExpand}
        projectThreads={projectThreadsMap}
        onLoadMore={project=>loadProject(project,true)}
        selectedThread={selected}
        threadPreferences={preferences}
        isThreadActive={thread=>Boolean(thread.running||thread.status?.type==='active')}
        onOpenThread={thread=>open(thread.id)}
        onThreadMenu={(thread,point)=>setMenu({thread,point})}
        onNewChat={onNew?project=>onNew(project.id||project.path):undefined}
        onCreateProject={onCreateProject}
        onEditProject={onEditProject}
        onClaudeSettings={service==='claude'?onClaudeSettings:undefined}
        onRemoveProject={onRemoveProject}
        onMarkAllRead={(_project,ids)=>markAllRead(ids)}
        onCopyPath={copyText}
        projectsCollapsed={projectsCollapsed}
        onToggleProjects={()=>onToggleProjects?.()}
        connected={connected}
        canManageProjects={canManageProjects}
        ownerFiltered={ownerFiltered}
      />}

      <section className="recent-section">
        {!groups.length&&(filterControl?<div className="section-head"><h2>{heading}</h2>{filterControl}</div>:<h2>{heading}</h2>)}
        {groups.map((group,index)=><div className="thread-group" key={group.key}>{index===0&&filterControl?<div className="section-head"><h2>{group.label}</h2>{filterControl}</div>:<h2>{group.label}</h2>}<nav aria-label={group.label}>{group.threads.map(item=>{
          const thread={...item,status:item.running?{type:'active'}:undefined};
          return <ThreadRow key={item.id} thread={thread} selected={selected===item.id} preference={preferences[item.id]}
            time={relativeTime(item.updatedAt)} open={()=>open(item.id)} menu={point=>setMenu({thread,point})}/>;})}</nav></div>)}
        {busy&&!visible.length?<div className="list-skeleton" role="status" aria-label="正在读取会话"><div/><div/><div/></div>:
          !visible.length&&!error&&<p className="empty-list">{!connected?'连接电脑后，会话会出现在这里。':ownerFiltered?<>当前仅显示「{ownerFilterLabel(ownerFilter,me,members)}」的会话，已加载列表中没有匹配项。{onOwnerFilterChange&&<button type="button" className="empty-list-action" onClick={()=>onOwnerFilterChange('all')}>显示全部</button>}</>:query?'没有找到匹配的会话。':`还没有 ${appName} 会话。`}</p>}
        {error&&<p className="error" role="alert">{error} {connected&&<button type="button" onClick={refreshAll}>重试</button>}</p>}
        {notice&&<p className="muted">{notice}</p>}
        {current?.hasMore&&<button className="more-link" disabled={!connected||busy} onClick={()=>load(true)}>{busy?'正在加载…':'加载更多'}</button>}
      </section>
    </div>
    {menu&&<ThreadMenu key={menu.thread.id} thread={menu.thread} point={menu.point} preference={preferences[menu.thread.id]||{}} sections={[]} archived={false} compact connected={connected}
      teamMode={Boolean(me)} claim={isTeamAdmin(me)&&claimOwner?{members,assign:async userId=>{await claimOwner(menu.thread.id,userId);refreshAll();}}:undefined}
      close={()=>setMenu(null)} change={patch=>changePreference(menu.thread.id,patch,menu.thread)} copy={()=>copyText(menu.thread.id)}
      {...afterEach(threadActions?.(menu.thread)||{},refreshAll)}/>}
    <div className="home-bottom"><div className="home-dock"><ChatSearch value={search} change={setSearch}/>{onNew&&<IconButton icon="compose" label="新聊天" className="round black new-chat" onClick={()=>onNew('')}/>}</div></div>
    {footer}
  </aside>;
}

/** Refreshes the list after each action that changes a session. */
function afterEach(actions:ThreadActions,refresh:()=>void):ThreadActions{
  const wrap=<A extends unknown[]>(run?:(...args:A)=>Promise<void>)=>run&&(async(...args:A)=>{try{await run(...args);}finally{refresh();}});
  return {rename:wrap(actions.rename),archive:wrap(actions.archive),duplicate:wrap(actions.duplicate)};
}
