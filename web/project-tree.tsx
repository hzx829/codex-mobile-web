import {useMemo,useState} from 'react';
import {operationId} from './client';
import {ProjectsSection,workspaceName} from './chat-layout';
import {Icon,type IconName} from './icons';
import {Popover,type MenuPoint} from './popover';
import {OwnerBadge,type TeamMemberRef} from './team';
import {relativeTime,ThreadRow} from './thread-menu';
import type {ThreadPreferences} from './thread-preferences';
import type {BridgeService,Json,RequestAction} from '../src/shared/types';

export type ProjectItem={
  /** Stable lookup key (normalized path or service id). */
  key:string;
  /** Service-specific identifier (Codex UUID, Antigravity URI, Claude path). */
  id?:string;
  /** Desktop project UUID when different from `id`. */
  projectId?:string;
  path:string;
  name:string;
  roots?:string[];
  owner?:TeamMemberRef|null;
};

export type ProjectThreadsState={
  items:Json[];
  loading:boolean;
  hasMore:boolean;
  error:string;
};

export type ProjectPreference={pinned?:boolean;section?:string};
export type ProjectPreferences=Record<string,ProjectPreference>;

const INITIAL_THREAD_LIMIT=5;

function loadJson<T>(key:string,fallback:T):T{
  try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}
}
function saveJson(key:string,value:unknown){
  try{localStorage.setItem(key,JSON.stringify(value));}catch{}
}

export function loadExpandedProjects(service:BridgeService,machine:string):string[]|null{
  try{
    const raw=localStorage.getItem(`expanded-projects:${service}:${machine}`);
    if(raw===null)return null;
    const parsed=JSON.parse(raw);
    return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[];
  }catch{return null;}
}
export function saveExpandedProjects(service:BridgeService,machine:string,keys:readonly string[]){
  saveJson(`expanded-projects:${service}:${machine}`,keys);
}

type ProjectTreeProps={
  service:BridgeService;
  machine:string;
  projects:ProjectItem[];
  expandedKeys:ReadonlySet<string>;
  onToggleExpand:(project:ProjectItem)=>void;
  projectThreads:Record<string,ProjectThreadsState>;
  onLoadMore:(project:ProjectItem)=>void;
  selectedThread:string;
  threadPreferences:ThreadPreferences;
  isThreadActive:(thread:Json)=>boolean;
  onOpenThread:(thread:Json)=>void;
  onThreadMenu:(thread:Json,point:MenuPoint)=>void;
  onNewChat?:(project:ProjectItem)=>void;
  onCreateProject?:()=>void;
  headerAction?:React.ReactNode;
  onEditProject?:(project:ProjectItem)=>void;
  onClaudeSettings?:(project:ProjectItem)=>void;
  onRemoveProject?:(project:ProjectItem)=>Promise<void>;
  onMarkAllRead?:(project:ProjectItem,threadIds:string[])=>void;
  onCopyPath:(path:string)=>Promise<void>;
  projectsCollapsed:boolean;
  onToggleProjects:()=>void;
  connected:boolean;
  busy?:boolean;
  canManageProjects?:boolean;
  ownerFiltered?:boolean;
};

