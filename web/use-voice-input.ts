import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {Json,RequestAction} from '../src/shared/types';
import type {VoiceProvider} from '../src/shared/voice';
import {applyDictation,createVoiceInput,joinDictation,type DictationSpan,type VoiceInput,type VoiceState} from './voice-input';

export interface VoiceHost {
  keyboard:()=>void;
  error:(error:Error)=>void;
  /** Sends a request to the selected computer. */
  request:(action:RequestAction,payload:Json)=>Promise<any>;
  draft:()=>string;
  setDraft:(value:string)=>void;
}

export function useVoiceInput(provider:VoiceProvider,scope:string,connected:boolean,host:VoiceHost){
  const [state,setState]=useState<VoiceState>('idle'),active=useRef<VoiceInput|null>(null);
  const latest=useRef(host);latest.current=host;
  const stateRef=useRef(state);stateRef.current=state;
  function cancel(){const input=active.current;active.current=null;input?.cancel();setState('idle');}
  useLayoutEffect(()=>{cancel();return cancel;},[provider,scope,connected]);
  useEffect(()=>{
    const hide=()=>{if(document.visibilityState==='hidden'&&['starting','recording'].includes(stateRef.current))cancel();};
    document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',cancel);
    return()=>{document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',cancel);};
  },[]);
  function start(){
    if(active.current)return;
    let span:DictationSpan=null;
    // The draft this dictation last wrote: until the page renders it, the host still reports the one before.
    let written:{before:string;after:string}|null=null;
    const current=()=>{const draft=latest.current.draft();return written&&draft===written.before?written.after:draft;};
    const write=(value:string)=>{const before=latest.current.draft();if(value===before)return;written={before,after:value};latest.current.setDraft(value);};
    const input=createVoiceInput(provider,{
      state:next=>{if(active.current===input){stateRef.current=next;setState(next);if(next==='idle')active.current=null;}},
      text:text=>{if(active.current===input)write(joinDictation(current(),text));},
      live:text=>{if(active.current!==input)return;const next=applyDictation(current(),span,text);span=next.span;write(next.draft);},
      error:error=>{if(active.current===input)latest.current.error(error);},
      keyboard:()=>latest.current.keyboard(),
      transcribe:recording=>latest.current.request('voice.transcribe',recording),
      stream:(action,payload)=>latest.current.request(action,payload),
    });
    active.current=input;input.start();
  }
  return {state,start,stop:()=>active.current?.stop(),cancel};
}
