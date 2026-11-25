import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../shared/types.js';

export async function indexedTurnHasWriter(threadId:string,turnId:string,home=process.env.CODEX_HOME||join(homedir(),'.codex'),sqliteHome=process.env.CODEX_SQLITE_HOME||home):Promise<boolean> {
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
  let db:DatabaseSync|undefined;
  try {
    db=new DatabaseSync(join(sqliteHome,'thread_history_1.sqlite'),{readOnly:true});
    const latest=db.prepare('SELECT turn_id,status FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1').get(threadId);
    return latest?.turn_id===turnId&&latest.status==='inProgress';
  } catch {return false;}
  finally {db?.close();}
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
