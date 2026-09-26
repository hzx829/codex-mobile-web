import {useEffect,useRef,useState,type FormEvent,type PointerEvent, type WheelEvent} from 'react';
import {Client} from './client';
import {Icon} from './icons';

export type PreviewSession={sessionId:string;url:string;width:number;height:number;frame?:string};

export function BrowserPreviewPanel({client,session,onClose,onEnded}:{client:Client;session:PreviewSession;onClose:()=>void;onEnded:()=>void}){
  const image=useRef<HTMLImageElement>(null),screen=useRef<HTMLDivElement>(null),pointer=useRef<number|null>(null),lastMove=useRef(0);
  const [text,setText]=useState(''),[hasFrame,setHasFrame]=useState(Boolean(session.frame));
  useEffect(()=>{
    if(session.frame&&image.current)image.current.src=`data:image/jpeg;base64,${session.frame}`;
    return client.onPreview(message=>{
    if(message.type==='preview.disconnected'||message.type==='preview.ended'&&message.sessionId===session.sessionId){onEnded();return;}
    if(message.type==='preview.frame'&&message.sessionId===session.sessionId&&image.current){image.current.src=`data:image/jpeg;base64,${message.data}`;setHasFrame(true);}
    });
  },[client,session.sessionId,onEnded]);
  const send=(input:Record<string,unknown>)=>client.previewInput(session.sessionId,input);
  function point(event:PointerEvent<HTMLDivElement>){
    const rect=screen.current!.getBoundingClientRect(),scale=Math.min(rect.width/session.width,rect.height/session.height);
    const left=rect.left+(rect.width-session.width*scale)/2,top=rect.top+(rect.height-session.height*scale)/2;
    return {x:Math.max(0,Math.min(session.width,Math.round((event.clientX-left)/scale))),y:Math.max(0,Math.min(session.height,Math.round((event.clientY-top)/scale)))};
  }
  function down(event:PointerEvent<HTMLDivElement>){
    if(pointer.current!==null)return;
    pointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);
    send({type:'touchStart',...point(event)});
  }
  function move(event:PointerEvent<HTMLDivElement>){
    if(pointer.current!==event.pointerId||Date.now()-lastMove.current<40)return;
    lastMove.current=Date.now();send({type:'touchMove',...point(event)});
  }
  function end(event:PointerEvent<HTMLDivElement>,cancel=false){
    if(pointer.current!==event.pointerId)return;
    pointer.current=null;send({type:cancel?'touchCancel':'touchEnd'});
  }
  function wheel(event:WheelEvent<HTMLDivElement>){event.preventDefault();send({type:'scroll',deltaX:event.deltaX,deltaY:event.deltaY});}
  function submit(event:FormEvent){event.preventDefault();if(!text)return;send({type:'text',text});setText('');}
  return <div className="browser-preview" role="dialog" aria-modal="true" aria-label="电脑网页预览">
    <header><button aria-label="关闭预览" onClick={onClose}><Icon name="close" size={19}/></button><span title={session.url}>{session.url}</span><button aria-label="返回上一页" onClick={()=>send({type:'back'})}><Icon name="back" size={18}/></button><button aria-label="刷新网页" onClick={()=>send({type:'reload'})}><Icon name="refresh" size={18}/></button></header>
    <div className="browser-screen" ref={screen} onPointerDown={down} onPointerMove={move} onPointerUp={event=>end(event)} onPointerCancel={event=>end(event,true)} onWheel={wheel}>
      {!hasFrame&&<p>正在打开电脑网页…</p>}
      <img ref={image} alt="电脑浏览器画面" draggable={false}/>
    </div>
    <form className="browser-keyboard" onSubmit={submit}><input aria-label="输入到网页当前焦点" value={text} onChange={event=>setText(event.target.value)} placeholder="点击页面输入框后，在这里输入"/><button type="submit" disabled={!text}>输入</button><button type="button" aria-label="退格" onClick={()=>send({type:'key',key:'Backspace'})}>⌫</button><button type="button" aria-label="回车" onClick={()=>send({type:'key',key:'Enter'})}>↵</button></form>
  </div>;
}
