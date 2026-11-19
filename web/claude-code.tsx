import {useEffect,useRef,useState,type ClipboardEvent} from 'react';
import {ConversationStatus,ConversationTurn,connectionLost} from './conversation';
import {SendMessageButton,ThreadHeader,submitOnDesktop,useComposerHeight,workspaceName} from './chat-layout';
import {IconButton} from './icon-button';
import {Icon} from './icons';
import {useStableEvent} from './use-event';
import {operationId} from './client';
import {GuestProjectForm} from './claude-projects';
import {clipboardImageFiles,readImageFiles,appendImages,pastedImage} from './attachments';
import {MAX_IMAGES,MAX_TOTAL_IMAGE_BYTES,imageBytes} from '../src/shared/images';
import type {Json,RequestAction,TurnView} from '../src/shared/types';

type Props={
  machine:string;machineName:string;connected:boolean;conversationId:string;inert:boolean;previewError:string;guest?:boolean;
  /** Where a new session starts: a project folder or '' to choose; null while a saved session is open. */
  newCwd:string|null;created:(id:string)=>void;
  call:(action:RequestAction,payload?:Json)=>Promise<any>;go:(id:string)=>void;
  openFile:(path:string)=>void;openPreview:(url:string)=>void;showFiles:()=>void;showImage:(url:string,title:string)=>void;
  copyText:(text:string)=>Promise<void>;clearPreviewError:()=>void;
};
type Request={id:string;kind:'permission'|'question'|'plan';tool:string;title:string;detail:string;canRemember:boolean;questions?:{question:string;header:string;multiSelect:boolean;options:{label:string;description:string}[]}[]};
const noop=()=>{};
const notEditable=()=>Promise.reject(new Error('Claude Code 会话暂不支持改写旧消息'));
type Place={id:string;path:string};
const OTHER='__other';
const MODES:[string,string][]=[['','默认审批'],['default','按规则审批'],['acceptEdits','自动接受编辑'],['plan','只做计划'],['bypassPermissions','全部允许（慎用）']];
function load(key:string){try{return localStorage.getItem(key)||'';}catch{return '';}}
function store(key:string,value:string){try{if(value)localStorage.setItem(key,value);else localStorage.removeItem(key);}catch{}}