export function ProjectTree({
  service,machine,projects,expandedKeys,onToggleExpand,projectThreads,onLoadMore,
  selectedThread,threadPreferences,isThreadActive,onOpenThread,onThreadMenu,
  onNewChat,onCreateProject,headerAction,onEditProject,onClaudeSettings,onRemoveProject,onMarkAllRead,onCopyPath,
  projectsCollapsed,onToggleProjects,connected,busy=false,canManageProjects=false,ownerFiltered=false,
}:ProjectTreeProps){
  const prefKey=`project-prefs:${service}:${machine}`;
  const sectionKey=`project-sections-collapsed:${service}:${machine}`;
  const [prefState,setPrefState]=useState<{key:string;values:ProjectPreferences}>(()=>({key:prefKey,values:loadJson(prefKey,{})}));
  const prefs=prefState.key===prefKey?prefState.values:loadJson<ProjectPreferences>(prefKey,{});
  const [collapsedState,setCollapsedState]=useState<{key:string;names:string[]}>(()=>({key:sectionKey,names:loadJson(sectionKey,[])}));
  const collapsedSections=useMemo(()=>new Set(collapsedState.key===sectionKey?collapsedState.names:loadJson<string[]>(sectionKey,[])),[collapsedState,sectionKey]);
  const [showAllMap,setShowAllMap]=useState<Record<string,boolean>>({});
  const [menu,setMenu]=useState<{project:ProjectItem;point:MenuPoint}|null>(null);
  const [sectionMenu,setSectionMenu]=useState<MenuPoint|null>(null);

  function updatePref(projectKey:string,patch:ProjectPreference){
    const current=prefs[projectKey]||{};
    const merged:ProjectPreference={...current,...patch};
    if(!merged.pinned)delete merged.pinned;
    if(!merged.section)delete merged.section;
    const next={...prefs};
    if(merged.pinned||merged.section)next[projectKey]=merged;
    else delete next[projectKey];
    saveJson(prefKey,next);
    setPrefState({key:prefKey,values:next});
  }

  function toggleSection(name:string){
    const next=new Set(collapsedSections);
    if(next.has(name))next.delete(name);
    else next.add(name);
    const list=[...next];
    saveJson(sectionKey,list);
    setCollapsedState({key:sectionKey,names:list});
  }

  const allSections=useMemo(()=>{
    const names=new Set<string>();
    for(const item of projects){
      const sec=prefs[item.key]?.section?.trim();
      if(sec)names.add(sec);
    }
    return [...names];
  },[projects,prefs]);

  const sortGroup=(list:ProjectItem[])=>[...list].sort((a,b)=>{
    const pa=prefs[a.key]?.pinned?1:0,pb=prefs[b.key]?.pinned?1:0;
    return pb-pa;
  });

  const sectionedGroups=useMemo(()=>{
    const map=new Map<string,ProjectItem[]>();
    const unsectioned:ProjectItem[]=[];
    for(const item of projects){
      const sec=prefs[item.key]?.section?.trim();
      if(sec){
        if(!map.has(sec))map.set(sec,[]);
        map.get(sec)!.push(item);
      }else unsectioned.push(item);
    }
    return {
      custom:[...map.entries()].map(([name,items])=>({name,items:sortGroup(items)})),
      defaultItems:sortGroup(unsectioned),
    };
  },[projects,prefs]);

  function openProjectMenu(project:ProjectItem,element:HTMLElement){
    const rect=element.getBoundingClientRect();
    setMenu({project,point:{x:rect.right,y:rect.bottom+6,align:'end'}});
  }

  function renderProject(project:ProjectItem){
    const isExpanded=expandedKeys.has(project.key);
    const pref=prefs[project.key]||{};
    const state=projectThreads[project.key];
    const items=state?.items||[];
    const showAll=Boolean(showAllMap[project.key]);
    const visibleItems=showAll?items:items.slice(0,INITIAL_THREAD_LIMIT);
    const hasHiddenLocal=!showAll&&items.length>INITIAL_THREAD_LIMIT;
    const isMenuOpen=menu?.project.key===project.key;
    const displayName=project.name||workspaceName(project.path);

    return <div className={`project-item${isExpanded?' expanded':''}${isMenuOpen?' menu-open':''}`} key={project.key}>
      <div className="project-row-wrap">
        <button type="button" className="project-row" aria-expanded={isExpanded} title={project.path} disabled={busy}
          onClick={()=>onToggleExpand(project)}
          onContextMenu={e=>{e.preventDefault();setMenu({project,point:{x:e.clientX,y:e.clientY}});}}>
          <span className="project-folder-icon">
            <Icon name="folder" size={16}/>
          </span>
          <span className="project-name-text">{displayName}</span>
          {pref.pinned&&<span className="project-pin-mark" title="已置顶"><Icon name="pin" size={12}/></span>}
          {project.owner&&<OwnerBadge owner={project.owner}/>}
        </button>
        <div className="project-row-actions">
          <button type="button" className="project-action-btn" aria-haspopup="dialog" aria-label={`${displayName} 项目操作`} title="项目操作"
            onClick={e=>{e.stopPropagation();openProjectMenu(project,e.currentTarget);}}>
            <Icon name="ellipsis" size={15}/>
          </button>
          {onNewChat&&<button type="button" className="project-action-btn" aria-label={`在 ${displayName} 中新建聊天`} title="在此项目中新建聊天"
            disabled={!connected||busy} onClick={e=>{e.stopPropagation();onNewChat(project);}}>
            <Icon name="compose" size={15}/>
          </button>}
        </div>
      </div>

      {isExpanded&&<div className="project-children" role="group" aria-label={`${displayName} 的会话`}>
        {visibleItems.map(thread=>
          <ThreadRow key={thread.id} thread={thread} selected={selectedThread===thread.id} disabled={busy}
            preference={threadPreferences[thread.id]} time={relativeTime(thread.updatedAt)} active={isThreadActive(thread)}
            open={()=>onOpenThread(thread)} menu={point=>onThreadMenu(thread,point)}/>)}
        {state?.loading&&!items.length&&<div className="project-children-skeleton" role="status" aria-label="正在读取项目会话"><div/><div/></div>}
        {!state?.loading&&!items.length&&!state?.error&&<p className="project-empty-threads">{ownerFiltered?'当前筛选下无会话':'暂无聊天'}</p>}
        {state?.error&&<p className="project-threads-error" role="alert">{state.error}</p>}
        {hasHiddenLocal&&<button type="button" className="project-expand-more" onClick={()=>setShowAllMap(old=>({...old,[project.key]:true}))}>展开显示</button>}
        {!hasHiddenLocal&&state?.hasMore&&<button type="button" className="project-expand-more" disabled={!connected||state.loading} onClick={()=>onLoadMore(project)}>{state.loading?'正在加载…':'展开显示'}</button>}
        {showAll&&items.length>INITIAL_THREAD_LIMIT&&<button type="button" className="project-expand-more" onClick={()=>setShowAllMap(old=>({...old,[project.key]:false}))}>收起</button>}
      </div>}
    </div>;
  }

  const expandedProjects=projects.filter(item=>expandedKeys.has(item.key));
  // Same "⋯" affordance and hover reveal as the project rows, so the header never carries an always-on button next to them.
  const sectionActions=(headerAction||onCreateProject||projects.length>0)&&<div className="project-section-actions">
    {headerAction}
    <button type="button" className="section-more" aria-haspopup="dialog" aria-expanded={Boolean(sectionMenu)} aria-label="项目列表操作" title="项目列表操作"
      onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();setSectionMenu({x:rect.right,y:rect.bottom+6,align:'end'});}}>
      <Icon name="ellipsis" size={15}/>
    </button>
  </div>;
  const sectionMenuItem=(icon:IconName,label:string,action:()=>void,disabled=false)=>
    <button type="button" className="menu-item" disabled={disabled} onClick={()=>{setSectionMenu(null);action();}}>
      <Icon name={icon} size={18}/><span className="menu-copy">{label}</span>
    </button>;

  return <>
    {sectionedGroups.custom.map(group=>{
      const collapsed=collapsedSections.has(group.name);
      return <section className={`project-section custom-project-section${collapsed?' collapsed':''}`} key={group.name}>
        <div className="project-section-head">
          <h2 className="section-heading">
            <button type="button" className="section-toggle" aria-expanded={!collapsed} title={collapsed?`展开 ${group.name}`:`收起 ${group.name}`} onClick={()=>toggleSection(group.name)}>
              <span>{group.name}</span><Icon name="chevron" size={13}/>
            </button>
          </h2>
        </div>
        {!collapsed&&group.items.map(renderProject)}
      </section>;
    })}

    <ProjectsSection collapsed={projectsCollapsed} onToggle={onToggleProjects} action={sectionActions}>
      {sectionedGroups.defaultItems.map(renderProject)}
      {!projects.length&&<p className="empty-projects">还没有项目。{onCreateProject&&<button type="button" className="empty-list-action" disabled={!connected||busy} onClick={onCreateProject}>新建项目</button>}</p>}
    </ProjectsSection>

    {sectionMenu&&<Popover point={sectionMenu} title="项目" label="项目列表操作" showHeader={false} close={()=>setSectionMenu(null)} className="project-menu-popover" focusSelector=".menu-item:not(:disabled)">
      {onCreateProject&&sectionMenuItem('plus','新建项目',onCreateProject,!connected||busy)}
      {sectionMenuItem('collapse','全部收起',()=>expandedProjects.forEach(onToggleExpand),!expandedProjects.length)}
    </Popover>}

    {menu&&<ProjectMenu
      project={menu.project}
      point={menu.point}
      preference={prefs[menu.project.key]||{}}
      sections={allSections}
      connected={connected}
      canManageProjects={canManageProjects}
      hasClaudeSettings={Boolean(onClaudeSettings)}
      threadIds={(projectThreads[menu.project.key]?.items||[]).map(t=>String(t.id))}
      close={()=>setMenu(null)}
      onChangePreference={patch=>updatePref(menu.project.key,patch)}
      onEdit={onEditProject?()=>{const target=menu.project;setMenu(null);onEditProject(target);}:undefined}
      onClaudeSettings={onClaudeSettings?()=>{const target=menu.project;setMenu(null);onClaudeSettings(target);}:undefined}
      onCopyPath={()=>onCopyPath(menu.project.path)}
      onMarkAllRead={onMarkAllRead?(ids)=>{onMarkAllRead(menu.project,ids);setMenu(null);}:undefined}
      onRemove={onRemoveProject?()=>onRemoveProject(menu.project):undefined}
    />}
  </>;
}

