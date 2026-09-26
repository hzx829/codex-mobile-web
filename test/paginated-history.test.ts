import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {removeTestTemp} from '../scripts/test-temp.js';
import {readPaginatedHistory} from '../src/connector/paginated-history.js';

test('paginated history reads recent full turns from the local index without writing to it',async()=>{
  const home=await mkdtemp(join(tmpdir(),'cmw-history-'));
  const db=new DatabaseSync(join(home,'thread_history_1.sqlite'));
  try {
    db.exec('CREATE TABLE thread_turns (thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,error_json TEXT); CREATE TABLE thread_items (thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,updated_at_ordinal INTEGER,item_json TEXT)');
    for(const [id,order] of [['old',1],['new',2],['other',3]] as const)db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?)').run(id==='other'?'other-thread':'target',id,order,'completed',null);
    db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?)').run('target','new',4,4,JSON.stringify({id:'answer',type:'agentMessage',text:'完整回复'}));
    db.close();
    const page=readPaginatedHistory('target',1,home);
    assert.equal(page?.hasMore,true);
    assert.deepEqual(page?.turns.map(turn=>turn.id),['new']);
    assert.equal(page?.turns[0].items[0].text,'完整回复');
    assert.equal(readPaginatedHistory('missing',1,home),null);
  } finally {try{db.close();}catch{}await removeTestTemp(home);}
});
