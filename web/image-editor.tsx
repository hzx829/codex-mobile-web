import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type KeyboardEvent,type PointerEvent} from 'react';
import {createPortal} from 'react-dom';
import {Icon} from './icons';
import {IconButton} from './icon-button';
import {NO_EDITS,addEdit,appliedEdits,cropHandleAt,cropOf,dragCrop,drawStroke,fitScale,redoEdit,renderEdits,roundRect,sameRect,strokesOf,undoEdit,type CropHandle,type Point,type Rect,type Stroke} from './image-edit';

/** Pen colors. Red comes first: it stands out on white screenshots and on photos alike. */
const COLORS=[['#ff3b30','红色'],['#ffcc00','黄色'],['#34c759','绿色'],['#0a84ff','蓝色'],['#ffffff','白色'],['#111111','黑色']] as const;
/** The pen's width on screen in CSS pixels, whatever the photo's size. */
const PEN=5;
/** Room around the photo: strokes then never start at the screen edge, where phones take a swipe as "back"; cropping needs a little more for the corner handles. */
const MARGIN=16,CROP_MARGIN=24;

type Props={
  src:string;label:string;
  /** Puts the edited photo in the composer; resolves to '' or what went wrong, which the editor shows. */
  save:(file:File)=>Promise<string>;
  remove:()=>void;close:()=>void;
};

/**
 * A photo waiting in the composer, full screen: draw on it, crop it, undo and redo either, then ✓ to put the result in its place.
 * Marking is the default, as in photo apps' markup; the crop button switches to a box with corner handles.
 */