function ProjectMenu({
  project,point,preference,sections,connected,canManageProjects,hasClaudeSettings,threadIds,
  close,onChangePreference,onEdit,onClaudeSettings,onCopyPath,onMarkAllRead,onRemove,
}:{
  project:ProjectItem;
  point:MenuPoint;
  preference:ProjectPreference;
  sections:string[];
  connected:boolean;
  canManageProjects:boolean;
  hasClaudeSettings:boolean;
  threadIds:string[];
  close:()=>void;
  onChangePreference:(patch:ProjectPreference)=>void;
  onEdit?:()=>void;
  onClaudeSettings?:()=>void;
  onCopyPath:()=>Promise<void>;
  onMarkAllRead?:(threadIds:string[])=>void;
  onRemove?:()=>Promise<void>;
}){
  const [mode,setMode]=useState<'menu'|'sections'>('menu');
  const [sectionInput,setSectionInput]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function run(action:()=>Promise<void>){
    if(busy)return;
    setBusy(true);setError('');
    try{await action();close();}
    catch(e){setError((e as Error).message||'操作失败，请重试');}
    finally{setBusy(false);}
  }

  const item=(icon:IconName,label:string,action:()=>void,opts?:{disabled?:boolean;danger?:boolean;checked?:boolean;arrow?:boolean})=>
    <button type="button" className={`menu-item${opts?.danger?' danger':''}`} disabled={busy||opts?.disabled} onClick={action}>
      <Icon name={icon} size={18}/>
      <span className="menu-copy">{label}{opts?.checked&&<Icon name="check" size={16}/>}{opts?.arrow&&<span className="menu-arrow"><Icon name="chevron" size={14}/></span>}</span>
    </button>;

  return <Popover point={point} title={project.name||workspaceName(project.path)} label="项目操作" showHeader={false} close={close} className="project-menu-popover" focusSelector={mode==='menu'?'.menu-item:not(:disabled)':'input'}>
    {error&&<p role="alert" className="error">{error}</p>}
    {mode==='menu'?<>
      {item('pin',preference.pinned?'取消置顶':'置顶',()=>{onChangePreference({pinned:!preference.pinned});close();})}
      {canManageProjects&&onEdit&&item('settings','编辑',onEdit,{disabled:!connected})}
      {hasClaudeSettings&&onClaudeSettings&&!canManageProjects&&item('settings','项目设置',onClaudeSettings,{disabled:!connected})}
      <div className="menu-divider"/>
      {item('folder','分区',()=>setMode('sections'),{arrow:true})}
      {item('copy','复制路径',()=>void run(onCopyPath))}
      {hasClaudeSettings&&onClaudeSettings&&canManageProjects&&item('file','项目说明与 MCP',onClaudeSettings,{disabled:!connected})}
      {onMarkAllRead&&threadIds.length>0&&<>
        <div className="menu-divider"/>
        {item('check','全部标为已读',()=>onMarkAllRead(threadIds))}
      </>}
      {canManageProjects&&onRemove&&<>
        <div className="menu-divider"/>
        {item('close','移除项目',()=>{
          if(window.confirm(`从列表中移除「${project.name||workspaceName(project.path)}」？\n\n仅从列表移除，不会删除电脑上的文件夹和历史会话。`)){
            void run(onRemove);
          }
        },{disabled:!connected,danger:true})}
      </>}
    </>:<>
      <div className="project-menu-subhead">
        <span>移至分区</span>
        <button type="button" className="text-button" onClick={()=>{setMode('menu');setError('');}}>返回</button>
      </div>
      <p className="muted project-menu-hint">分区保存在当前浏览器中。</p>
      {item('folder','项目（默认）',()=>{onChangePreference({section:''});close();},{checked:!preference.section})}
      {sections.map(name=><div key={name}>{item('folder',name,()=>{onChangePreference({section:name});close();},{checked:preference.section===name})}</div>)}
      <form className="project-section-form" onSubmit={e=>{e.preventDefault();const v=sectionInput.trim();if(v){onChangePreference({section:v});close();}}}>
        <label>新建分区<input value={sectionInput} maxLength={40} onChange={e=>setSectionInput(e.target.value)} placeholder="例如 Lingan"/></label>
        <button className="primary" disabled={!sectionInput.trim()}>移入新分区</button>
      </form>
    </>}
  </Popover>;
}