/** Claude Code sessions on the connected computer: live view, composer, approvals and questions. */
export function ClaudeCodePanel(props:Props){
  const {machine,machineName,connected,conversationId,newCwd,inert,previewError,guest,call,go,openFile,openPreview,showFiles,showImage,copyText,clearPreviewError}=props;
  const creating=!conversationId;
  const scope=`claude:${machine}:${conversationId||'new'}`;
  const [view,setView]=useState<Json|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[watchError,setWatchError]=useState('');
  const [draft,setDraft]=useState(()=>load(`${scope}:draft`)),[images,setImages]=useState<string[]>([]),[pending,setPending]=useState(()=>load(`${scope}:pending`));
  const [model,setModel]=useState(()=>load(`claude:${machine}:model`)),[mode,setMode]=useState('');
  const [models,setModels]=useState<Json[]|null>(null),[cwd,setCwd]=useState(''),[target,setTarget]=useState(newCwd||''),[places,setPlaces]=useState<Place[]>([]);
  const request=useRef(call);request.current=call;
  const alive=useRef(true),lock=useRef(false),scroll=useRef<HTMLDivElement>(null),stick=useRef(true),composer=useRef<HTMLTextAreaElement>(null),picker=useRef<HTMLInputElement>(null);
  useComposerHeight(composer,draft,true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  function edit(text:string){setDraft(text);store(`${scope}:draft`,text);}
  function remember(op:string){setPending(op);store(`${scope}:pending`,op);}
  function failed(e:any){if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用 Claude Code。':e?.message||'Claude Code 操作失败');}
  const refresh=useStableEvent(async(clearError=true)=>{
    if(!connected||creating)return;
    setBusy(true);
    try{const next=await request.current('claude.read',{conversationId});if(alive.current){setView(next);if(clearError)setError('');setWatchError('');}}
    catch(e){failed(e);}
    finally{if(alive.current)setBusy(false);}
  });
  useEffect(()=>{void refresh();},[connected,conversationId,refresh]);
  useEffect(()=>{
    if(!creating||!connected)return;
    request.current('claude.list',{}).then(page=>{if(!alive.current)return;const list:Place[]=page.projects||[];setPlaces(list);setTarget(old=>old||list[0]?.id||(guest?'':OTHER));}).catch(failed);
  },[creating,connected,guest]);
  useEffect(()=>{
    if(!connected||!view?.revision)return;
    let active=true,inflight=false,timer:ReturnType<typeof setTimeout>;
    async function watch(){
      if(!active||inflight||document.visibilityState!=='visible')return;
      inflight=true;let retry=0;
      try{
        const next=await request.current('claude.watch',{conversationId,revision:view!.revision});
        if(!active)return;
        setWatchError('');
        if(!next.unchanged){setView(next);return;}
      }catch{if(active)setWatchError('与电脑的会话同步中断，正在重连…');retry=2500;}
      finally{inflight=false;}
      if(active)timer=setTimeout(watch,retry);
    }
    void watch();
    document.addEventListener('visibilitychange',watch);
    return()=>{active=false;clearTimeout(timer);document.removeEventListener('visibilitychange',watch);};
  },[connected,conversationId,view?.revision]);
  useEffect(()=>{if(stick.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[view]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4000);return()=>clearTimeout(timer);},[notice]);

  async function mutate(action:'claude.create'|'claude.send'|'claude.stop'|'claude.respond',payload:Json,onAccepted?:(result:Json)=>void){
    if(lock.current||pending||!connected)return false;
    lock.current=true;setBusy(true);setError('');
    const opId=operationId();remember(opId);
    try{
      const result=await request.current(action,{...payload,opId});
      if(!alive.current)return false;
      if(result.state==='accepted'){remember('');onAccepted?.(result);return true;}
      if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError(result.error?.message||'结果待核实，请刷新会话查看。');
    }catch(e:any){if(!e?.uncertain&&alive.current)remember('');failed(e);}
    finally{lock.current=false;if(alive.current)setBusy(false);void refresh(false);}
    return false;
  }
  async function check(){
    if(lock.current||!pending||!connected)return;lock.current=true;setBusy(true);
    try{
      const result=await request.current('claude.operation',{opId:pending});
      if(!alive.current)return;
      if(result.state==='accepted'){remember('');setError('');if(result.conversationId&&creating){edit('');props.created(result.conversationId);}else if(result.submitted){edit('');setImages([]);}}
      else if(result.state==='failed'){remember('');setError(result.error?.message||'操作未完成');}
      else setError('结果尚未确认。请刷新会话并在电脑核实；系统不会自动重发。');
    }catch(e){failed(e);}finally{lock.current=false;if(alive.current)setBusy(false);}
    void refresh(false);
  }
  useEffect(()=>{if(connected&&pending)void check();},[connected]);

  const running=Boolean(view?.running),external=Boolean(view?.external&&!view?.controlled);
  // A project from the list, or an unlisted folder passed in.
  const chosen=places.find(place=>place.id===target)||(target&&target!==OTHER?{id:target,path:target}:undefined);
  const startPath=target===OTHER?cwd.trim():chosen?.path||'';
  const selectedMode=mode==='bypassPermissions'&&view?.controlled?'':mode;
  async function send(steer=false){
    const text=draft.trim();
    if(!text&&!images.length)return;
    const settings={...(model?{model}:{}),...(selectedMode?{permissionMode:selectedMode}:{})};
    if(creating){
      if(!startPath){setError('请选择项目');return;}
      stick.current=true;
      await mutate('claude.create',{cwd:startPath,text,images,...settings},result=>{edit('');setImages([]);props.created(result.conversationId);});
      return;
    }
    if(external&&!window.confirm('电脑上的 Claude Code 可能还在运行这条会话。确认那边已经结束，由手机继续？'))return;
    stick.current=true;
    await mutate('claude.send',{conversationId,text,images,...settings,...(steer?{mode:'steer'}:{}),...(external?{confirmIdle:true}:{})},
      ()=>{edit('');setImages([]);if(selectedMode==='bypassPermissions')setMode('');setNotice(running?steer?'已追加到当前任务':'已排队，当前任务结束后发送':'');});
  }
  async function addImages(files:File[]){
    if(!files.length)return;
    try{
      const budget=MAX_TOTAL_IMAGE_BYTES-images.reduce((sum,url)=>sum+imageBytes(url),0);
      const next=appendImages(images,await readImageFiles(files,budget));
      if(next.length>MAX_IMAGES)throw Error(`最多添加 ${MAX_IMAGES} 张图片`);
      if(alive.current)setImages(next);
    }catch(e){failed(e);}
  }
  function paste(event:ClipboardEvent<HTMLTextAreaElement>){
    const files=clipboardImageFiles(event.clipboardData);
    if(files.length){event.preventDefault();void addImages(files);return;}
    try{const data=pastedImage(event.clipboardData.getData('text/plain'));if(data){event.preventDefault();setImages(old=>appendImages(old,[data]));}}
    catch(e){event.preventDefault();failed(e);}
  }
  async function openModels(){
    if(models||!connected)return;
    try{const result=await request.current('claude.models',{cwd:view?.cwd||startPath||undefined});if(alive.current)setModels(result.models||[]);}
    catch(e){failed(e);}
  }
  function chooseModel(value:string){setModel(value);store(`claude:${machine}:model`,value);}

  const copy=useStableEvent((text:string)=>void copyText(text).catch(()=>setError('复制失败，请长按选择文字')));
  const followup=useStableEvent((text:string)=>{edit(draft.trim()?`${draft.trimEnd()}\n\n${text}`:text);composer.current?.focus();});
  const turns:TurnView[]=view?.turns||[];
  const requests:Request[]=view?.requests||[];
  const status=!connected?connectionLost:watchError||(pending&&busy?'正在等待电脑确认…':'');
  const canWrite=connected&&!busy&&!pending&&(creating?(!guest||Boolean(startPath)):Boolean(view));
  const title=creating?'新的 Claude Code 会话':view?.title||'正在打开…';
  const project=creating?(startPath?workspaceName(startPath):'选择项目'):view?.cwd?workspaceName(view.cwd):'Claude Code';
  const modelLabel=(models||[]).find(item=>item.id===model)?.label||model;
  return <main className="thread-panel" inert={inert}>
    <ThreadHeader title={title} project={project} machineName={machineName} connected={connected} back={()=>go('')}>
      {!creating&&<IconButton icon="refresh" label="刷新会话" disabled={!connected||busy} onClick={()=>void refresh()}/>}
    </ThreadHeader>
    {view?.notice&&<div className="banner">{view.notice}</div>}
    <div className={`timeline ${creating?'is-empty':''}`} ref={scroll} onScroll={()=>{const el=scroll.current!;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}}><div className="timeline-content">
      {creating?<div className="new-chat-welcome"><h1>交给 Claude Code</h1>
        <label className="claude-project"><Icon name="folder" size={18}/><select aria-label="项目" value={target} onChange={e=>setTarget(e.target.value)}>
          {!target&&<option value="">{guest?'选择或新建项目':'正在读取项目…'}</option>}
          {places.map(place=><option key={place.id} value={place.id}>{workspaceName(place.path)}</option>)}
          {chosen&&!places.includes(chosen as Place)&&<option value={chosen.id}>{workspaceName(chosen.path)}</option>}
          {!guest&&<option value={OTHER}>其他文件夹…</option>}
        </select></label>
        {guest?<details className="other-project" open={!startPath||undefined}><summary>新建项目</summary>
          <GuestProjectForm connected={connected&&!busy} call={call} select={path=>{setPlaces(old=>old.some(item=>item.id===path)?old:[...old,{id:path,path}]);setTarget(path);}}/>
        </details>:target===OTHER&&<label className="claude-project"><input autoFocus aria-label="文件夹路径" placeholder="电脑上的完整路径" value={cwd} onChange={e=>setCwd(e.target.value)}/></label>}
        {startPath&&<p className="muted">{startPath}</p>}</div>:<>
        {view?.truncated&&<p className="muted">仅显示近期记录，完整会话可在电脑查看。</p>}
        {!view&&busy&&<div className="conversation-skeleton" role="status" aria-label="正在同步会话"><div/><div/></div>}
        {turns.map(turn=><ConversationTurn key={turn.id} turn={turn} running={running} source={view?.controlled?'connector':'history'} latestUser={false} disabled={!canWrite}
          openFile={openFile} openPreview={openPreview} onFollowup={followup} onCopy={copy} onEdit={notEditable} onFork={noop} onDiff={noop} onBlocked={setNotice} editBlocked="Claude Code 会话暂不支持改写旧消息" hideFork/>)}
        {view&&!turns.length&&!running&&<p className="muted">这条会话还没有可显示的消息。</p>}
        {view?.error&&<ConversationStatus>{view.error}</ConversationStatus>}
      </>}
      {status&&<ConversationStatus>{status}</ConversationStatus>}
    </div></div>
    <footer className="composer-area">
      <div className="request-stack">{requests.map(item=><ClaudeRequestCard key={`${conversationId}:${item.id}`} request={item} disabled={!connected||busy||Boolean(pending)}
        respond={(decision,answers)=>void mutate('claude.respond',{conversationId,requestId:item.id,decision,...(answers?{answers}:{})})}/>)}</div>
      {(error||previewError)&&<div className="feedback error" role="alert"><span>{error||previewError}</span><IconButton icon="close" label="关闭提示" onClick={()=>{setError('');clearPreviewError();}}/></div>}
      {notice&&<div className="feedback" role="status">{notice}</div>}
      {pending&&!busy&&<div className="pending"><button onClick={()=>void check()} disabled={!connected}>核实操作结果</button><button onClick={()=>{if(window.confirm('请先在会话和电脑上确认操作结果。解除提示不会重发消息。')){remember('');setError('');}}}>我已核实</button></div>}
      {running&&view?.controlled&&<div className="running-status"><i className="dot online"/>Claude Code 正在处理{view?.queued?' · 有排队消息':''}</div>}
      <form className={`composer ${images.length?'with-images':''}`} onSubmit={e=>{e.preventDefault();void send();}}>
        {images.length>0&&<div className="image-strip"><span className="attachment-count" role="status">图片 {images.length}/{MAX_IMAGES}</span><div className="attachment-thumbnails">{images.map((url,i)=><div className="attachment-thumb" key={i}>
          <button type="button" aria-label={`查看第 ${i+1} 张图片`} onClick={()=>showImage(url,`待发送图片 ${i+1}/${images.length}`)}><img src={url} alt={`待发送图片 ${i+1}`} decoding="async"/></button>
          <button className="attachment-remove" type="button" disabled={busy} aria-label={`移除第 ${i+1} 张图片`} onClick={()=>setImages(old=>old.filter((_,index)=>index!==i))}><Icon name="close" size={14}/></button></div>)}</div></div>}
        <textarea ref={composer} aria-label="任务输入" readOnly={Boolean(pending)} value={draft} maxLength={100_000} rows={1} onPaste={paste}
          placeholder={creating?'想让 Claude Code 做什么？':running?'当前任务完成后发送…':`在 ${machineName} 上继续…`}
          onChange={e=>edit(e.target.value)} onKeyDown={e=>submitOnDesktop(e,()=>void send())}/>
        <div className="composer-toolbar">
          <IconButton icon="image" label="添加图片" className="composer-add" disabled={!canWrite} onClick={()=>picker.current?.click()}/>
          {!creating&&<IconButton icon="file" label="查看项目文件" className="composer-add" disabled={!connected||!view} onClick={showFiles}/>}
          <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';void addImages(files);}}/>
          <select className="claude-select" aria-label="模型" value={model} disabled={!connected||busy} onFocus={()=>void openModels()} onPointerDown={()=>void openModels()} onChange={e=>chooseModel(e.target.value)}>
            <option value="">{view?.model?`模型：${view.model}`:'默认模型'}</option>
            {model&&!(models||[]).some(item=>item.id===model)&&<option value={model}>{modelLabel}</option>}
            {(models||[]).map(item=><option key={item.id} value={item.id} title={item.description}>{item.label}</option>)}
          </select>
          <select className="claude-select" aria-label="权限模式" value={selectedMode} disabled={!connected||busy} onChange={e=>setMode(e.target.value)}>
            {MODES.filter(([value])=>value!=='bypassPermissions'||creating||!view?.controlled).map(([value,label])=><option key={value} value={value}>{value===''&&view?.permissionMode?`权限：${MODES.find(m=>m[0]===view.permissionMode)?.[1]||view.permissionMode}`:label}</option>)}
          </select>
          <div className="composer-actions">
            {running&&view?.controlled&&<IconButton icon="stop" label="停止当前任务" className="round stop" disabled={!connected||busy||Boolean(pending)} onClick={()=>void mutate('claude.stop',{conversationId})}/>}
            {running&&view?.controlled&&(draft.trim()||images.length>0)&&<IconButton icon="steer" label="立即追加到当前任务" className="round" disabled={!canWrite} onClick={()=>void send(true)}/>}
            <SendMessageButton sending={Boolean(pending&&busy)} label={running?'完成后发送':'发送消息'} disabled={!canWrite||!draft.trim()&&!images.length||creating&&!startPath}/>
          </div>
        </div>
      </form>
    </footer>
  </main>;
}

function ClaudeRequestCard({request,disabled,respond}:{request:Request;disabled:boolean;respond:(decision:'allow'|'allowSession'|'deny',answers?:Record<string,string>)=>void}){
  const [answers,setAnswers]=useState<Record<string,string[]>>({});
  const [other,setOther]=useState<Record<string,string>>({});
  if(request.kind==='question'){
    const value=(question:string)=>[...(answers[question]||[]),...(other[question]?.trim()?[other[question].trim()]:[])].join(', ');
    const complete=request.questions?.every(q=>value(q.question));
    return <div className="request"><strong>{request.title}</strong>
      {request.questions?.map(q=><div className="claude-question" key={q.question}><p>{q.header&&<small>{q.header} · </small>}{q.question}</p>
        <div className="choices">{q.options.map(option=>{const chosen=answers[q.question]?.includes(option.label);return <button type="button" key={option.label} title={option.description} className={chosen?'chosen':''} disabled={disabled}
          onClick={()=>setAnswers(old=>{const current=old[q.question]||[];return {...old,[q.question]:q.multiSelect?chosen?current.filter(x=>x!==option.label):[...current,option.label]:[option.label]};})}>{option.label}</button>;})}</div>
        <input placeholder="其他回答（可选）" value={other[q.question]||''} disabled={disabled} onChange={e=>setOther(old=>({...old,[q.question]:e.target.value}))}/></div>)}
      <div className="choices"><button className="primary" disabled={disabled||!complete} onClick={()=>respond('allow',Object.fromEntries((request.questions||[]).map(q=>[q.question,value(q.question)])))}>提交回答</button>
        <button disabled={disabled} onClick={()=>respond('deny')}>跳过</button></div></div>;
  }
  return <div className="request"><strong>{request.title}</strong>{request.detail&&<pre>{request.detail}</pre>}
    <div className="choices">
      <button disabled={disabled} onClick={()=>respond('allow')}>{request.kind==='plan'?'开始执行':'允许'}</button>
      {request.canRemember&&<button disabled={disabled} onClick={()=>respond('allowSession')}>允许并记住</button>}
      <button disabled={disabled} onClick={()=>respond('deny')}>{request.kind==='plan'?'继续规划':'拒绝'}</button>
    </div></div>;
}
