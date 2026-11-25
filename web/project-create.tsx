import {useEffect,useMemo,useRef,useState} from 'react';
import {operationId} from './client';
import {Icon} from './icons';
import {serviceLabel} from './services';
import type {BridgeService,Json,ProjectBrowseEntry,ProjectCreateResult,ProjectRootInfo,RequestAction} from '../src/shared/types';

type Mode='new'|'existing';
type RootsInfo={
  roots:ProjectRootInfo[];
  allowOutsideRoots:boolean;
  configured:boolean;
  guest:boolean;
  defaultRoot:string;
  services:BridgeService[];
};
type BrowseState={
  path:string;
  parent:string|null;
  exists:boolean;
  entries:ProjectBrowseEntry[];
  allowOutsideRoots:boolean;
  configured:boolean;
};

const SERVICE_ORDER:BridgeService[]=['codex','claude','antigravity'];
const orderServices=(list:readonly BridgeService[]):BridgeService[]=>
  [...new Set(list)].sort((a,b)=>SERVICE_ORDER.indexOf(a)-SERVICE_ORDER.indexOf(b));
const baseName=(path:string)=>path.replace(/[\\/]+$/,'').split(/[\\/]/).filter(Boolean).at(-1)||path;
const joinPreview=(parent:string,folder:string)=>{
  if(!parent)return folder;
  const sep=parent.includes('\\')?'\\':'/';
  return parent.replace(/[\\/]+$/,'')+sep+folder;
};

export interface ProjectCreateSheetProps{
  connected:boolean;
  machineServices?:BridgeService[];
  currentService:BridgeService;
  guest?:boolean;
  call:(action:RequestAction,payload?:Json)=>Promise<any>;
  onCreated:(result:ProjectCreateResult,selectedServices:BridgeService[])=>void;
  close:()=>void;
}

