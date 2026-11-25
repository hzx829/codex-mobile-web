/**
 * Edits to a photo waiting in the composer: pen strokes and a crop, kept as a list so each can be undone and redone.
 * Coordinates are the photo's own pixels, so a stroke stays where it was drawn whatever the crop or the screen.
 */
export type Point={x:number;y:number};
export type Rect={x:number;y:number;width:number;height:number};
export type Stroke={color:string;width:number;points:Point[]};
export type EditOp={kind:'stroke';stroke:Stroke}|{kind:'crop';rect:Rect};
/** `at`: how many of `ops` are applied; the rest were undone and can be redone until something new is added. */
export type EditHistory={ops:EditOp[];at:number};
export type CropHandle='move'|'n'|'s'|'e'|'w'|'nw'|'ne'|'sw'|'se';

export const NO_EDITS:EditHistory={ops:[],at:0};
export const addEdit=(history:EditHistory,op:EditOp):EditHistory=>({ops:[...history.ops.slice(0,history.at),op],at:history.at+1});
export const undoEdit=(history:EditHistory):EditHistory=>history.at?{...history,at:history.at-1}:history;
export const redoEdit=(history:EditHistory):EditHistory=>history.at<history.ops.length?{...history,at:history.at+1}:history;
export const appliedEdits=(history:EditHistory)=>history.ops.slice(0,history.at);

/** The part of the photo that is kept: the latest crop, else all of it. */
export function cropOf(ops:EditOp[],width:number,height:number):Rect{
  for(let index=ops.length-1;index>=0;index--){const op=ops[index];if(op.kind==='crop')return op.rect;}
  return {x:0,y:0,width,height};
}
export const strokesOf=(ops:EditOp[])=>ops.flatMap(op=>op.kind==='stroke'?[op.stroke]:[]);
export const sameRect=(a:Rect,b:Rect)=>Math.round(a.x)===Math.round(b.x)&&Math.round(a.y)===Math.round(b.y)&&Math.round(a.width)===Math.round(b.width)&&Math.round(a.height)===Math.round(b.height);
export const roundRect=(rect:Rect):Rect=>{const x=Math.round(rect.x),y=Math.round(rect.y);return {x,y,width:Math.max(1,Math.round(rect.x+rect.width)-x),height:Math.max(1,Math.round(rect.y+rect.height)-y)};};

/** Screen pixels per photo pixel to show `region` whole inside `box`; small photos are enlarged at most `limit` times. */
export function fitScale(region:{width:number;height:number},box:{width:number;height:number},limit=4){
  if(region.width<=0||region.height<=0||box.width<=0||box.height<=0)return 0;
  return Math.min(box.width/region.width,box.height/region.height,limit);
}

/** What a press at `point` grabs on a crop box drawn at `rect` (both in screen pixels): a corner, an edge, the inside, or nothing. */
export function cropHandleAt(rect:Rect,point:Point,reach=22):CropHandle|null{
  const right=rect.x+rect.width,bottom=rect.y+rect.height;
  if(point.x<rect.x-reach||point.x>right+reach||point.y<rect.y-reach||point.y>bottom+reach)return null;
  // A small box keeps its middle for moving: each side reaches at most a third of the way in.
  const reachX=Math.min(reach,rect.width/3),reachY=Math.min(reach,rect.height/3);
  const west=point.x<rect.x+reachX,east=point.x>right-reachX,north=point.y<rect.y+reachY,south=point.y>bottom-reachY;
  const vertical=north?'n':south?'s':'',horizontal=west?'w':east?'e':'';
  if(vertical||horizontal)return (vertical+horizontal) as CropHandle;
  return 'move';
}

/** The crop box after dragging `handle` by (dx, dy) photo pixels from `start`, kept inside the photo and at least `min` on each side. */
export function dragCrop(start:Rect,handle:CropHandle,dx:number,dy:number,bounds:{width:number;height:number},min:number):Rect{
  const clamp=(value:number,low:number,high:number)=>Math.min(Math.max(value,low),Math.max(low,high));
  const minWidth=Math.min(min,bounds.width),minHeight=Math.min(min,bounds.height);
  if(handle==='move')return {...start,x:clamp(start.x+dx,0,bounds.width-start.width),y:clamp(start.y+dy,0,bounds.height-start.height)};
  let left=start.x,top=start.y,right=start.x+start.width,bottom=start.y+start.height;
  if(handle.includes('w'))left=clamp(left+dx,0,right-minWidth);
  if(handle.includes('e'))right=clamp(right+dx,left+minWidth,bounds.width);
  if(handle.includes('n'))top=clamp(top+dy,0,bottom-minHeight);
  if(handle.includes('s'))bottom=clamp(bottom+dy,top+minHeight,bounds.height);
  return {x:left,y:top,width:right-left,height:bottom-top};
}

/** Draws a stroke in photo pixels on a context already transformed to them. A single tap leaves a dot. */
export function drawStroke(context:CanvasRenderingContext2D,stroke:Stroke){
  const [first,...rest]=stroke.points;if(!first)return;
  context.strokeStyle=context.fillStyle=stroke.color;context.lineWidth=stroke.width;context.lineCap='round';context.lineJoin='round';
  if(!rest.length){context.beginPath();context.arc(first.x,first.y,stroke.width/2,0,Math.PI*2);context.fill();return;}
  context.beginPath();context.moveTo(first.x,first.y);for(const point of rest)context.lineTo(point.x,point.y);context.stroke();
}

/** The edited photo at full resolution: the kept part with the strokes on it. */
export async function renderEdits(image:HTMLImageElement,ops:EditOp[]):Promise<File>{
  const crop=roundRect(cropOf(ops,image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');
  try{
    canvas.width=crop.width;canvas.height=crop.height;
    const context=canvas.getContext('2d');if(!context)throw Error('浏览器无法编辑图片');
    context.translate(-crop.x,-crop.y);context.drawImage(image,0,0);
    for(const stroke of strokesOf(ops))drawStroke(context,stroke);
    // WebP where the browser can write it (as the photo compression does); browsers that cannot hand back PNG.
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',.92));
    if(!blob)throw Error('图片保存失败');
    return new File([blob],'edited-image',{type:blob.type||'image/png'});
  }finally{canvas.width=canvas.height=0;}
}
