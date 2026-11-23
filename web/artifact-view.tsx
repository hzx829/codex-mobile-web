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

const EMAIL_KEY='cmw.claude-signin-email';
const remembered=()=>{try{return localStorage.getItem(EMAIL_KEY)||'';}catch{return '';}};
const remember=(email:string)=>{try{localStorage.setItem(EMAIL_KEY,email);}catch{}};
/** An older connector answers new sign-in operations with this. */
const outdated=(e:unknown)=>(e as {code?:string;message?:string})?.code==='invalid'&&(e as Error)?.message==='登录操作无效';

/**
 * Signs the computer's browser in to claude.ai. First by email: the connector's browser asks claude.ai for the email,
 * and the link or code it brings is handed back here. Otherwise in a window on the computer's own screen, by remote
 * control (screenshots here, taps and typing sent back), or with a session cookie pasted from a signed-in browser.
 */
function ArtifactSignIn({call,connected,done}:{call:Call;connected:boolean;done:()=>void}){
  const [shot,setShot]=useState<Json|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[text,setText]=useState(''),[link,setLink]=useState(''),[started,setStarted]=useState(false);
  const [desk,setDesk]=useState<'opening'|'open'|'closed'|null>(null);
  const [email,setEmail]=useState(remembered),[stage,setStage]=useState<'email'|'sent'|'mfa'>('email'),[answer,setAnswer]=useState(''),[cookie,setCookie]=useState('');
  const [waiting,setWaiting]=useState(false),[stuck,setStuck]=useState(''),[more,setMore]=useState(false);
  const screen=useRef<HTMLDivElement>(null),lock=useRef(false),alive=useRef(true),request=useRef(call);request.current=call;
  /** Runs one step of the email or cookie sign-in and moves to what the computer reports. */
  async function step(payload:Json){
    if(lock.current)return;lock.current=true;setWaiting(true);setError('');setStuck('');
    try{
      const result=await request.current('claude.artifact.login',payload);
      if(!alive.current)return;
      if(result.signedIn){done();return;}
      if(result.stage==='sent'){setStage('sent');setAnswer('');}
      else if(result.stage==='mfa'){setStage('mfa');setAnswer('');}
      else if(result.stage==='blocked')setStuck(result.message||'claude.ai 的登录页没有继续');
      else setError(result.message||'登录没有成功');
    }catch(e){if(alive.current)setError(outdated(e)?'这台电脑上的连接器还不支持这种登录方式，请先更新连接器。':(e as Error)?.message||'操作失败');}
    finally{lock.current=false;if(alive.current)setWaiting(false);}
  }
  function sendEmail(){const value=email.trim();if(!value)return;remember(value);void step({op:'email',email:value});}
  /** The remote screen; `resume` picks up the tab the email sign-in was using, to see where it stopped. */
  async function remote(resume:boolean){
    setStarted(true);setStuck('');
    if(resume){
      try{const next=await request.current('claude.artifact.login',{op:'frame'});if(alive.current){setShot(next);return;}}catch{}
      if(!alive.current)return;
    }
    start();
  }
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
  if(!started&&(desk==='open'||desk==='opening'))return <div className="preview-empty artifact-login-intro">
    <p role="status">{desk==='opening'?'正在电脑上打开登录窗口…':'电脑屏幕上已打开登录窗口，请在那里登录 claude.ai。登录完成后这里会自动显示页面。'}</p>
    {desk==='open'&&<button disabled={!connected} onClick={()=>{setDesk(null);void request.current('claude.artifact.login',{op:'close'}).catch(()=>{});}}>取消</button>}
  </div>;
  const off=!connected||waiting;
  if(!started)return <div className="artifact-login artifact-login-intro">
    <p>这台电脑的中转浏览器还没有登录 claude.ai。登录一次即可，登录信息只保存在电脑上连接器的数据目录里。</p>
    {stage==='email'?<>
      <form className="artifact-login-row" onSubmit={e=>{e.preventDefault();sendEmail();}}>
        <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="claude.ai 账号的邮箱" autoComplete="email" inputMode="email" disabled={off} aria-label="claude.ai 账号的邮箱"/>
        <button className="primary" disabled={off||!email.trim()}>{waiting?'正在发送…':'发送登录邮件'}</button>
      </form>
      <small>电脑上的浏览器会在 claude.ai 的登录页替你填好邮箱，claude.ai 随后发来登录邮件。</small>
    </>:<>
      <p role="status">{stage==='mfa'?'这个账号开了双重验证，请输入验证器里的验证码。':<>登录邮件已发到 <b>{email}</b>。</>}</p>
      {stage==='sent'&&<small>在手机或任意设备上打开邮件里的链接，它会显示一个验证码，填到下面即可。也可以复制这个链接，直接粘贴到下面。</small>}
      <form className="artifact-login-row" onSubmit={e=>{e.preventDefault();if(answer.trim())void step({op:'code',code:answer.trim()});}}>
        <input value={answer} onChange={e=>setAnswer(e.target.value)} placeholder={stage==='mfa'?'双重验证码':'验证码或登录链接'} autoComplete="one-time-code" disabled={off} aria-label={stage==='mfa'?'双重验证码':'验证码或登录链接'}/>
        <button className="primary" disabled={off||!answer.trim()}>{waiting?'正在登录…':'登录'}</button>
      </form>
      {stage==='sent'&&<div className="artifact-login-keys">
        <button type="button" disabled={off} onClick={sendEmail}>重新发送</button>
        <button type="button" disabled={waiting} onClick={()=>{setStage('email');setError('');setStuck('');}}>换个邮箱</button>
      </div>}
    </>}
    {error&&<p className="error" role="alert">{error}</p>}
    {stuck&&<div className="artifact-login-stuck" role="status"><p>{stuck}</p><button type="button" disabled={!connected} onClick={()=>void remote(true)}>改用远程画面</button></div>}
    {desk==='closed'&&<p role="status">电脑上的登录窗口已关闭，还没有登录。</p>}
    <details className="artifact-login-more" open={more} onToggle={e=>setMore(e.currentTarget.open)}>
      <summary>其他登录方式</summary>
      <div className="artifact-login-keys">
        <button type="button" disabled={off} onClick={()=>void desktop('desktop')}>在电脑屏幕上打开登录窗口</button>
        <button type="button" disabled={off} onClick={()=>void remote(false)}>远程画面登录</button>
      </div>
      <small>“远程画面”在这里显示电脑浏览器的画面，点画面就是点电脑上的页面，本设备不访问 claude.ai。</small>
      <form className="artifact-login-row" onSubmit={e=>{e.preventDefault();if(cookie.trim()){const value=cookie;setCookie('');void step({op:'cookie',value});}}}>
        <input type="password" value={cookie} onChange={e=>setCookie(e.target.value)} placeholder="粘贴 sessionKey（sk-ant-…）" autoComplete="off" disabled={off} aria-label="claude.ai 的 sessionKey"/>
        <button disabled={off||!cookie.trim()}>使用</button>
      </form>
      <small>保底方式：在已登录 claude.ai 的浏览器里按 F12，打开 Application → Cookies → https://claude.ai，复制 sessionKey 的值粘贴到上面。它等同于账号的登录凭据，只在自己的设备上粘贴。</small>
    </details>
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
      <button disabled={busy} onClick={()=>{setStarted(false);setShot(null);setError('');void request.current('claude.artifact.login',{op:'close'}).catch(()=>{});}}>返回邮箱登录</button>
    </div>
    <form className="artifact-login-row" onSubmit={e=>{e.preventDefault();if(link.trim()){void send({op:'navigate',url:link.trim()});setLink('');}}}>
      <input value={link} onChange={e=>setLink(e.target.value)} placeholder="粘贴邮件里的 claude.ai 登录链接" inputMode="url" autoComplete="off" disabled={!shot||busy}/>
      <button disabled={!shot||busy||!link.trim()}>打开</button>
    </form>
  </div>;
}