export function ProjectEditSheet({
  service,project,connected,call,onSaved,onOpenClaudeSettings,close,
}:{
  service:BridgeService;
  project:ProjectItem;
  connected:boolean;
  call:(action:RequestAction,payload?:Json)=>Promise<any>;
  onSaved:(updated:{name:string;notice?:string})=>void;
  onOpenClaudeSettings?:()=>void;
  close:()=>void;
}){
  const [name,setName]=useState(project.name||workspaceName(project.path));
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function handleSubmit(event:React.FormEvent){
    event.preventDefault();
    const trimmed=name.trim();
    if(!trimmed||busy||!connected)return;
    setBusy(true);setError('');
    try{
      const result=await call('projects.update',{
        service,
        ...(project.id?{id:project.id}:{}),
        ...(project.projectId?{projectId:project.projectId}:{}),
        path:project.path,
        name:trimmed,
        opId:operationId(),
      });
      if(result?.state==='failed'||result?.state==='uncertain'){
        setError(result.error?.message||'保存项目名称失败，请重试');
        return;
      }
      onSaved({name:result?.project?.name||trimmed,notice:result?.notice});
    }catch(failure:any){
      setError(failure?.message||'保存项目名称失败，请重试');
    }finally{
      setBusy(false);
    }
  }

  return <form className="project-edit-form" onSubmit={handleSubmit}>
    <div className="project-root-field">
      <span className="field-caption">项目目录</span>
      <div className="project-root-box" title={project.path}>{project.path}</div>
    </div>
    <label>项目名称
      <input autoFocus required maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="输入项目显示名称" disabled={busy}/>
    </label>
    {service==='codex'&&<p className="muted">修改会写入电脑上的 Codex 项目配置；桌面侧栏可能需要切换窗口后同步。</p>}
    {service==='antigravity'&&<p className="muted">修改会写入电脑上的 Antigravity 项目配置，不影响本地文件夹名称。</p>}
    {service==='claude'&&onOpenClaudeSettings&&<button type="button" className="project-edit-secondary-link" disabled={!connected||busy} onClick={onOpenClaudeSettings}>
      <Icon name="file" size={16}/><span>编辑项目说明（CLAUDE.md）与 MCP 服务器</span><Icon name="chevron" size={14}/>
    </button>}
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="project-create-actions">
      <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
      <button type="submit" className="primary" disabled={!connected||busy||!name.trim()}>{busy?'正在保存…':'保存'}</button>
    </div>
  </form>;
}
