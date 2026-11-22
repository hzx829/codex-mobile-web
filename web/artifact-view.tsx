import {useEffect,useRef,useState,type PointerEvent} from 'react';
import {receiveFile} from './file-download';
import type {FilePreview,Json,RequestAction} from '../src/shared/types';

type Call=(action:RequestAction,payload?:Json)=>Promise<any>;
type Ready={title:string;at:number;html:string};
const time=(at:number)=>new Date(at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
/** Snapshots are made for a few widths only, so phones of similar size share one copy on the computer. */
const snapWidth=(width:number)=>Math.max(320,Math.min(1600,Math.floor(width/40)*40));

/**
 * A claude.ai Artifact, rendered on the computer and shown here as a static copy.
 * The phone never contacts claude.ai: the connector's own browser opens the page and sends the result over the relay.
 * `fresh` names the page's latest change; a new value means the saved copy is out of date and is made again.
 */
export function ArtifactPanel({url,connected,call,onTitle,fresh}:{url:string;connected:boolean;call:Call;onTitle?:(title:string)=>void;fresh?:string}){
  const [state,setState]=useState<'loading'|'rendering'|'login'|'ready'|'error'>('loading');
  const [page,setPage]=useState<Ready|null>(null),[error,setError]=useState(''),[progress,setProgress]=useState(0);
  const box=useRef<HTMLDivElement>(null),run=useRef(0),request=useRef(call),loaded=useRef<string|undefined>(undefined);request.current=call;
  async function load(refresh=false){
    const id=++run.current,alive=()=>id===run.current;
    setError('');setState(page&&!refresh?'ready':'loading');setProgress(0);
    const width=snapWidth(box.current?.clientWidth||window.innerWidth);
    try{
      let result:Json;
      // The computer answers within ~25 s while it renders; ask again until the copy is ready.
      for(let tries=0;;tries++){
        result=await request.current('claude.artifact.snapshot',{url,width,refresh:refresh&&tries===0});
        if(!alive())return;
        if(result.state!=='rendering')break;
        setState('rendering');
        if(tries>=8)throw new Error('电脑渲染页面超时，请稍后刷新');
      }
      if(result.state==='login'){setState('login');return;}
      const file:FilePreview=result.file;
      const controller=new AbortController();
      const blob=await receiveFile(file,offset=>request.current('claude.artifact.download',{slug:result.slug,name:file.name,revision:file.revision,offset}),controller.signal,bytes=>alive()&&setProgress(file.size?bytes/file.size:1));
      const html=await blob.text();
      if(!alive())return;
      setPage({title:result.title,at:result.at,html});setState('ready');onTitle?.(result.title);
    }catch(e){if(alive()){const failure=e as {code?:string;message?:string};setError(failure?.code==='unsupported'?'请更新这台电脑上的连接器以查看 claude.ai 页面。':failure?.message||'打开页面失败');setState(page?'ready':'error');}}
  }
  useEffect(()=>{if(connected){const renew=fresh!==undefined&&fresh!==loaded.current;loaded.current=fresh;void load(renew);}return()=>{run.current++;};},[url,connected,fresh]);
  return <div className="web-viewer artifact-viewer" ref={box}>
    <div className="viewer-toolbar">
      <button disabled={!connected||state==='loading'||state==='rendering'} onClick={()=>void load(true)}>刷新</button>
      {page&&<small>电脑于 {time(page.at)} 生成的静态副本</small>}
    </div>
    {error&&<p className="preview-notice error" role="alert">{error}</p>}
    {state==='ready'&&page?<iframe title={page.title} srcDoc={page.html} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"/>:
      state==='login'?<ArtifactSignIn call={call} connected={connected} done={()=>void load(true)}/>:
      <div className="preview-empty" role={state==='error'?'alert':'status'}>
        {state==='error'?<><p>{error}</p><button disabled={!connected} onClick={()=>void load()}>重试</button></>:
          <p>{!connected?'电脑未连接':progress>0?`正在接收页面 ${Math.floor(progress*100)}%`:state==='rendering'?'电脑正在打开并渲染页面…':'正在请求电脑…'}</p>}
      </div>}
  </div>;
}

/** Signs the computer's browser in to claude.ai: in a window on the computer's own screen, or by remote control (screenshots here, taps and typing sent back). */
function ArtifactSignIn({call,connected,done}:{call:Call;connected:boolean;done:()=>void}){
  const [shot,setShot]=useState<Json|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[text,setText]=useState(''),[link,setLink]=useState(''),[started,setStarted]=useState(false);
  const [desk,setDesk]=useState<'opening'|'open'|'closed'|null>(null);
  const screen=useRef<HTMLDivElement>(null),lock=useRef(false),alive=useRef(true),request=useRef(call);request.current=call;
  async function send(payload:Json){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const next=await request.current('claude.artifact.login',payload);if(alive.current)setShot(next);}
    catch(e){if(alive.current)setError((e as Error)?.message||'操作失败');}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  function start(){
    setStarted(true);
    const width=Math.min(430,Math.max(320,Math.floor(screen.current?.clientWidth||window.innerWidth-32)));
    void send({op:'start',width,height:Math.round(Math.min(900,Math.max(560,window.innerHeight*.72)))});
  }
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;void request.current('claude.artifact.login',{op:'close'}).catch(()=>{});};},[]);
  // Keep the picture current while the page loads or verifies on its own.
  useEffect(()=>{if(!shot||shot.signedIn)return;const timer=setInterval(()=>{if(!lock.current&&document.visibilityState==='visible')void send({op:'frame'});},2500);return()=>clearInterval(timer);},[Boolean(shot),shot?.signedIn]);
  function tap(e:PointerEvent<HTMLImageElement>){
    const rect=e.currentTarget.getBoundingClientRect();
    void send({op:'click',x:(e.clientX-rect.left)/rect.width,y:(e.clientY-rect.top)/rect.height});
  }
  async function desktop(op:'desktop'|'status'){
    if(lock.current)return;lock.current=true;
    if(op==='desktop'){setDesk('opening');setError('');}
    try{
      const result=await request.current('claude.artifact.login',{op});
      if(!alive.current)return;
      if(result.signedIn){setDesk(null);done();}
      else if(result.desktop)setDesk(result.open?'open':'closed');
      else throw new Error('这台电脑上的连接器还不支持，请更新连接器');
    }catch(e){if(alive.current&&op==='desktop'){setDesk(null);setError(`没能在电脑上打开登录窗口：${(e as Error)?.message||'操作失败'}。可以改用远程登录。`);}}
    finally{lock.current=false;}
  }
  useEffect(()=>{if(desk!=='open'||!connected)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')void desktop('status');},2000);return()=>clearInterval(timer);},[desk,connected]);
  if(!started)return <div className="preview-empty artifact-login-intro">
    <p>这台电脑的中转浏览器还没有登录 claude.ai。</p>
    {desk==='open'||desk==='opening'?<p role="status">{desk==='opening'?'正在电脑上打开登录窗口…':'电脑屏幕上已打开登录窗口，请在那里登录 claude.ai。登录完成后这里会自动显示页面。'}</p>:
      <small>登录一次即可。连接器用自己单独的浏览器档案，不读取电脑上 Chrome 或 Edge 里已有的登录；登录信息只保存在电脑上连接器的数据目录里。</small>}
    {desk==='closed'&&<p role="status">登录窗口已关闭，还没有登录。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {desk!=='open'&&<button className="primary" disabled={!connected||desk==='opening'} onClick={()=>void desktop('desktop')}>在电脑上登录</button>}
    {desk!=='open'&&<button disabled={!connected||desk==='opening'} onClick={start}>不在电脑旁，远程登录</button>}
    {desk!=='open'&&<small>“在电脑上登录”会在电脑屏幕上弹出窗口。“远程登录”在这里显示电脑浏览器的画面，点画面就是点电脑上的页面，本设备不访问 claude.ai。</small>}
    {desk==='open'&&<button disabled={!connected} onClick={()=>{setDesk(null);void request.current('claude.artifact.login',{op:'close'}).catch(()=>{});}}>取消</button>}
  </div>;
  return <div className="artifact-login">
    {shot?.signedIn?<div className="artifact-login-done" role="status"><p>已登录 claude.ai。</p><button className="primary" onClick={()=>{void request.current('claude.artifact.login',{op:'close'}).catch(()=>{});done();}}>查看页面</button></div>:
      <p className="muted">点画面操作电脑上的浏览器。遇到“请验证您是真人”，请自己点一下勾选框。邮件里的登录链接可以粘贴到下方打开。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <div className="artifact-screen" ref={screen}>{shot?<img src={shot.image} alt="电脑上的浏览器画面" onPointerUp={tap} style={{aspectRatio:`${shot.width}/${shot.height}`}}/>:<p className="muted">正在打开电脑上的浏览器…</p>}</div>
    <form className="artifact-login-row" onSubmit={e=>{e.preventDefault();if(text){void send({op:'text',text});setText('');}}}>
      <input value={text} onChange={e=>setText(e.target.value)} placeholder="输入到当前选中的输入框" autoComplete="off" disabled={!shot||busy}/>
      <button disabled={!shot||busy||!text}>输入</button>
    </form>
    <div className="artifact-login-keys">
      {(['Enter','Backspace','Tab'] as const).map(key=><button key={key} disabled={!shot||busy} onClick={()=>void send({op:'key',key})}>{({Enter:'回车',Backspace:'退格',Tab:'下一项'} as const)[key]}</button>)}
      <button disabled={!shot||busy} onClick={()=>void send({op:'scroll',dy:400})}>向下滚</button>
      <button disabled={!shot||busy} onClick={()=>void send({op:'scroll',dy:-400})}>向上滚</button>
      <button disabled={!shot||busy} onClick={()=>void send({op:'back'})}>后退</button>
      <button disabled={busy} onClick={()=>void send({op:'frame'})}>刷新画面</button>
    </div>
    <form className="artifact-login-row" onSubmit={e=>{e.preventDefault();if(link.trim()){void send({op:'navigate',url:link.trim()});setLink('');}}}>
      <input value={link} onChange={e=>setLink(e.target.value)} placeholder="粘贴邮件里的 claude.ai 登录链接" inputMode="url" autoComplete="off" disabled={!shot||busy}/>
      <button disabled={!shot||busy||!link.trim()}>打开</button>
    </form>
  </div>;
}
