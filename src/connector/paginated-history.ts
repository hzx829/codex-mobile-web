import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../shared/types.js';

export function readPaginatedHistory(threadId:string,limit:number,home=process.env.CODEX_SQLITE_HOME||process.env.CODEX_HOME||join(homedir(),'.codex')):{turns:Json[];hasMore:boolean}|null {
  const path=join(home,'thread_history_1.sqlite');
  if(!existsSync(path))return null;
  let db:DatabaseSync|undefined;
  try {
    db=new DatabaseSync(path,{readOnly:true});
    const rows=db.prepare('SELECT turn_id,status,error_json FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT ?').all(threadId,limit+1) as Json[];
    if(!rows.length)return null;
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
