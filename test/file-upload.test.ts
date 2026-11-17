import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readdir,readFile,mkdir,symlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocket} from 'ws';
import {MAX_FRAME,type Json} from '../src/shared/types.js';
import {validateAttachments,fileAttachment,MAX_FILE_UPLOAD_BYTES,UPLOAD_CHUNK_BYTES,MAX_ATTACHMENTS} from '../src/shared/attachments.js';
import {startUpload,attachmentLinks} from '../src/connector/attachments.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {createRelay} from '../src/server/relay.js';
import {clipboardFiles,readAttachmentFiles,type DraftFileAttachment} from '../web/attachments.js';
import {uploadAttachments} from '../web/file-upload.js';
import {fileReference} from '../web/preview-target.js';
import {submitTurn} from '../web/turn-request.js';
import {createFirstTurn} from '../web/new-chat.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const pdfBytes=Buffer.from('%PDF-1.7\n\0binary\xff','binary'),wordBytes=Buffer.from('PK\x03\x04\0word','binary');
const draft=(bytes:Buffer,name='报告 [终稿] #1.pdf'):DraftFileAttachment=>({id:randomUUID(),name,size:bytes.length,file:new File([new Uint8Array(bytes)],name)});
const image='data:image/png;base64,iVBORw0KGgo=';
const paths=(text:string)=>[...text.matchAll(/\]\(<([^>]+)>\)/g)].map(match=>fileReference(match[1]).path);

test('documents have independent 100 MiB limits while turn frames contain only references',()=>{
  const full={id:randomUUID(),name:'large.pdf',size:MAX_FILE_UPLOAD_BYTES};
  assert.equal(fileAttachment({...full,id:full.id.toUpperCase()}).id,full.id);
  assert.equal(validateAttachments([image],Array(MAX_ATTACHMENTS-1).fill(full)).files.length,9);
  assert.ok(Buffer.byteLength(JSON.stringify({text:'中'.repeat(100_000),files:Array(10).fill(full)}))<MAX_FRAME);
  for(const size of [0,-1,1.5,NaN,MAX_FILE_UPLOAD_BYTES+1])assert.throws(()=>validateAttachments([],[{...full,size}]),/100 MiB/);
  for(const name of ['../escape.pdf','C:\\outside.docx','a/b.pdf','..','CON.txt','trailing.','bad\0.pdf',''])assert.throws(()=>validateAttachments([],[{...full,name}]),/文件名/);
  assert.throws(()=>validateAttachments([],[{...full,id:'../escape'}]),/上传标识/);
  assert.throws(()=>validateAttachments([image],Array(MAX_ATTACHMENTS).fill(full)),/合计最多/);
});

