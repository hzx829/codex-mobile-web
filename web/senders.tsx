import {createContext,useContext,useMemo,type ReactNode} from 'react';
import type {TeamMember} from '../src/shared/types';

/** The signed-in member, and whether the open session names the sender above each message. */
const SenderContext=createContext<{me:string|null;shown:boolean}>({me:null,shown:false});

/** True once someone other than `me` sent a message in this session; a session of one person stays unlabeled. */
export function sendersShown(me:string|null|undefined,senders:(TeamMember|undefined)[]){
  return Boolean(me)&&senders.some(sender=>sender&&sender.id!==me);
}

/** Provides the signed-in member to every session below. */
export function SenderRoot({me,children}:{me:string|null|undefined;children:ReactNode}){
  const value=useMemo(()=>({me:me||null,shown:false}),[me]);
  return <SenderContext.Provider value={value}>{children}</SenderContext.Provider>;
}

/** One session's messages: labels appear on all of them when more than one member took part. */
export function SenderScope({senders,children}:{senders:(TeamMember|undefined)[];children:ReactNode}){
  const {me}=useContext(SenderContext);
  const shown=sendersShown(me,senders);
  const value=useMemo(()=>({me,shown}),[me,shown]);
  return <SenderContext.Provider value={value}>{children}</SenderContext.Provider>;
}

/** The signed-in team member's ID, or null in single-token mode. */
export function useCurrentMemberId(){return useContext(SenderContext).me;}

/** "我" or the member's name above a message sent from a phone; nothing for messages typed on the computer. */
export function SenderLabel({sender}:{sender?:TeamMember}){
  const {me,shown}=useContext(SenderContext);
  if(!shown||!sender)return null;
  return <div className="message-sender">{sender.id===me?'我':sender.name}</div>;
}
