import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../shared/types.js';

const legacyTurnTypes=['task_started','task_complete','turn_aborted','thread_rolled_back'];
const legacyTurnMarkers=legacyTurnTypes.map(type=>`"${type}"`);

async function legacyTurnRunning(path:string,turnId?:string):Promise<boolean> {
  const file=await open(path,'r');
  try {
    const buffer=Buffer.alloc(64*1024);
    let end=(await file.stat()).size,remainder=Buffer.alloc(0);
    while(end>0) {
      const start=Math.max(0,end-buffer.length);
      const {bytesRead}=await file.read(buffer,0,end-start,start);
      const chunk=Buffer.concat([buffer.subarray(0,bytesRead),remainder]);
      // Keep an incomplete leading line in bytes so a chunk can split a UTF-8 character.
      let lineEnd=chunk.length;
      for(let lineStart=chunk.lastIndexOf(10);lineStart>=0;lineStart=chunk.lastIndexOf(10,lineStart-1)) {
        const event=legacyTurnEvent(chunk.subarray(lineStart+1,lineEnd));
        if(event)return event.type==='task_started'&&(!turnId||event.turn_id===turnId);
        lineEnd=lineStart;
        if(lineStart===0)break;
      }
      if(start===0){const event=legacyTurnEvent(chunk.subarray(0,lineEnd));return event?.type==='task_started'&&(!turnId||event.turn_id===turnId);}
      remainder=chunk.subarray(0,lineEnd);end=start;
    }
    return false;
  } finally {await file.close();}
}

function legacyTurnEvent(line:Buffer):Json|undefined {
  if(!line.includes('"event_msg"')||!legacyTurnMarkers.some(type=>line.includes(type)))return;
  try {
    const {type,payload}=JSON.parse(line.toString());
    if(type==='event_msg'&&legacyTurnTypes.includes(payload?.type))return payload;
  } catch {/* The last line may still be in the process of being written. */}
}

export async function indexedTurnHasWriter(threadId:string,turnId?:string,home=process.env.CODEX_HOME||join(homedir(),'.codex'),sqliteHome=process.env.CODEX_SQLITE_HOME||home):Promise<boolean> {
  if(process.platform!=='win32'||!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(threadId))return false;
  const lock=await open(join(home,'thread-writer-locks',`${threadId}.lock`),'r').catch(()=>null);
  if(!lock)return false;
  try {
    // Windows rejects reads over Codex's exclusive byte-range lock, even in an empty lock file.
    await lock.read(Buffer.alloc(1),0,1,0);
    return false;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EBUSY')return false;
  } finally {await lock.close();}
  let db:DatabaseSync|undefined,latest:Record<string,unknown>|undefined;
  try {
    db=new DatabaseSync(join(sqliteHome,'thread_history_1.sqlite'),{readOnly:true});
    latest=db.prepare('SELECT turn_id,status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(threadId);
  } catch {/* Older homes only have rollout files. */}
  finally {db?.close();}
  if(latest)return latest.status==='inProgress'&&(!turnId||latest.turn_id===turnId);
  db=undefined;
  let path:unknown;
  try {
    db=new DatabaseSync(join(sqliteHome,'state_5.sqlite'),{readOnly:true});
    path=db.prepare("SELECT rollout_path FROM threads WHERE id=? AND history_mode='legacy'").get(threadId)?.rollout_path;
  } catch {return false;}
  finally {db?.close();}
  return typeof path==='string'&&await legacyTurnRunning(path,turnId).catch(()=>false);
}

export function readPaginatedHistory(threadId:string,limit:number,home=process.env.CODEX_SQLITE_HOME||process.env.CODEX_HOME||join(homedir(),'.codex'),before?:string):{turns:Json[];hasMore:boolean}|null {
  const path=join(home,'thread_history_1.sqlite');
  if(!existsSync(path))return null;
  let db:DatabaseSync|undefined;
  try {
    db=new DatabaseSync(path,{readOnly:true});
    const anchor=before?db.prepare('SELECT rollout_ordinal FROM thread_turns WHERE thread_id=? AND turn_id=?').get(threadId,before):undefined;
    if(before&&!anchor)return null;
    const rows=(anchor
      ?db.prepare('SELECT turn_id,status,error_json FROM thread_turns WHERE thread_id=? AND rollout_ordinal<? ORDER BY rollout_ordinal DESC LIMIT ?').all(threadId,anchor.rollout_ordinal!,limit+1)
      :db.prepare('SELECT turn_id,status,error_json FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT ?').all(threadId,limit+1)) as Json[];
    if(!rows.length&&!before)return null;
    const hasMore=rows.length>limit;
    const items=db.prepare('SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? ORDER BY rollout_ordinal,updated_at_ordinal');
    const turns=rows.slice(0,limit).reverse().map(row=>({
      id:row.turn_id,
      status:row.status,
      error:row.error_json?JSON.parse(row.error_json):null,
      items:(items.all(threadId,row.turn_id) as Json[]).map(item=>JSON.parse(item.item_json)),
    }));
    return {turns,hasMore};
  } catch {return null;}
  finally {db?.close();}
}