/** Unified project creation dialog shared by Codex, Claude Code, and Antigravity. */
export function ProjectCreateSheet({connected,machineServices,currentService,guest,call,onCreated,close}:ProjectCreateSheetProps){
  const initialServices=useMemo(()=>orderServices(machineServices?.length?machineServices:[currentService]),[machineServices,currentService]);
  const [rootsInfo,setRootsInfo]=useState<RootsInfo|null>(null);
  const [loadingRoots,setLoadingRoots]=useState(true);
  const [mode,setMode]=useState<Mode>('new');

  // Mode: new folder
  const [name,setName]=useState('');
  const [folderName,setFolderName]=useState('');
  const [folderTouched,setFolderTouched]=useState(false);
  const [parentPath,setParentPath]=useState('');
  const [initGit,setInitGit]=useState(true);

  // Mode: existing folder
  const [browsePath,setBrowsePath]=useState('');
  const [browse,setBrowse]=useState<BrowseState|null>(null);
  const [browsing,setBrowsing]=useState(false);
  const [browseError,setBrowseError]=useState('');
  const [selectedPath,setSelectedPath]=useState('');
  const [existingName,setExistingName]=useState('');
  const [existingNameTouched,setExistingNameTouched]=useState(false);
  const [manualPath,setManualPath]=useState('');

  // Services: default ALL available services checked (Product Decision #2)
  const [selectedServices,setSelectedServices]=useState<BridgeService[]>(initialServices);
  // Extra configuration stays collapsed by default so creating a project only needs a name.
  const [showOptions,setShowOptions]=useState(false);

  // Submission & partial failure state
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [partial,setPartial]=useState<{result:ProjectCreateResult;requested:BridgeService[]}|null>(null);

  const request=useRef(call);request.current=call;
  const browseSeq=useRef(0);

  useEffect(()=>{
    if(!connected)return;
    let alive=true;
    setLoadingRoots(true);
    setError('');
    request.current('projects.roots',{}).then((info:RootsInfo)=>{
      if(!alive)return;
      const services=orderServices(Array.isArray(info.services)&&info.services.length?info.services:initialServices);
      setRootsInfo({...info,services});
      setSelectedServices(services);
      const firstRoot=info.roots?.[0]?.path||info.defaultRoot||'';
      setParentPath(old=>old||firstRoot);
      setBrowsePath(old=>old||firstRoot);
    }).catch((failure:any)=>{
      if(alive)setError(failure?.message||'无法读取电脑的项目根目录配置');
    }).finally(()=>{
      if(alive)setLoadingRoots(false);
    });
    return()=>{alive=false;};
  },[connected]);

  useEffect(()=>{
    if(mode!=='existing'||!connected||!browsePath)return;
    const seq=++browseSeq.current;
    setBrowsing(true);
    setBrowseError('');
    request.current('projects.browse',{path:browsePath}).then((next:BrowseState)=>{
      if(seq!==browseSeq.current)return;
      setBrowse(next);
    }).catch((failure:any)=>{
      if(seq!==browseSeq.current)return;
      setBrowseError(failure?.message||'无法浏览该目录');
    }).finally(()=>{
      if(seq===browseSeq.current)setBrowsing(false);
    });
  },[mode,connected,browsePath]);

  const availableServices=rootsInfo?.services?.length?rootsInfo.services:initialServices;
  const roots=rootsInfo?.roots||[];
  const allowOutside=Boolean(rootsInfo?.allowOutsideRoots);
  const configured=Boolean(rootsInfo?.configured);
  const isGuest=Boolean(rootsInfo?.guest??guest);

  function updateNewName(next:string){
    setName(next);
    if(!folderTouched)setFolderName(next.trim());
  }

  function pickExistingDir(dirPath:string){
    setSelectedPath(dirPath);
    if(!existingNameTouched)setExistingName(baseName(dirPath));
    setError('');
  }

  function toggleService(svc:BridgeService){
    setSelectedServices(old=>{
      if(old.includes(svc)){
        if(old.length<=1)return old;
        return old.filter(item=>item!==svc);
      }
      return orderServices([...old,svc]);
    });
  }

  async function submitCreate(payload:Json,requested:BridgeService[]){
    if(busy||!connected)return;
    setBusy(true);
    setError('');
    try{
      const response=await request.current('projects.create',{...payload,services:requested,opId:operationId()});
      if(response?.state==='failed'){
        setError(response.error?.message||'创建项目失败，请重试');
        return;
      }
      if(response?.state==='uncertain'){
        setError(response.error?.message||'操作结果待核实，请刷新项目列表确认。');
        return;
      }
      const result:ProjectCreateResult=response;
      const results=result.results||{};
      const failed=requested.filter(svc=>results[svc]&&!results[svc]!.ok);
      if(!failed.length){
        onCreated(result,requested);
        return;
      }
      setPartial({result,requested});
    }catch(failure:any){
      setError(failure?.message||'创建项目失败，请重试');
    }finally{
      setBusy(false);
    }
  }

  function handleSubmit(event:React.FormEvent){
    event.preventDefault();
    if(!selectedServices.length){setError('请至少选择一个目标应用');return;}
    if(mode==='new'){
      const trimmedName=name.trim();
      const trimmedFolder=(folderName||trimmedName).trim();
      if(!trimmedName){setError('请输入项目名称');return;}
      if(!trimmedFolder){setError('请输入文件夹名称');return;}
      void submitCreate({
        mode:'new',
        name:trimmedName,
        folderName:trimmedFolder,
        parentPath:parentPath||undefined,
        initGit,
      },selectedServices);
      return;
    }
    const chosenPath=(selectedPath||manualPath).trim();
    if(!chosenPath){setError('请先选择一个文件夹');return;}
    const displayName=(existingName||baseName(chosenPath)).trim();
    void submitCreate({
      mode:'existing',
      path:chosenPath,
      name:displayName,
    },selectedServices);
  }

  async function retryFailed(){
    if(!partial||busy||!connected)return;
    const failed=partial.requested.filter(svc=>!partial.result.results[svc]?.ok);
    if(!failed.length){onCreated(partial.result,partial.requested);return;}
    setBusy(true);
    setError('');
    try{
      const response=await request.current('projects.create',{
        mode:'existing',
        path:partial.result.path,
        name:(mode==='new'?name:existingName||baseName(partial.result.path)).trim()||baseName(partial.result.path),
        services:failed,
        opId:operationId(),
      });
      if(response?.state==='failed'||response?.state==='uncertain'){
        setError(response.error?.message||'重试失败');
        return;
      }
      const retryResult:ProjectCreateResult=response;
      const merged:ProjectCreateResult={
        ...partial.result,
        results:{...partial.result.results,...retryResult.results},
      };
      const stillFailed=partial.requested.filter(svc=>!merged.results[svc]?.ok);
      if(!stillFailed.length){
        onCreated(merged,partial.requested);
        return;
      }
      setPartial({result:merged,requested:partial.requested});
    }catch(failure:any){
      setError(failure?.message||'重试失败');
    }finally{
      setBusy(false);
    }
  }

  if(partial){
    const succeeded=partial.requested.filter(svc=>partial.result.results[svc]?.ok);
    const failed=partial.requested.filter(svc=>!partial.result.results[svc]?.ok);
    return <div className="project-create">
      <p className="muted">目录已就绪：<code className="project-code-path">{partial.result.path}</code></p>
      {partial.result.gitNotice&&<p className="muted">{partial.result.gitNotice}</p>}
      <div className="project-outcomes" role="list">
        {partial.requested.map(svc=>{
          const item=partial.result.results[svc];
          const ok=Boolean(item?.ok);
          return <div className={`project-outcome-row${ok?' ok':' fail'}`} key={svc} role="listitem">
            <strong>{serviceLabel(svc)}</strong>
            <span>{ok?(item?.notice||'已注册'):(item?.error?.message||'注册失败')}</span>
          </div>;
        })}
      </div>
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="project-create-actions">
        {failed.length>0&&<button type="button" className="secondary" disabled={!connected||busy} onClick={()=>void retryFailed()}>{busy?'正在重试…':'重试失败项'}</button>}
        <button type="button" className="primary" disabled={busy} onClick={()=>onCreated(partial.result,succeeded.length?succeeded:partial.requested)}>进入新项目</button>
      </div>
    </div>;
  }

  const canSelectCurrentBrowse=Boolean(
    browse?.exists&&(
      allowOutside||
      !roots.some(root=>root.path.toLowerCase()===browse.path.toLowerCase())
    ),
  );
  const previewFullPath=mode==='new'&&parentPath&&(folderName||name.trim())?joinPreview(parentPath,folderName||name.trim()):'';
  const rootLabel=roots.find(root=>root.path===parentPath)?.label||(parentPath?baseName(parentPath):'默认目录');
  const appsSummary=selectedServices.length===availableServices.length?'全部应用':selectedServices.map(serviceLabel).join('、');
  const customFolder=folderTouched&&folderName.trim()&&folderName.trim()!==name.trim()?`目录 ${folderName.trim()}`:'';
  const customDisplayName=existingNameTouched&&existingName.trim()&&selectedPath&&existingName.trim()!==baseName(selectedPath)?existingName.trim():'';
  const optionsSummary=mode==='new'
    ?[customFolder,rootLabel,initGit?'Git':'无 Git',appsSummary].filter(Boolean).join(' · ')
    :[customDisplayName,appsSummary].filter(Boolean).join(' · ');

  const servicesFieldset=<fieldset className="project-services">
    <legend>注册到应用（可多选）</legend>
    <div className="project-service-list">
      {availableServices.map(svc=>{
        const checked=selectedServices.includes(svc);
        return <label className={`project-service-option${checked?' checked':''}`} key={svc}>
          <input type="checkbox" checked={checked} onChange={()=>toggleService(svc)}/>
          <span>{serviceLabel(svc)}</span>
        </label>;
      })}
    </div>
  </fieldset>;

  return <form className="project-create" onSubmit={handleSubmit}>
    <div className="project-create-tabs" role="tablist" aria-label="创建方式">
      <button type="button" role="tab" aria-selected={mode==='new'} className={mode==='new'?'selected':''} onClick={()=>{setMode('new');setShowOptions(false);setError('');}}>新建文件夹</button>
      <button type="button" role="tab" aria-selected={mode==='existing'} className={mode==='existing'?'selected':''} onClick={()=>{setMode('existing');setShowOptions(false);setError('');}}>已有文件夹</button>
    </div>

    {loadingRoots&&!rootsInfo?<div className="list-skeleton" role="status" aria-label="正在读取电脑目录配置"><div/><div/></div>:
    mode==='new'?<>
      <label>项目名称
        <input autoFocus required maxLength={80} value={name} onChange={e=>updateNewName(e.target.value)} placeholder="例如 my-service"/>
      </label>
      <div className={`project-options${showOptions?' open':''}`}>
        <button type="button" className="project-options-toggle" aria-expanded={showOptions} onClick={()=>setShowOptions(old=>!old)}>
          <span className="project-options-title">更多选项</span>
          <span className="project-options-summary" title={optionsSummary}>{optionsSummary}</span>
          <Icon name="chevron" size={14}/>
        </button>
        {showOptions&&<div className="project-options-body">
          <label>文件夹名称
            <input maxLength={80} value={folderName} onChange={e=>{const next=e.target.value;setFolderTouched(Boolean(next.trim()));setFolderName(next);}} placeholder="默认与项目名称一致"/>
          </label>
          {roots.length>1?<label>保存位置
            <select value={parentPath} onChange={e=>setParentPath(e.target.value)}>
              {roots.map(root=><option key={root.path} value={root.path}>{root.label}{root.isDefault?'（默认）':''} — {root.path}</option>)}
            </select>
          </label>:<div className="project-root-field">
            <span className="field-caption">保存位置</span>
            <div className="project-root-box" title={parentPath}>{parentPath||'默认项目目录'}</div>
            <p className="muted">
              {isGuest?'借用模式下，新建项目位于电脑的共享工作区目录中。'
                :!configured?'当前电脑未配置团队项目根目录，默认新建在此目录；管理员可在电脑托盘的「连接设置」中添加项目根目录。'
                :'将在管理员配置的默认项目根目录下创建新文件夹。'}
            </p>
          </div>}
          {previewFullPath&&<p className="project-path-preview" title={previewFullPath}>将创建：<code>{previewFullPath}</code></p>}
          <label className="project-check">
            <input type="checkbox" checked={initGit} onChange={e=>setInitGit(e.target.checked)}/>
            <span>初始化 Git 仓库（git init）</span>
          </label>
          {servicesFieldset}
        </div>}
      </div>
    </>:<>
      {roots.length>1&&<div className="project-root-chips" role="group" aria-label="项目根目录">
        {roots.map(root=><button type="button" key={root.path} className={browsePath===root.path?'selected':''} onClick={()=>setBrowsePath(root.path)}>{root.label}</button>)}
      </div>}
      <div className="project-browser">
        <div className="project-browser-bar">
          <button type="button" className="browser-up" disabled={!browse?.parent||browsing} onClick={()=>{if(browse?.parent)setBrowsePath(browse.parent);}} title="上一级">
            <Icon name="back" size={15}/><span>上一级</span>
          </button>
          <span className="browser-cwd" title={browse?.path||browsePath}>{browse?.path||browsePath||'正在读取…'}</span>
          {canSelectCurrentBrowse&&<button type="button" className="browser-pick-current" onClick={()=>pickExistingDir(browse!.path)}>选当前</button>}
        </div>
        <div className="project-browser-list" role="listbox" aria-label="子文件夹">
          {browsing&&<p className="muted browser-empty">正在读取目录…</p>}
          {!browsing&&browseError&&<p className="error browser-empty" role="alert">{browseError}</p>}
          {!browsing&&!browseError&&browse&&!browse.exists&&!configured&&!allowOutside&&
            <p className="muted browser-empty">默认项目目录里还没有文件夹。请切换到「新建文件夹」，或联系管理员在电脑托盘中配置项目根目录。</p>}
          {!browsing&&!browseError&&browse?.exists&&!browse.entries.length&&
            <p className="muted browser-empty">这个目录下没有可选的子文件夹。</p>}
          {!browsing&&!browseError&&browse?.entries.map(entry=>{
            const picked=selectedPath.toLowerCase()===entry.path.toLowerCase();
            return <div className={`project-browser-row${picked?' selected':''}`} key={entry.path}>
              <button type="button" className="browser-entry-pick" role="option" aria-selected={picked} onClick={()=>pickExistingDir(entry.path)} title={entry.path}>
                <Icon name="folder" size={16}/>
                <span className="browser-entry-name">{entry.name}</span>
                {entry.isGit&&<em className="project-git-tag">Git</em>}
                {picked&&<Icon name="check" size={15}/>}
              </button>
              <button type="button" className="browser-entry-open" aria-label={`进入 ${entry.name}`} title="进入子目录" onClick={()=>setBrowsePath(entry.path)}>
                <Icon name="chevron" size={14}/>
              </button>
            </div>;
          })}
        </div>
      </div>

      {!configured&&!allowOutside&&!isGuest&&<p className="muted">管理员尚未在电脑托盘配置项目根目录，目前仅允许关联默认目录下的子文件夹。</p>}

      {allowOutside&&<details className="other-project project-manual">
        <summary>直接输入电脑路径</summary>
        <div className="project-manual-row">
          <input value={manualPath} onChange={e=>setManualPath(e.target.value)} placeholder="例如 D:\Projects\my-app" aria-label="电脑上的完整项目路径"/>
          <button type="button" disabled={!manualPath.trim()} onClick={()=>{const p=manualPath.trim();setBrowsePath(p);pickExistingDir(p);}}>定位</button>
        </div>
      </details>}

      {selectedPath&&<p className="project-path-preview" title={selectedPath}>已选目录：<code>{selectedPath}</code></p>}

      <div className={`project-options${showOptions?' open':''}`}>
        <button type="button" className="project-options-toggle" aria-expanded={showOptions} onClick={()=>setShowOptions(old=>!old)}>
          <span className="project-options-title">更多选项</span>
          <span className="project-options-summary" title={optionsSummary}>{optionsSummary}</span>
          <Icon name="chevron" size={14}/>
        </button>
        {showOptions&&<div className="project-options-body">
          <label>显示名称
            <input maxLength={80} value={existingName} onChange={e=>{const next=e.target.value;setExistingNameTouched(Boolean(next.trim()));setExistingName(next);}} placeholder="默认使用文件夹名称"/>
          </label>
          {servicesFieldset}
        </div>}
      </div>
    </>}

    {error&&<p className="error" role="alert">{error}</p>}

    <div className="project-create-actions">
      <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
      <button type="submit" className="primary" disabled={!connected||busy||loadingRoots||(mode==='new'?!name.trim():!(selectedPath||manualPath.trim()))}>
        {busy?(mode==='new'?'正在创建…':'正在关联…'):(mode==='new'?'创建项目':'关联项目')}
      </button>
    </div>
  </form>;
}
