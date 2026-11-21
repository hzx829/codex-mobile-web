import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BridgeError, type Json } from '../shared/types.js';
import type {FileAttachment} from '../shared/attachments.js';

export type UploadRecord=FileAttachment&{threadId:string;cwd:string};
/** The team member the relay says sent a request; absent when the relay has no team. */
export type Actor={userId:string;deviceId?:string;name?:string};
/** Set around each relay request, so every operation it starts records its sender without passing it through each app. */
export const requestActor=new AsyncLocalStorage<Actor|undefined>();
export function actorOf(value:unknown):Actor|undefined{
  const actor=value as Json|null|undefined;
  if(!actor||typeof actor.userId!=='string'||!actor.userId||actor.userId.length>100)return undefined;
  return {userId:actor.userId,...typeof actor.deviceId==='string'?{deviceId:actor.deviceId.slice(0,100)}:{},...typeof actor.name==='string'?{name:actor.name.slice(0,100)}:{}};
}

function canonical(v: any): string {
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
const QUEUE_TABLES=['queued_messages','claude_queued_messages'] as const;

/** Messages held on this computer until their session's running turn ends; each row is also an operation. */
export class MessageQueue {
  constructor(private ledger:Ledger,private table:typeof QUEUE_TABLES[number]) {}
  private get db(){return this.ledger.db;}
  queued(threadId?:string):Json[] {
    const rows=threadId===undefined?this.db.prepare(`SELECT * FROM ${this.table} ORDER BY seq`).all():this.db.prepare(`SELECT * FROM ${this.table} WHERE thread_id=? ORDER BY seq`).all(threadId);
    return rows.map(row=>({id:row.id,threadId:row.thread_id,payload:JSON.parse(String(row.payload)),state:row.state,error:row.error||undefined}));
  }
  enqueue(id:string,threadId:string,payload:Json) {
    if(this.queued(threadId).length>=20)throw new BridgeError('queue_full','当前会话最多排队 20 条消息');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO ${this.table} (id,thread_id,payload,state) VALUES (?,?,?,'queued')`).run(id,threadId,JSON.stringify(payload));
      this.ledger.finish(id,'accepted',{threadId,kind:'queued'});
      this.db.exec('COMMIT');
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  sending(id:string){this.db.prepare(`UPDATE ${this.table} SET state='sending' WHERE id=?`).run(id);}
  finishQueued(id:string,result:Json,error?:BridgeError) {
    if(error){
      const state=error.uncertain?'uncertain':'failed';
      this.db.prepare(`UPDATE ${this.table} SET state=?,error=? WHERE id=?`).run(state,error.message,id);
      this.ledger.finish(id,state,{error:{code:error.code,message:error.message}});
    }else{
      this.ledger.finish(id,'accepted',result);
      this.db.prepare(`DELETE FROM ${this.table} WHERE id=?`).run(id);
    }
  }
  cancelQueued(threadId:string,id:string) {
    const message=this.queued(threadId).find(message=>message.id===id);
    if(!message)throw new BridgeError('changed','消息已经发送或移出队列，请刷新');
    if(message.state==='sending')throw new BridgeError('active','消息正在发送，请稍候核实结果');
    this.finishQueued(id,{threadId,kind:'queue_cancelled'});
    return message.payload;
  }
}

export class Ledger {
  db: DatabaseSync;
  readonly codexQueue: MessageQueue;
  /** Claude Code's own queue, apart from Codex's so neither drains the other's messages. */
  readonly claudeQueue: MessageQueue;
  private inflight = new Map<string,Promise<Json>>();
  constructor(path:string) {
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS file_uploads (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL);`);
    for(const table of QUEUE_TABLES)this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, thread_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
      UPDATE ${table} SET state='uncertain', error='连接器在发送时重启，请核实会话；不会自动重发' WHERE state='sending';
      UPDATE operations SET state='uncertain', result=json_object('error',json_object('code','interrupted','message','连接器在发送时重启，请核实会话；不会自动重发')) WHERE id IN (SELECT id FROM ${table} WHERE state='uncertain');`);
    if(!this.db.prepare('PRAGMA table_info(operations)').all().some(column=>column.name==='actor'))this.db.exec('ALTER TABLE operations ADD COLUMN actor TEXT');
    this.db.exec("UPDATE operations SET state='uncertain' WHERE state='pending';");
    this.db.prepare(`DELETE FROM operations WHERE updated < ? ${QUEUE_TABLES.map(table=>`AND id NOT IN (SELECT id FROM ${table})`).join(' ')}`).run(Date.now()-7*86400_000);
    this.codexQueue=new MessageQueue(this,'queued_messages');
    this.claudeQueue=new MessageQueue(this,'claude_queued_messages');
  }
  read(id:string):Json {
    const row=this.db.prepare('SELECT state,result FROM operations WHERE id=?').get(id);
    return row?{state:row.state,...(row.result?JSON.parse(String(row.result)): {})}:{state:'unknown'};
  }
  /** Who sent an operation, as the relay stamped it. */
  actor(id:string):Actor|undefined {
    const row=this.db.prepare('SELECT actor FROM operations WHERE id=?').get(id);
    try{return row?.actor?actorOf(JSON.parse(String(row.actor))):undefined;}catch{return undefined;}
  }
  owns(id:string){return Boolean(this.db.prepare('SELECT id FROM managed WHERE id=?').get(id));}
  upload(id:string):UploadRecord|undefined {return this.db.prepare('SELECT id, thread_id AS threadId, cwd, name, size FROM file_uploads WHERE id=?').get(id) as UploadRecord|undefined;}
  addUpload(file:UploadRecord){this.db.prepare('INSERT INTO file_uploads VALUES (?,?,?,?,?)').run(file.id,file.threadId,file.cwd,file.name,file.size);}
  claim(id:string){this.db.prepare('INSERT OR IGNORE INTO managed VALUES (?)').run(id);}
  /** Codex messages waiting for the running turn to end. */
  queued(threadId?:string){return this.codexQueue.queued(threadId);}
  enqueue(id:string,threadId:string,payload:Json){this.codexQueue.enqueue(id,threadId,payload);}
  sending(id:string){this.codexQueue.sending(id);}
  finishQueued(id:string,result:Json,error?:BridgeError){this.codexQueue.finishQueued(id,result,error);}
  cancelQueued(threadId:string,id:string){return this.codexQueue.cancelQueued(threadId,id);}
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
    const actor=requestActor.getStore();
    this.db.prepare('INSERT INTO operations (id,hash,state,result,updated,actor) VALUES (?,?,?,NULL,?,?)').run(id,hash,'pending',Date.now(),actor?JSON.stringify(actor):null);
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
  finish(id:string,state:string,result:Json){this.db.prepare('UPDATE operations SET state=?,result=?,updated=? WHERE id=?').run(state,JSON.stringify(result),Date.now(),id);}
  close(){this.db.close();}
}
