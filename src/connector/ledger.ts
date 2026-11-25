import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BridgeError, type Json, type UsageEvent } from '../shared/types.js';
import type {FileAttachment} from '../shared/attachments.js';
import { textKey, type SenderRecord } from './message-senders.js';

export type UploadRecord=FileAttachment&{threadId:string;cwd:string};
/** The team member the relay says sent a request; absent when the relay has no team. */
export type ActorRole='owner'|'admin'|'member';
export type Actor={userId:string;deviceId?:string;name?:string;role?:ActorRole};
/** Set around each relay request, so every operation it starts records its sender without passing it through each app. */
export const requestActor=new AsyncLocalStorage<Actor|undefined>();
export function actorOf(value:unknown):Actor|undefined{
  const actor=value as Json|null|undefined;
  if(!actor||typeof actor.userId!=='string'||!actor.userId||actor.userId.length>100)return undefined;
  const role=actor.role==='owner'||actor.role==='admin'||actor.role==='member'?actor.role:undefined;
  return {userId:actor.userId,...typeof actor.deviceId==='string'?{deviceId:actor.deviceId.slice(0,100)}:{},...typeof actor.name==='string'?{name:actor.name.slice(0,100)}:{},...role?{role}:{}};
}

function canonical(v: any): string {
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  return JSON.stringify(v);
}
const QUEUE_TABLES=['queued_messages','claude_queued_messages','antigravity_queued_messages'] as const;

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
  /** Antigravity's own queue, apart from Codex's and Claude Code's. */
  readonly antigravityQueue: MessageQueue;
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
    // Senders live beside operations, not in them: an older connector put back after a failed update keeps writing
    // operations with its own five columns. A database an earlier build of this feature widened is narrowed again.
    this.db.exec('CREATE TABLE IF NOT EXISTS operation_actors (id TEXT PRIMARY KEY, actor TEXT NOT NULL)');
    if(this.db.prepare('PRAGMA table_info(operations)').all().some(column=>column.name==='actor'))this.db.exec(`BEGIN;
      INSERT OR IGNORE INTO operation_actors SELECT id, actor FROM operations WHERE actor IS NOT NULL;
      ALTER TABLE operations DROP COLUMN actor;
      COMMIT;`);
    // Finished turns waiting for a team relay to confirm them, and each Claude Code session's running token total.
    this.db.exec(`CREATE TABLE IF NOT EXISTS usage_outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS claude_usage_cursor (session_id TEXT PRIMARY KEY, totals TEXT NOT NULL, updated INTEGER NOT NULL);`);
    this.db.prepare('DELETE FROM usage_outbox WHERE created < ?').run(Date.now()-30*86400_000);
    // Who sent each message from the phone, so a session shows names next to messages from several members.
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_senders (seq INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, thread_id TEXT NOT NULL,
        turn_id TEXT, kind TEXT NOT NULL, text_hash TEXT, user_id TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS message_senders_thread ON message_senders(service, thread_id, seq);
      CREATE TABLE IF NOT EXISTS claude_registered_projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    this.db.prepare('DELETE FROM message_senders WHERE created < ?').run(Date.now()-400*86400_000);
    this.db.exec("UPDATE operations SET state='uncertain' WHERE state='pending';");
    this.db.prepare(`DELETE FROM operations WHERE updated < ? ${QUEUE_TABLES.map(table=>`AND id NOT IN (SELECT id FROM ${table})`).join(' ')}`).run(Date.now()-7*86400_000);
    this.db.exec('DELETE FROM operation_actors WHERE id NOT IN (SELECT id FROM operations)');
    this.codexQueue=new MessageQueue(this,'queued_messages');
    this.claudeQueue=new MessageQueue(this,'claude_queued_messages');
    this.antigravityQueue=new MessageQueue(this,'antigravity_queued_messages');
  }
  read(id:string):Json {
    const row=this.db.prepare('SELECT state,result FROM operations WHERE id=?').get(id);
    return row?{state:row.state,...(row.result?JSON.parse(String(row.result)): {})}:{state:'unknown'};
  }
  /** Who sent an operation, as the relay stamped it. */
  actor(id:string):Actor|undefined {
    const row=this.db.prepare('SELECT actor FROM operation_actors WHERE id=?').get(id);
    try{return row?.actor?actorOf(JSON.parse(String(row.actor))):undefined;}catch{return undefined;}
  }
  /** Called after a turn is recorded, so the connector can send it to the relay. */
  onUsage?:()=>void;
  /** Keeps a finished turn until the relay confirms it; the sender comes from the operation that started the turn. */
  recordUsage(event:Omit<UsageEvent,'ts'|'actor'>&{ts?:number}) {
    // A lost usage record never fails the send or turn it describes.
    try{
      const actor=event.opId?this.actor(event.opId):undefined;
      const full:UsageEvent={...event,ts:event.ts??Date.now(),...actor?{actor:{userId:actor.userId,...actor.name?{name:actor.name}:{}}}:{}};
      this.db.prepare('INSERT OR IGNORE INTO usage_outbox VALUES (?,?,?)').run(full.id,JSON.stringify(full),Date.now());
    }catch(error){console.error('用量记录失败：',(error as Error).message);return;}
    this.onUsage?.();
  }
  /**
   * Remembers who sent a message, when the relay named a sender for its operation. Codex messages are
   * keyed by `turnId`; Claude Code and Antigravity by their exact `text`.
   */
  recordSender(entry:{service:string;threadId:string;opId:string;kind:SenderRecord['kind'];turnId?:string|null;text?:string}) {
    // A missing name label never fails the send it describes.
    try{const actor=this.actor(entry.opId);if(!actor)return;
      this.db.prepare('INSERT INTO message_senders (service,thread_id,turn_id,kind,text_hash,user_id,name,created) VALUES (?,?,?,?,?,?,?,?)')
      .run(entry.service,entry.threadId,entry.turnId??null,entry.kind,entry.text===undefined?null:textKey(entry.text),actor.userId,actor.name||'',Date.now());}
    catch(error){console.error('发送人记录失败：',(error as Error).message);}
  }
  senders(service:string,threadId:string):SenderRecord[] {
    return this.db.prepare('SELECT turn_id,kind,text_hash,user_id,name FROM message_senders WHERE service=? AND thread_id=? ORDER BY seq').all(service,threadId)
      .map(row=>({turnId:row.turn_id===null?null:String(row.turn_id),kind:String(row.kind) as SenderRecord['kind'],textHash:row.text_hash===null?null:String(row.text_hash),sender:{id:String(row.user_id),name:String(row.name)}}));
  }
  registerClaudeProject(path:string,name:string) {
    this.db.prepare('INSERT INTO claude_registered_projects (path,name,created_at) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET name=excluded.name').run(path,name,Date.now());
  }
  claudeProjects():{path:string;name:string;createdAt:number}[] {
    return this.db.prepare('SELECT path,name,created_at FROM claude_registered_projects ORDER BY created_at DESC, path ASC').all()
      .map(row=>({path:String(row.path),name:String(row.name),createdAt:Number(row.created_at)}));
  }
  pendingUsage(limit=200):UsageEvent[] {return this.db.prepare('SELECT payload FROM usage_outbox ORDER BY created, id LIMIT ?').all(limit).map(row=>JSON.parse(String(row.payload)));}
  pendingUsageCount():number {return Number(this.db.prepare('SELECT count(*) AS n FROM usage_outbox').get()?.n||0);}
  ackUsage(ids:unknown[]) {const remove=this.db.prepare('DELETE FROM usage_outbox WHERE id=?');for(const id of ids)if(typeof id==='string')remove.run(id);}
  claudeCursor(sessionId:string):Record<string,any>|undefined {
    const row=this.db.prepare('SELECT totals FROM claude_usage_cursor WHERE session_id=?').get(sessionId);
    try{return row?JSON.parse(String(row.totals)):undefined;}catch{return undefined;}
  }
  setClaudeCursor(sessionId:string,totals:Json) {this.db.prepare('INSERT INTO claude_usage_cursor VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET totals=excluded.totals, updated=excluded.updated').run(sessionId,JSON.stringify(totals),Date.now());}
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
    this.db.prepare('INSERT INTO operations VALUES (?,?,?,NULL,?)').run(id,hash,'pending',Date.now());
    if(actor)this.db.prepare('INSERT OR REPLACE INTO operation_actors VALUES (?,?)').run(id,JSON.stringify(actor));
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
