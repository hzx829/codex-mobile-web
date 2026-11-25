import {useEffect,useRef} from 'react';

/**
 * System notifications for the open conversation: when its turn ends, or it starts waiting for an
 * approval, while this page is in a background tab or another window has focus. Only a page that
 * is still running can notice that, so a phone that froze the page gets nothing (that needs Web Push).
 */
const KEY='turn-notify';
const supported=()=>typeof window!=='undefined'&&'Notification' in window&&window.isSecureContext;
function stored(){try{return localStorage.getItem(KEY)==='on';}catch{return false;}}
function store(on:boolean){try{if(on)localStorage.setItem(KEY,'on');else localStorage.removeItem(KEY);}catch{}}

export type NotifyState='on'|'off'|'blocked'|'unsupported';
export function notifyState():NotifyState{
  if(!supported())return 'unsupported';
  if(Notification.permission==='denied')return 'blocked';
  return stored()&&Notification.permission==='granted'?'on':'off';
}
export const notifyLabel:Record<NotifyState,string>={on:'已开启',off:'已关闭',blocked:'浏览器已阻止',unsupported:'当前浏览器不支持'};
/** What the menu explains after a tap; empty when the switch itself says enough. */
export const notifyHint:Record<NotifyState,string>={
  on:'当前会话这一轮结束或等待确认时，若你不在这个页面，会弹出系统通知。',
  off:'',
  blocked:'浏览器已阻止本站通知，请在地址栏左侧的网站设置里允许通知后再开启。',
  unsupported:'当前浏览器不支持网页通知，或页面不是通过 HTTPS 打开的。',
};
/** Turns notifications on (asking the browser when needed) or off. Call from a tap: browsers ignore a request without one. */
export async function toggleNotify():Promise<NotifyState>{
  if(!supported())return 'unsupported';
  if(notifyState()==='on'){store(false);return 'off';}
  if(Notification.permission==='default')await Notification.requestPermission();
  if(Notification.permission!=='granted')return notifyState();
  store(true);return 'on';
}

/** Whether a hidden page should keep reading the open conversation, so it notices the running turn end. */
export const watchWhileHidden=(running:unknown)=>Boolean(running)&&notifyState()==='on';
const away=()=>document.visibilityState!=='visible'||!document.hasFocus();

export type TurnEnd={service:string;title?:string;status?:string;reply?:string;error?:string};
const clip=(text:string,max:number)=>{const flat=text.replace(/\s+/g,' ').trim();return flat.length>max?flat.slice(0,max-1)+'…':flat;};
/** The notification for a turn that ended: the conversation as title, the outcome and the start of the last reply as body. */
export function turnEndNotice({service,title,status,reply,error}:TurnEnd){
  const outcome=status==='failed'?'出错了':status==='interrupted'?'已停止':'已完成';
  const detail=status==='failed'?error||reply:reply;
  return {title:clip(title||service,60),body:`${service} ${outcome}${detail?`：${clip(detail,140)}`:''}`};
}
export function waitingNotice(service:string,title?:string){return {title:clip(title||service,60),body:`${service} 正在等待你确认`};}

let plainTitle='';
function markTitle(){
  if(!plainTitle)plainTitle=document.title;
  document.title=`● ${plainTitle}`;
  const clear=()=>{if(away())return;document.title=plainTitle;plainTitle='';document.removeEventListener('visibilitychange',clear);window.removeEventListener('focus',clear);};
  document.addEventListener('visibilitychange',clear);window.addEventListener('focus',clear);
}
/** Shows one notification; `tag` keeps one per conversation when several tabs have it open. */
async function show(notice:{title:string;body:string},tag:string){
  markTitle();
  const options={body:notice.body,tag,icon:'/icon.svg'};
  try{
    const note=new Notification(notice.title,options);
    note.onclick=()=>{window.focus();note.close();};
  }catch{
    // Android Chrome only shows notifications through the service worker.
    try{await (await navigator.serviceWorker?.getRegistration())?.showNotification(notice.title,options);}catch{}
  }
}

/** One conversation as last seen: `running` is undefined until it has been read. */
export type Seen={key:string;running?:boolean;waiting:number};
/** What changed between two readings worth a notification: a turn that ended, or a new approval waiting. */
export function turnChange(before:Seen,now:Seen):'end'|'waiting'|null{
  if(before.key!==now.key||before.running===undefined||now.running===undefined)return null;
  if(before.running&&!now.running)return 'end';
  return now.waiting>before.waiting?'waiting':null;
}

/**
 * Notifies when the open conversation's turn ends or a new approval waits, while the user is away.
 * `key` names the conversation; `running` is undefined while it is not read yet, so opening a
 * conversation, or switching to another, never counts as an end.
 */
export function useTurnNotice(key:string,running:boolean|undefined,waiting:number,end:()=>TurnEnd){
  const last=useRef<Seen>({key,waiting:0});
  const ended=useRef(end);ended.current=end;
  useEffect(()=>{
    const now={key,running,waiting},change=turnChange(last.current,now);
    if(running!==undefined||last.current.key!==key)last.current=now;
    if(!change||notifyState()!=='on'||!away())return;
    const info=ended.current();
    void show(change==='end'?turnEndNotice(info):waitingNotice(info.service,info.title),key);
  },[key,running,waiting]);
}
