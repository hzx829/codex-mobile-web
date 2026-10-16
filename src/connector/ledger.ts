import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { BridgeError, type Json } from '../shared/types.js';

function canonical(v: any): string {
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
export class Ledger {
  db: DatabaseSync;
  private inflight = new Map<string,Promise<Json>>();
  constructor(path:string) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS queued_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, thread_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
      UPDATE queued_messages SET state='uncertain', error='连接器在发送时重启，请核实会话；不会自动重发' WHERE state='sending';
      UPDATE operations SET state='uncertain', result=json_object('error',json_object('code','interrupted','message','连接器在发送时重启，请核实会话；不会自动重发')) WHERE id IN (SELECT id FROM queued_messages WHERE state='uncertain');
      UPDATE operations SET state='uncertain' WHERE state='pending';`);
    this.db.prepare('DELETE FROM operations WHERE updated < ? AND id NOT IN (SELECT id FROM queued_messages)').run(Date.now()-7*86400_000);
  }
  read(id:string):Json {
    const row=this.db.prepare('SELECT state,result FROM operations WHERE id=?').get(id);
    return row?{state:row.state,...(row.result?JSON.parse(String(row.result)): {})}:{state:'unknown'};
  }
  owns(id:string){return Boolean(this.db.prepare('SELECT id FROM managed WHERE id=?').get(id));}
  claim(id:string){this.db.prepare('INSERT OR IGNORE INTO managed VALUES (?)').run(id);}
  queued(threadId?:string):Json[] {
    const rows=threadId===undefined?this.db.prepare('SELECT * FROM queued_messages ORDER BY seq').all():this.db.prepare('SELECT * FROM queued_messages WHERE thread_id=? ORDER BY seq').all(threadId);
    return rows.map(row=>({id:row.id,threadId:row.thread_id,payload:JSON.parse(String(row.payload)),state:row.state,error:row.error||undefined}));
  }
  enqueue(id:string,threadId:string,payload:Json) {
    if(this.queued(threadId).length>=20)throw new BridgeError('queue_full','当前会话最多排队 20 条消息');
    this.db.exec('BEGIN');
    try {
      this.db.prepare("INSERT INTO queued_messages (id,thread_id,payload,state) VALUES (?,?,?,'queued')").run(id,threadId,JSON.stringify(payload));
      this.finish(id,'accepted',{threadId,kind:'queued'});
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  sending(id:string){this.db.prepare("UPDATE queued_messages SET state='sending' WHERE id=?").run(id);}
  finishQueued(id:string,result:Json,error?:BridgeError) {
    if(error){
      const state=error.uncertain?'uncertain':'failed';
      this.db.prepare('UPDATE queued_messages SET state=?,error=? WHERE id=?').run(state,error.message,id);
      this.finish(id,state,{error:{code:error.code,message:error.message}});
    }else{
      this.finish(id,'accepted',result);
      this.db.prepare('DELETE FROM queued_messages WHERE id=?').run(id);
    }
  }
  cancelQueued(threadId:string,id:string) {
    const message=this.queued(threadId).find(message=>message.id===id);
    if(!message)throw new BridgeError('changed','消息已经发送或移出队列，请刷新');
    if(message.state==='sending')throw new BridgeError('active','消息正在发送，请稍候核实结果');
    this.finishQueued(id,{threadId,kind:'queue_cancelled'});
  }
  async run(id:string,payload:Json,fn:()=>Promise<Json>):Promise<Json> {
    if(!/^\d{13}:[0-9a-f-]{36}$/i.test(id))throw new BridgeError('invalid','操作标识无效');
    const hash=createHash('sha256').update(canonical(payload)).digest('hex');
    const old=this.db.prepare('SELECT hash FROM operations WHERE id=?').get(id);
    if(old) {
      if(old.hash!==hash)throw new BridgeError('conflict','同一操作的内容发生变化，请核实原结果');
      return this.inflight.get(id)||this.read(id);
    }
    const age=Date.now()-Number(id.split(':')[0]);
    if(age>5*60_000||age < -60_000)throw new BridgeError('expired','操作已过期或手机时间不准确，请核实任务后重新操作');
    this.db.prepare('INSERT INTO operations VALUES (?,?,?,NULL,?)').run(id,hash,'pending',Date.now());
    const promise=(async()=>{
      try {
        const result=await fn();
        this.finish(id,'accepted',result);return {state:'accepted',...result};
      } catch(e) {
        const error=e instanceof BridgeError?e:new BridgeError('unexpected','电脑处理失败，请核实当前任务',true);
        const result={error:{code:error.code,message:error.message}};
        const state=error.uncertain?'uncertain':'failed';this.finish(id,state,result);return {state,...result};
      } finally {this.inflight.delete(id);}
    })();
    this.inflight.set(id,promise);return promise;
  }
  private finish(id:string,state:string,result:Json){this.db.prepare('UPDATE operations SET state=?,result=?,updated=? WHERE id=?').run(state,JSON.stringify(result),Date.now(),id);}
  close(){this.db.close();}
}