test('selection retains browser File handles without reading whole documents',async t=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'FileReader');
  Object.defineProperty(globalThis,'FileReader',{configurable:true,value:class {result='';onload?:()=>void;async readAsDataURL(blob:Blob){assert.equal(blob.type,'image/png');this.result=`data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;this.onload?.();}}});
  t.after(()=>{if(old)Object.defineProperty(globalThis,'FileReader',old);else Reflect.deleteProperty(globalThis,'FileReader');});
  const document=new File([Buffer.alloc(9*1024*1024)],'large.pdf'),photo=new File([Buffer.from(image.split(',')[1],'base64')],'photo.png');
  const result=await readAttachmentFiles([document,photo],[],[]);
  assert.equal(result!.files[0].file,document);assert.equal(result!.files[0].size,document.size);assert.deepEqual(result!.images,[image]);
  assert.deepEqual(clipboardFiles({items:[],files:[document,photo]} as any),[document,photo]);
  assert.equal(await readAttachmentFiles([document],[],[],()=>true),null);
  await assert.rejects(readAttachmentFiles([new File([],'empty.doc')],[],[]),/100 MiB/);
  await assert.rejects(readAttachmentFiles([{name:'oversize.pdf',size:MAX_FILE_UPLOAD_BYTES+1,type:'application/pdf'} as File],[],[]),/100 MiB/);
  await assert.rejects(readAttachmentFiles(Array(MAX_ATTACHMENTS).fill(document),[image],[]),/合计最多/);
});

async function fixture(source:'desktop'|'connector'='desktop') {
  const cwd=await mkdtemp(join(tmpdir(),'cmw-upload-'));
  let active:string|null=null;const sent:Json[]=[];
  const thread=()=>({id:'s',cwd,model:'text-only',turns:active?[{id:active,turnId:active,status:'inProgress',items:[]}]:[]});
  class Runtime extends EventEmitter {
    requests=new Map();
    async rpc(method:string,params:Json){
      if(method==='thread/read')return {thread:thread()};
      if(method==='thread/resume')return {thread:thread(),model:'text-only'};
      if(method==='turn/start'||method==='turn/steer'){sent.push(params);active='next';return {turn:{id:active}};}
      assert.fail(`Unexpected runtime call: ${method}`);
    }
    close(){}
  }
  class Desktop extends EventEmitter {
    clientId=source==='desktop'?'desktop':'';states=new Map();
    async follow(){if(source==='connector')throw Error('offline');return thread();}
    async request(method:string,params:Json){
      if(method==='thread-follower-start-turn'||method==='thread-follower-steer-turn'){sent.push(params.turnStart?.request||params);active='next';return {result:{turn:{id:active}}};}
      return {};
    }
    close(){}
  }
  const ledger=new Ledger(join(cwd,'ledger.sqlite'));if(source==='connector')ledger.claim('s');
  const control=new Control(ledger,new Runtime() as any,new Desktop() as any);
  const call=(action:any,payload:Json={})=>control.handle({id:randomUUID(),action,payload:{threadId:'s',source,generation:control.generation,expectedTurnId:active,opId:`${Date.now()}:${randomUUID()}`,...payload}});
  const restart=()=>{control.ledger.close();control.ledger=new Ledger(join(cwd,'ledger.sqlite'));};
  return {cwd,control,call,sent,restart,setActive:(id:string|null)=>{active=id;},close:async()=>{control.close();await removeTestTemp(cwd);}};
}

test('100 MiB upload reads bounded slices, resumes after a lost receipt and restart, and preserves every byte',async()=>{
  const f=await fixture();
  try {
    const chunk=Buffer.alloc(UPLOAD_CHUNK_BYTES,0xa5),file=new File(Array(MAX_FILE_UPLOAD_BYTES/UPLOAD_CHUNK_BYTES).fill(chunk),'100MiB.pdf');
    file.arrayBuffer=()=>assert.fail('Must not read the whole file');
    let largest=0;const slice=file.slice.bind(file);file.slice=(start=0,end=file.size,type)=>{largest=Math.max(largest,end-start);return slice(start,end,type);};
    const item={id:randomUUID(),name:file.name,size:file.size,file};let chunks=0;
    const call=async(action:any,payload:Json)=>{
      const result=await f.call(action,payload);
      if(action==='file.uploadChunk'&&++chunks===2)throw {uncertain:true,message:'lost receipt'};
      return result;
    };
    await assert.rejects(uploadAttachments(call,'s',[item]));f.restart();
    const progress:number[]=[];const refs=await uploadAttachments(call,'s',[item],value=>progress.push(value.loaded));
    assert.equal(progress[0],2*UPLOAD_CHUNK_BYTES);assert.equal(progress.at(-1),MAX_FILE_UPLOAD_BYTES);
    assert.equal(chunks,MAX_FILE_UPLOAD_BYTES/UPLOAD_CHUNK_BYTES);assert.equal(largest,UPLOAD_CHUNK_BYTES);
    const filePath=paths(await attachmentLinks(f.control.ledger,'s',refs))[0];
    const actual=createHash('sha256');for await(const bytes of createReadStream(filePath))actual.update(bytes);
    const expected=createHash('sha256');for(let i=0;i<MAX_FILE_UPLOAD_BYTES/UPLOAD_CHUNK_BYTES;i++)expected.update(chunk);
    assert.equal(actual.digest('hex'),expected.digest('hex'));
  }finally{await f.close();}
});

test('chunks reject malformed data, gaps, changes and cross-thread references; retries never overwrite bytes',async()=>{
  const f=await fixture();
  try {
    const item=draft(Buffer.from('0123456789')),ref=fileAttachment(item);
    await f.call('file.uploadStart',ref);
    const partial=await f.call('turn.send',{files:[ref],mode:'queue'});assert.equal(partial.state,'failed');assert.equal(f.control.ledger.queued('s').length,0);
    for(const data of ['', '!!!!','AA=A',Buffer.alloc(UPLOAD_CHUNK_BYTES+1).toString('base64')])await assert.rejects(f.call('file.uploadChunk',{id:ref.id,offset:0,data}));
    await assert.rejects(f.call('file.uploadChunk',{id:ref.id,offset:2,data:'MDE='}),/不连续/);
    const first={id:ref.id,offset:0,data:Buffer.from('01234').toString('base64')};
    assert.equal((await f.call('file.uploadChunk',first)).offset,5);
    assert.equal((await f.call('file.uploadChunk',first)).offset,5);
    await assert.rejects(f.call('file.uploadChunk',{...first,data:Buffer.from('other').toString('base64')}),/不一致/);
    await assert.rejects(f.call('file.uploadChunk',{...first,threadId:'another'}),/当前会话/);
    await assert.rejects(f.call('file.uploadStart',{...ref,size:ref.size+1}),/已变化/);
    await assert.rejects(f.call('file.uploadStart',{...ref,id:ref.id.toUpperCase(),threadId:'another'}),/已变化/);
    await assert.rejects(f.call('file.uploadChunk',{id:ref.id,offset:5,data:Buffer.from('567890').toString('base64')}),/超过/);
    assert.equal((await f.call('file.uploadChunk',{id:ref.id,offset:3,data:Buffer.from('3456789').toString('base64')})).offset,10);
    const filePath=paths(await attachmentLinks(f.control.ledger,'s',[ref]))[0];assert.equal(await readFile(filePath,'utf8'),'0123456789');
    const wrong=await f.call('turn.send',{files:[ref],threadId:'another'});assert.equal(wrong.state,'failed');assert.equal(f.sent.length,0);
  }finally{await f.close();}
});

test('duplicate filenames stay separate and attachment directories cannot redirect outside the project',async()=>{
  const f=await fixture();
  try {
    const refs=await uploadAttachments(f.call,'s',[draft(pdfBytes),draft(wordBytes)]);
    const saved=paths(await attachmentLinks(f.control.ledger,'s',refs));assert.equal(new Set(saved).size,2);
    assert.deepEqual(await readFile(saved[0]),pdfBytes);assert.deepEqual(await readFile(saved[1]),wordBytes);
    const project=join(f.cwd,'nested'),outside=join(f.cwd,'outside');await mkdir(project);await mkdir(outside);
    await symlink(outside,join(project,'.codex-mobile-attachments'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(startUpload(f.control.ledger,'s',project,fileAttachment(draft(pdfBytes))),/附件路径/);
    assert.deepEqual(await readdir(outside),[]);
  }finally{await f.close();}
});

for(const source of ['desktop','connector'] as const)test(`${source} sends uploaded references once and can steer without retransmitting files`,async()=>{
  const f=await fixture(source);
  try {
    const files=await uploadAttachments(f.call,'s',[draft(pdfBytes),draft(wordBytes,'需求.docx')]);
    const opId=`${Date.now()}:${randomUUID()}`,payload={files,text:'',opId,expectedTurnId:null};
    const result=await f.call('turn.send',payload);assert.equal(result.state,'accepted',JSON.stringify(result));
    assert.deepEqual(await f.call('turn.send',payload),result);assert.equal(f.sent.length,1);
    const uploaded=paths(f.sent[0].input[0].text);assert.equal(uploaded.length,2);
    assert.deepEqual(await readFile(uploaded[0]),pdfBytes);assert.deepEqual(await readFile(uploaded[1]),wordBytes);
    assert.equal((await f.call('turn.send',{text:'补充资料',files:[files[1]]})).kind,'steer_accepted');
    assert.equal(paths(f.sent[1].input[0].text)[0],uploaded[1]);
  }finally{await f.close();}
});

test('queue stores references through restart and withdrawal, then dispatches or steers the same files',async()=>{
  const f=await fixture();f.setActive('running');
  try {
    const files=await uploadAttachments(f.call,'s',[draft(pdfBytes)]);
    const queued=await f.call('turn.send',{text:'',files,mode:'queue'});assert.equal(queued.kind,'queued');
    assert.deepEqual((await f.control.read('s')).queuedMessages![0].fileNames,[files[0].name]);
    assert.ok(JSON.stringify(f.control.ledger.queued('s')).length<1000);f.restart();
    const id=f.control.ledger.queued('s')[0].id;
    const withdrawn=await f.call('turn.withdrawQueued',{queuedId:id});assert.deepEqual(withdrawn.message.files,files);
    assert.deepEqual(await uploadAttachments(()=>assert.fail('Must not upload withdrawn files again'),'s',withdrawn.message.files),files);
    await f.call('turn.send',{text:'',files:withdrawn.message.files,mode:'queue'});
    f.setActive(null);await f.control.drainQueue();assert.equal(f.sent.length,1);
    assert.deepEqual(await readFile(paths(f.sent[0].input[0].text)[0]),pdfBytes);
    await f.call('turn.send',{files,mode:'queue'});
    const steered=await f.call('turn.steerQueued',{queuedId:f.control.ledger.queued('s')[0].id});assert.equal(steered.kind,'steer_accepted');
    assert.equal(f.sent.length,2);assert.deepEqual(f.control.ledger.queued('s'),[]);
  }finally{await f.close();}
});

test('new-chat uploads before sending and refreshes the send operation ID after a slow upload',async()=>{
  const calls:Json[]=[],item=draft(pdfBytes);let savedId='';
  const call=async(action:string,payload:Json)=>{
    calls.push({action,payload});
    if(action==='session.create')return {state:'accepted',threadId:'s'};
    if(action==='session.read')return {canControl:true,activeTurnId:null,source:'connector',generation:'g'};
    if(action==='file.uploadStart')return {id:item.id,offset:0};
    if(action==='file.uploadChunk')return {id:item.id,offset:item.size};
    return {state:'accepted'};
  };
  await createFirstTurn(call,{cwd:'project',text:'',images:[],files:[item],sendId:'expired'},()=>{},undefined,id=>{savedId=id;});
  assert.deepEqual(calls.map(value=>value.action),['session.create','session.read','file.uploadStart','file.uploadChunk','turn.send']);
  assert.deepEqual(calls.at(-1)!.payload.files,[fileAttachment(item)]);assert.notEqual(savedId,'expired');assert.equal(calls.at(-1)!.payload.opId,savedId);
  const failed=await createFirstTurn(async(action,payload)=>{if(action==='file.uploadChunk')throw {uncertain:true,message:'lost upload receipt'};if(action==='turn.send')assert.fail('Upload failure cannot send a turn');return call(action,payload);},{files:[item]},()=>{});
  assert.equal(failed.result.state,'failed');
  await submitTurn(call,{threadId:'s',source:'connector',expectedTurnId:null},'',[],{model:'',effort:'',approvalPolicy:''},'queue',[fileAttachment(item)]);
  assert.deepEqual(calls.at(-1)!.payload.files,[fileAttachment(item)]);
});

test('a document over 8 MiB crosses the real relay in small frames before the turn is sent',async()=>{
  const f=await fixture(),relay=createRelay('upload-token',undefined,0);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  const connect=async(role:string)=>{const ws=new WebSocket(url);await once(ws,'open');const ready=once(ws,'message');ws.send(JSON.stringify({type:'hello',role,token:'upload-token',machineId:'pc',name:'PC'}));await ready;return ws;};
  const connector=await connect('connector'),phone=await connect('phone');let largest=0,receipts=0;
  connector.on('message',async raw=>{
    const request=JSON.parse(raw.toString());if(request.type!=='request')return;largest=Math.max(largest,raw.toString().length);
    try{connector.send(JSON.stringify({type:'response',id:request.id,result:await f.call(request.action,request.payload)}));}
    catch(error){connector.send(JSON.stringify({type:'response',id:request.id,error:{message:(error as Error).message}}));}
  });
  const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:any)=>void}>();
  phone.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='received')receipts++;if(message.type!=='response')return;const request=pending.get(message.id);pending.delete(message.id);if(message.error)request?.reject(message.error);else request?.resolve(message.result);});
  const call=(action:any,payload:Json)=>new Promise<any>((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});phone.send(JSON.stringify({type:'request',id,action,payload,machineId:'pc'}));});
  try {
    const bytes=Buffer.alloc(9*1024*1024,137),files=await uploadAttachments(call,'s',[draft(bytes)]);
    const result=await call('turn.send',{files,text:'',expectedTurnId:null});assert.equal(result.state,'accepted');
    assert.deepEqual(await readFile(paths(f.sent[0].input[0].text)[0]),bytes);
    assert.ok(largest<1024*1024);assert.ok(receipts>=18);assert.equal(phone.readyState,WebSocket.OPEN);
  }finally{await relay.close();await f.close();}
});
