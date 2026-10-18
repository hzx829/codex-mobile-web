import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {VoiceProvider} from '../src/shared/voice';
import {createVoiceInput,type VoiceInput,type VoiceState,type VoiceCallbacks} from './voice-input';

export function useVoiceInput(provider:VoiceProvider,scope:string,connected:boolean,callbacks:Omit<VoiceCallbacks,'state'>){
  const [state,setState]=useState<VoiceState>('idle'),active=useRef<VoiceInput|null>(null);
  const latest=useRef(callbacks);latest.current=callbacks;
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
    const input=createVoiceInput(provider,{
      state:next=>{if(active.current===input){stateRef.current=next;setState(next);if(next==='idle')active.current=null;}},
      text:text=>{if(active.current===input)latest.current.text(text);},
      error:error=>{if(active.current===input)latest.current.error(error);},
      keyboard:()=>latest.current.keyboard(),
      transcribe:recording=>latest.current.transcribe(recording),
    });
    active.current=input;input.start();
  }
  return {state,start,stop:()=>active.current?.stop(),cancel};
}
