import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, appendFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AntigravityBridge} from '../src/connector/antigravity.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError} from '../src/shared/types.js';
import {home, parseLocation} from '../web/route-state.js';
import {serviceOf, switchRoute} from '../web/service-switch.js';

test('app switches restore each machine and app independently, including legacy ChatGPT routes', () => {
  const memory = new Map<string,string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {
    setItem: (k:string,v:string) => memory.set(k,v), getItem: (k:string) => memory.get(k) ?? null,
  }});
  try {
    const id = randomUUID(), codex = {...home, thread:'native-thread', project:'D:/work'};
    const ag = {...home, antigravity:id}, chat = {...home, chat:id};
    assert.deepEqual(switchRoute('pc', codex, 'antigravity'), {...home, antigravity:''});
    assert.deepEqual(switchRoute('pc', ag, 'chatgpt'), {...home, chat:''});
    assert.deepEqual(switchRoute('pc', chat, 'antigravity'), ag);
    assert.deepEqual(switchRoute('pc', ag, 'codex'), codex);
    assert.deepEqual(switchRoute('other', home, 'antigravity'), {...home, antigravity:''});
    for (const route of [ag, chat, codex]) assert.deepEqual(parseLocation({cmwRoute:route,cmwMachine:'pc'})?.route,route);
    assert.equal(serviceOf(chat),'chatgpt');
    assert.equal(parseLocation({cmwRoute:{...chat,antigravity:id},cmwMachine:'pc'}),null);
    assert.equal(parseLocation({cmwRoute:{...home,antigravity:'../bad'},cmwMachine:'pc'}),null);
  } finally {
    if (original) Object.defineProperty(globalThis,'sessionStorage',original);
    else Reflect.deleteProperty(globalThis,'sessionStorage');
  }
});

test('desktop transcripts, watch updates and write receipts stay with the selected Antigravity conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(),'cmw-antigravity-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir,'conversation_summaries.db'));
  t.after(async()=>{db.close();ledger.close();await rm(dir,{recursive:true,force:true});});
  const id = randomUUID(), logs = join(dir,'brain',id,'.system_generated','logs');
  await mkdir(logs,{recursive:true});
  const transcript = join(logs,'transcript.jsonl');
  const line = (step:object) => JSON.stringify(step)+'\n';
  await writeFile(transcript,line({type:'USER_INPUT',step_index:1,content:'<USER_REQUEST>hello</USER_REQUEST>\n<ADDITIONAL_METADATA>private</ADDITIONAL_METADATA>'})+
    line({type:'PLANNER_RESPONSE',step_index:2,thinking:'private',tool_calls:[{name:'read_file',args:{private:true}}]}));
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?)').run(id,'Example','CASCADE_RUN_STATUS_IDLE','today',2,1,'before',0);
  const writes:unknown[]=[];
  const bridge = new AntigravityBridge(dir,ledger,async (_dir,method,body)=>{
    writes.push({method,body});
    if(method==='CancelCascadeInvocation')throw new BridgeError('uncertain','lost response',true);
  });
  assert.deepEqual((await bridge.handle('antigravity.list',{})).data,[{id,title:'Example'}]);
  const view = await bridge.handle('antigravity.read',{conversationId:id});
  assert.deepEqual(view.messages,[{id:'1',role:'user',text:'hello'},{id:'2-tools',role:'tool',text:'read_file'}]);
  await appendFile(transcript,line({type:'PLANNER_RESPONSE',step_index:3,content:'done'}));
  const delta = await bridge.handle('antigravity.watch',{conversationId:id,revision:view.revision});
  assert.equal(delta.base,view.revision);
  assert.equal(delta.keep,2);
  assert.deepEqual(delta.messages,[{id:'3',role:'assistant',text:'done'}]);
  const makeOp = () => `${Date.now()}:${randomUUID()}`;
  const payload = {opId:makeOp(),conversationId:id,text:'next',turn:view.turn};
  const results = await Promise.all([bridge.handle('antigravity.send',payload),bridge.handle('antigravity.send',payload)]);
  assert.ok(results.every(r=>r.state==='accepted'));
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0],{method:'SendUserCascadeMessage',body:{cascadeId:id,items:[{text:'next'}],clientMessageId:payload.opId.split(':')[1]}});
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING',last_user_input_step_index=4");
  assert.equal((await bridge.handle('antigravity.stop',{...payload,opId:makeOp()})).state,'failed');
  const stop = {...payload,turn:(await bridge.handle('antigravity.read',{conversationId:id})).turn,opId:makeOp()};
  assert.equal((await bridge.handle('antigravity.stop',stop)).state,'uncertain');
  assert.equal((await bridge.handle('antigravity.stop',stop)).state,'uncertain');
  assert.equal((await bridge.handle('antigravity.operation',stop)).state,'uncertain');
  assert.equal(writes.length,2);
  await assert.rejects(bridge.handle('antigravity.read',{conversationId:'../outside'}),/ID 无效/);
});