export function ImageEditor({src,label,save,remove,close}:Props){
  const [image,setImage]=useState<HTMLImageElement|null>(null),[loadError,setLoadError]=useState('');
  const [history,setHistory]=useState(NO_EDITS),[color,setColor]=useState<string>(COLORS[0][0]);
  // While cropping: the box being adjusted, in photo pixels. Null while marking.
  const [selection,setSelection]=useState<Rect|null>(null);
  const [box,setBox]=useState({width:0,height:0}),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDivElement>(null),stage=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  const pen=useRef<{pointer:number;stroke:Stroke}|null>(null),drag=useRef<{pointer:number;handle:CropHandle;start:Rect;x:number;y:number}|null>(null);

  useEffect(()=>{
    let live=true;const element=document.createElement('img');
    element.onload=()=>{if(live)setImage(element);};element.onerror=()=>{if(live)setLoadError('无法读取这张图片');};element.src=src;
    return()=>{live=false;element.onload=element.onerror=null;};
  },[src]);
  useLayoutEffect(()=>{
    const element=stage.current;if(!element)return;
    const measure=()=>{const width=element.clientWidth||0,height=element.clientHeight||0;setBox(old=>old.width===width&&old.height===height?old:{width,height});};
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();
    return()=>{if(previous?.isConnected)previous.focus();};
  },[]);

  const ops=appliedEdits(history),width=image?.naturalWidth||0,height=image?.naturalHeight||0;
  const whole={x:0,y:0,width,height},crop=cropOf(ops,width,height);
  // Marking shows the part that is kept; cropping shows the whole photo with the box over it.
  const region=selection?whole:crop,margin=selection?CROP_MARGIN:MARGIN;
  const scale=fitScale(region,{width:box.width-margin*2,height:box.height-margin*2});
  const view={width:Math.round(region.width*scale),height:Math.round(region.height*scale)};

  // The canvas is drawn in photo pixels: the transform maps them to the screen, sharp on high-density screens.
  useLayoutEffect(()=>{
    const element=canvas.current;if(!element||!image||!scale)return;
    const ratio=window.devicePixelRatio||1;
    element.width=Math.round(view.width*ratio);element.height=Math.round(view.height*ratio);
    const context=element.getContext('2d');if(!context)return;
    context.setTransform(scale*ratio,0,0,scale*ratio,-region.x*scale*ratio,-region.y*scale*ratio);
    context.drawImage(image,0,0);
    for(const stroke of strokesOf(ops))drawStroke(context,stroke);
  },[image,history,selection===null,scale]);

  const toPhoto=(event:{clientX:number;clientY:number}):Point=>{const rect=canvas.current!.getBoundingClientRect();return {x:region.x+(event.clientX-rect.left)/scale,y:region.y+(event.clientY-rect.top)/scale};};
  function down(event:PointerEvent<HTMLDivElement>){
    if(!image||!scale||saving||pen.current||drag.current||!event.isPrimary||event.button>0||!canvas.current)return;
    const rect=canvas.current.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
    if(selection){
      const handle=cropHandleAt({x:selection.x*scale,y:selection.y*scale,width:selection.width*scale,height:selection.height*scale},{x,y});
      if(!handle)return;
      drag.current={pointer:event.pointerId,handle,start:selection,x:event.clientX,y:event.clientY};
    }else{
      if(x<0||y<0||x>rect.width||y>rect.height)return;
      const stroke:Stroke={color,width:PEN/scale,points:[toPhoto(event)]};
      pen.current={pointer:event.pointerId,stroke};
      const context=canvas.current.getContext('2d');if(context)drawStroke(context,stroke);
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);event.preventDefault();
  }
  function move(event:PointerEvent<HTMLDivElement>){
    if(pen.current?.pointer===event.pointerId){
      // The stroke so far is drawn piece by piece; the whole photo is drawn again once it is finished.
      const {stroke}=pen.current,context=canvas.current?.getContext('2d'),native=event.nativeEvent;
      const coalesced=native.getCoalescedEvents?.()||[];
      for(const each of coalesced.length?coalesced:[native]){
        const point=toPhoto(each),last=stroke.points.at(-1)!;
        if(Math.hypot(point.x-last.x,point.y-last.y)*scale<1)continue;
        stroke.points.push(point);
        if(context)drawStroke(context,{...stroke,points:[last,point]});
      }
    }else if(drag.current?.pointer===event.pointerId){
      const {start,handle,x,y}=drag.current;
      setSelection(dragCrop(start,handle,(event.clientX-x)/scale,(event.clientY-y)/scale,whole,48/scale));
    }
  }
  function up(event:PointerEvent<HTMLDivElement>){
    if(pen.current?.pointer===event.pointerId){const {stroke}=pen.current;pen.current=null;setHistory(old=>addEdit(old,{kind:'stroke',stroke}));}
    if(drag.current?.pointer===event.pointerId)drag.current=null;
  }

  function applyCrop(){
    if(!selection)return;
    const rect=roundRect(selection);
    if(!sameRect(rect,crop))setHistory(old=>addEdit(old,{kind:'crop',rect}));
    setSelection(null);
  }
  const changed=history.at>0;
  function dismiss(){
    if(saving)return;
    if(changed&&!window.confirm('放弃对这张图片的修改？'))return;
    close();
  }
  async function done(){
    if(!image||saving)return;
    if(!changed){close();return;}
    setSaving(true);setError('');
    try{const problem=await save(await renderEdits(image,ops));if(problem)setError(problem);}
    catch(e){setError((e as Error)?.message||'图片保存失败');}
    finally{setSaving(false);}
  }
  function key(event:KeyboardEvent<HTMLDivElement>){
    if(event.key==='Escape'){event.preventDefault();if(selection)setSelection(null);else dismiss();return;}
    if((event.ctrlKey||event.metaKey)&&!selection&&!saving&&(event.key==='z'||event.key==='Z'||event.key==='y')){
      event.preventDefault();setHistory(event.key==='y'||event.shiftKey?redoEdit:undoEdit);return;
    }
    if(event.key!=='Tab')return;
    const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled)')||[]),first=nodes[0],last=nodes.at(-1);
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }

  return createPortal(<div ref={dialog} className="image-editor" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={key}>
    <header className="image-editor-bar">
      {selection?<>
        <button type="button" onClick={()=>setSelection(null)}>取消</button>
        <strong>裁剪</strong>
        <button type="button" disabled={sameRect(selection,whole)} onClick={()=>setSelection(whole)}>还原</button>
      </>:<>
        <IconButton icon="close" label="关闭" disabled={saving} onClick={dismiss}/>
        <div className="image-editor-history">
          <IconButton icon="undo" label="撤销" disabled={saving||!history.at} onClick={()=>setHistory(undoEdit)}/>
          <IconButton icon="redo" label="重做" disabled={saving||history.at===history.ops.length} onClick={()=>setHistory(redoEdit)}/>
        </div>
        <IconButton icon="crop" label="裁剪" disabled={saving||!image} onClick={()=>setSelection(crop)}/>
      </>}
    </header>
    <div ref={stage} className={`image-editor-stage${selection?' cropping':''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {loadError?<p className="image-editor-note" role="alert">{loadError}</p>:<div className="image-editor-canvas" style={{width:view.width,height:view.height}}>
        <canvas ref={canvas} role="img" aria-label={selection?'拖动四角或边框调整裁剪范围':'在图上涂画即可标记'}/>
        {selection&&<div className="image-editor-crop" style={{left:selection.x*scale,top:selection.y*scale,width:selection.width*scale,height:selection.height*scale}}>
          {['nw','ne','sw','se'].map(corner=><i key={corner} data-corner={corner}/>)}</div>}
      </div>}
    </div>
    <footer className="image-editor-tools">
      {error?<p className="image-editor-error" role="alert">{error}</p>:!selection&&!history.ops.length&&image&&<p className="image-editor-note">在图上涂画即可标记</p>}
      {selection?<div className="image-editor-actions"><span/><button type="button" className="image-editor-done" aria-label="应用裁剪" onClick={applyCrop}><Icon name="check"/></button><span/></div>:<>
        <div className="image-editor-colors" role="radiogroup" aria-label="画笔颜色">{COLORS.map(([value,name])=>
          <button type="button" key={value} role="radio" aria-checked={color===value} aria-label={name} title={name} style={{'--swatch':value} as CSSProperties} onClick={()=>setColor(value)}/>)}</div>
        <div className="image-editor-actions">
          <IconButton icon="trash" label="移除这张图片" disabled={saving} onClick={remove}/>
          <button type="button" className="image-editor-done" aria-label={saving?'正在保存':'完成'} aria-busy={saving} disabled={!image||saving} onClick={()=>void done()}><Icon name="check"/></button>
          <span/>
        </div>
      </>}
    </footer>
  </div>,document.body);
}
