/**
 * Paced reveal for a reply that is still streaming.
 *
 * Live frames arrive in lumps: the connector merges what the model wrote in each
 * window into one frame. Painting each frame as it lands makes those lumps visible.
 * So a frame only moves the target, and each animation frame shows a share of the
 * backlog: a burst makes the text catch up faster instead of jumping.
 *
 * The view keeps the full text; only what is painted is paced. Text seen for the
 * first time (opening a session, a snapshot) is shown whole, and everything is shown
 * once the turn ends.
 *
 * Adapted from Paseo's packages/app/src/agent-stream/text-reveal.ts
 * (https://github.com/getpaseo/paseo, Copyright Paseo contributors, Apache-2.0).
 */
import {useEffect,useReducer,useRef} from 'react';

/** The backlog is drained over this horizon; longer adds lag at the end of a reply. */
export const REVEAL_HORIZON_MS=150;
/** At most one paint per 60 Hz frame, even on faster displays. */
export const REVEAL_FRAME_MS=1000/60;
/** A stalled frame (hidden tab, busy main thread) counts as this long at most. */
const MAX_ELAPSED_MS=250;

/** Characters to release this frame: a share of the backlog, at least one so the tail finishes. */
export function revealStep(backlog:number,elapsedMs:number,horizonMs=REVEAL_HORIZON_MS):number {
  if(backlog<=0)return 0;
  if(horizonMs<=0)return backlog;
  const elapsed=Math.min(Math.max(elapsedMs,0),MAX_ELAPSED_MS);
  if(elapsed<=0)return 0;
  if(elapsed>=horizonMs)return backlog;
  return Math.min(backlog,Math.max(1,Math.ceil(backlog*elapsed/horizonMs)));
}

export type RevealState={readonly target:string;readonly shown:number};

/**
 * Points the reveal at the latest text. Growth of the same text is paced; text seen for
 * the first time, or text that no longer starts with what is on screen, is shown whole.
 */
export function retarget(state:RevealState|undefined,text:string):RevealState {
  if(!state)return {target:text,shown:text.length};
  if(state.target===text)return state;
  if(!text.startsWith(state.target.slice(0,state.shown)))return {target:text,shown:text.length};
  return {target:text,shown:Math.min(state.shown,text.length)};
}

export function advance(state:RevealState,elapsedMs:number):RevealState {
  const step=revealStep(state.target.length-state.shown,elapsedMs);
  return step?{target:state.target,shown:state.shown+step}:state;
}

const segmenter=typeof Intl!=='undefined'&&typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):null;

/** Pulls a cut back to the start of the character it would split, so an emoji or CJK cluster never paints in halves. */
export function safeCut(text:string,index:number):number {
  if(index<=0)return 0;
  if(index>=text.length)return text.length;
  if(segmenter){
    // Segment only around the cut: a long reply would otherwise be re-segmented on every frame.
    const start=Math.max(0,index-32);
    const segment=segmenter.segment(text.slice(start,index+32)).containing(index-start);
    return segment?start+segment.index:index;
  }
  const unit=text.charCodeAt(index);
  return unit>=0xdc00&&unit<=0xdfff?index-1:index;
}

/** What to paint now. */
export function visibleText(state:RevealState):string {
  return state.shown>=state.target.length?state.target:state.target.slice(0,safeCut(state.target,state.shown));
}

/**
 * The part of `text` to paint while `streaming`; all of it otherwise. Re-renders the
 * caller on animation frames until the shown text catches up.
 */
export function usePacedText(text:string,streaming:boolean):string {
  const state=useRef<RevealState|undefined>(undefined);
  const [,repaint]=useReducer((count:number)=>count+1,0);
  state.current=streaming?retarget(state.current,text):{target:text,shown:text.length};
  const behind=state.current.shown<state.current.target.length;
  useEffect(()=>{
    if(!behind)return;
    let frame=0,last:number|null=null;
    const tick=(now:number)=>{
      const elapsed=last===null?REVEAL_FRAME_MS:now-last;
      if(elapsed>=REVEAL_FRAME_MS){
        last=now-elapsed%REVEAL_FRAME_MS;
        const current=state.current!,next=advance(current,elapsed);
        if(next!==current){state.current=next;repaint();}
        if(next.shown>=next.target.length)return;
      }
      frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(frame);
  },[behind,text]);
  return visibleText(state.current);
}
