import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {createRelay} from '../src/server/relay.js';
import {TeamStore} from '../src/server/team/store.js';
import {runTeamCommand} from '../src/server/team/cli.js';
import {Ledger,requestActor} from '../src/connector/ledger.js';
import {inviteCode,deviceName} from '../web/client.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const MAIN='main-fixture-token-for-team-tests';

async function tempStore(){
  const dir=await mkdtemp(join(tmpdir(),'cmw-team-'));
  return {dir,path:join(dir,'relay.sqlite'),store:new TeamStore(join(dir,'relay.sqlite'))};
}

function waitFrame(ws:WebSocket,predicate:(v:any)=>boolean):Promise<any>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',listen);reject(Error('frame timeout'));},3000);
  const listen=(b:any)=>{const value=JSON.parse(b.toString());if(predicate(value)){clearTimeout(timer);ws.off('message',listen);resolve(value);}};ws.on('message',listen);
});}

async function startRelay(store:TeamStore){
  const relay=createRelay(MAIN,undefined,0,[],store);
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const url=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  const sockets:WebSocket[]=[];
  /** Resolves with the `ready` frame and the socket, or with the close code when the relay refuses. */
  async function hello(fields:object):Promise<{ws:WebSocket;ready?:any;code?:number}>{
    const ws=new WebSocket(url);sockets.push(ws);await once(ws,'open');
    const result=Promise.race([waitFrame(ws,frame=>frame.type==='ready').then(ready=>({ws,ready})),once(ws,'close').then(([code])=>({ws,code:code as number}))]);
    ws.send(JSON.stringify({type:'hello',...fields}));
    return result;
  }
  let sequence=0;
  async function team(ws:WebSocket,action:string,payload:object={}){
    const id=`team-${++sequence}`;const reply=waitFrame(ws,frame=>frame.type==='response'&&frame.id===id);
    ws.send(JSON.stringify({type:'team',id,action,payload}));return reply;
  }
  async function request(ws:WebSocket,machineId:string,action:string,payload:object={}){
    const id=`req-${++sequence}`;const reply=waitFrame(ws,frame=>frame.type==='response'&&frame.id===id);
    ws.send(JSON.stringify({type:'request',id,machineId,action,payload}));return reply;
  }
  /** A fake connector answering each request with `answer(request)`; returns the requests it saw. */
  async function connector(machineId:string,answer:(request:any)=>any=()=>({}),token=MAIN){
    const seen:any[]=[];
    const joined=await hello({role:'connector',token,machineId,name:machineId});
    joined.ws.on('message',(buffer:any)=>{const frame=JSON.parse(buffer.toString());if(frame.type!=='request')return;seen.push(frame);joined.ws.send(JSON.stringify({type:'response',id:frame.id,result:answer(frame)}));});
    return {...joined,seen};
  }
  return {relay,hello,team,request,connector,close:async()=>{for(const ws of sockets)ws.terminate();await relay.close();}};
}

test('invites become device tokens once, and access follows the member',async()=>{
  const {dir,store}=await tempStore();
  try{
    assert.equal(store.enabled,false);
    const owner=store.createUser({name:'Ada',role:'owner'});
    assert.equal(store.enabled,true);
    const invite=store.createInvite(owner.id,null);
    assert.match(invite.code,/^inv_[\w-]+$/);
    const {token,device}=store.redeemInvite(invite.code,'iPhone Safari');
    assert.match(token,/^dev_/);
    assert.throws(()=>store.redeemInvite(invite.code,'again'),/无效或已过期/);
    assert.equal(store.authenticate(token)?.user.id,owner.id);
    assert.equal(store.authenticate('dev_wrong'),undefined);
    assert.throws(()=>store.updateUser(owner.id,{role:'member'}),/至少要保留一位所有者/);
    const member=store.createUser({name:'Bo',role:'member',machines:['pc-a']});
    assert.equal(store.canUse(member,'pc-a'),true);
    assert.equal(store.canUse(member,'pc-b'),false);
    assert.equal(store.canUse(owner,'pc-b'),true);
    assert.throws(()=>store.createUser({name:'Bo',role:'member'}),/同名/);
    store.revokeDevice(device.id);
    assert.equal(store.authenticate(token),undefined);
    // An expired invite is refused even though it was never used.
    const late=store.createInvite(member.id,owner.id);
    store.db.prepare('UPDATE invites SET expires_at=?').run(Date.now()-1);
    assert.throws(()=>store.redeemInvite(late.code,'x'),/无效或已过期/);
  }finally{store.close();await removeTestTemp(dir);}
});

test('the team command sets up the owner once and prints an invite link',async()=>{
  const {dir,path,store}=await tempStore();store.close();
  try{
    const lines:string[]=[];
    assert.equal(runTeamCommand(['init','--name','Ada','--url','https://relay.example/'],path,line=>lines.push(line)),0);
    assert.ok(lines.some(line=>/^https:\/\/relay\.example\/#invite=inv_[\w-]+$/.test(line)),lines.join('\n'));
    assert.equal(runTeamCommand(['init','--name','Bo'],path,()=>{}),1);
    const again:string[]=[];
    assert.equal(runTeamCommand(['invite','--user','Ada'],path,line=>again.push(line)),0);
    assert.ok(again.some(line=>line.includes('#invite=inv_')));
    assert.equal(runTeamCommand(['invite','--user','Nobody'],path,()=>{}),1);
  }finally{await removeTestTemp(dir);}
});

test('without members the shared Token still signs in phones',async()=>{
  const {dir,store}=await tempStore();const relay=await startRelay(store);
  try{
    const phone=await relay.hello({role:'phone',token:MAIN});
    assert.ok(phone.ready);assert.equal(phone.ready.user,undefined);
    assert.deepEqual(phone.ready.features,['live','sync','blob','blob.image','team']);
  }finally{await relay.close();store.close();await removeTestTemp(dir);}
});

test('a team relay signs in members, stamps who sent each request and records owners',async()=>{
  const {dir,store}=await tempStore();
  const owner=store.createUser({name:'Ada',role:'owner'});
  const member=store.createUser({name:'Bo',role:'member',machines:['pc-a']});
  const relay=await startRelay(store);
  try{
    assert.equal((await relay.hello({role:'phone',token:MAIN})).code,4401);
    const pcA=await relay.connector('pc-a',request=>request.action==='session.create'?{state:'accepted',threadId:'thread-1'}
      :request.action==='sessions.list'?{data:[{id:'thread-1',title:'Fix login',updatedAt:1},{id:'thread-2',title:'Desktop chat',updatedAt:2}]}
      :request.action==='session.read'?{id:request.payload.threadId,turns:[]}:{state:'accepted'});
    await relay.connector('pc-b');

    const adaInvite=store.createInvite(owner.id,null);
    const ada=await relay.hello({role:'phone',invite:adaInvite.code,deviceName:'Mac Chrome'});
    assert.equal(ada.ready.user.name,'Ada');assert.match(ada.ready.deviceToken,/^dev_/);
    assert.deepEqual(ada.ready.machines.map((machine:any)=>machine.id).sort(),['pc-a','pc-b']);
    assert.equal((await relay.hello({role:'phone',invite:adaInvite.code})).code,4401,'an invite works once');
    const adaAgain=await relay.hello({role:'phone',token:ada.ready.deviceToken});
    assert.equal(adaAgain.ready.user.id,owner.id);assert.equal(adaAgain.ready.deviceToken,undefined);

    const bo=await relay.hello({role:'phone',invite:store.createInvite(member.id,owner.id).code});
    assert.deepEqual(bo.ready.machines.map((machine:any)=>machine.id),['pc-a']);
    assert.equal((await relay.request(bo.ws,'pc-b','sessions.list')).error.code,'forbidden');

    // The relay names the sender; an actor the phone adds to its frame never reaches the computer.
    const id='req-forged';const reply=waitFrame(bo.ws,frame=>frame.id===id);
    bo.ws.send(JSON.stringify({type:'request',id,machineId:'pc-a',action:'session.create',payload:{opId:'1:op',cwd:'C:/p'},actor:{userId:owner.id}}));
    assert.equal((await reply).result.threadId,'thread-1');
    assert.deepEqual(pcA.seen.at(-1).actor,{userId:member.id,deviceId:bo.ready.device.id,name:'Bo'});

    const list=await relay.request(ada.ws,'pc-a','sessions.list');
    assert.deepEqual(list.result.data.map((item:any)=>item.owner),[{id:member.id,name:'Bo'},null]);
    const read=await relay.request(ada.ws,'pc-a','session.read',{threadId:'thread-1'});
    assert.deepEqual(read.result.owner,{id:member.id,name:'Bo'});
    assert.deepEqual(read.result.lastSender,{id:member.id,name:'Bo'});

    const activity=await relay.team(ada.ws,'team.activity');
    assert.deepEqual(activity.result.entries.map((entry:any)=>[entry.userName,entry.action,entry.threadId,entry.state]),[['Bo','session.create','thread-1','accepted']]);
    assert.equal((await relay.team(bo.ws,'team.members.list')).error.code,'forbidden');
    assert.equal((await relay.team(bo.ws,'team.activity')).result.entries.length,1,'members see their own activity');

    // Disabling a member closes their devices at once.
    const closed=once(bo.ws,'close');
    assert.equal((await relay.team(ada.ws,'team.members.update',{userId:member.id,status:'disabled'})).result.user.status,'disabled');
    assert.equal((await closed)[0],4401);
  }finally{await relay.close();store.close();await removeTestTemp(dir);}
});

test('a computer given its own token can no longer use the shared one',async()=>{
  const {dir,store}=await tempStore();
  const owner=store.createUser({name:'Ada',role:'owner'});
  const relay=await startRelay(store);
  try{
    await relay.connector('pc-a');
    const ada=await relay.hello({role:'phone',invite:store.createInvite(owner.id,null).code});
    const machines=await relay.team(ada.ws,'team.machines.list');
    assert.deepEqual(machines.result.machines.map((machine:any)=>[machine.id,machine.online,machine.ownToken]),[['pc-a',true,false]]);
    const {token}=(await relay.team(ada.ws,'team.machines.token',{machineId:'pc-a'})).result;
    assert.match(token,/^cnt_/);
    assert.equal((await relay.hello({role:'connector',token:MAIN,machineId:'pc-a',name:'pc-a'})).code,4401);
    assert.ok((await relay.hello({role:'connector',token,machineId:'pc-a',name:'pc-a'})).ready);
    assert.equal((await relay.hello({role:'connector',token,machineId:'pc-b',name:'pc-b'})).code,4401,'the token only fits its own computer');
  }finally{await relay.close();store.close();await removeTestTemp(dir);}
});

test('operations record the member the relay named',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmw-team-ledger-'));const ledger=new Ledger(join(dir,'operations.sqlite'));
  try{
    const id=`${Date.now()}:00000000-0000-4000-8000-000000000001`;
    await requestActor.run({userId:'u1',deviceId:'d1',name:'Bo'},()=>ledger.run(id,{action:'turn.send'},async()=>({threadId:'t'})));
    assert.deepEqual(ledger.actor(id),{userId:'u1',deviceId:'d1',name:'Bo'});
    const anonymous=`${Date.now()}:00000000-0000-4000-8000-000000000002`;
    await ledger.run(anonymous,{action:'turn.send'},async()=>({threadId:'t'}));
    assert.equal(ledger.actor(anonymous),undefined);
  }finally{ledger.close();await removeTestTemp(dir);}
});

test('invite links and codes are recognised wherever they are pasted',()=>{
  assert.equal(inviteCode('https://relay.example/#invite=inv_abc-_9'),'inv_abc-_9');
  assert.equal(inviteCode('  inv_abc  '),'inv_abc');
  assert.equal(inviteCode('0123456789abcdef0123456789abcdef'),null);
  assert.equal(inviteCode('dev_token'),null);
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'),'iPhone Safari');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'),'Windows Edge');
});

test('senders in synced snapshots, pages and frames carry the member’s current name', async () => {
  const {refreshSenderNames}=await import('../src/server/team/actions.js');
  const store={user:(id:string)=>id==='u'?{name:'Current'}:undefined} as any;
  const sender={id:'u',name:'Old'};
  const value={
    entries:[{id:'t',rev:'r',body:{id:'t',items:[{id:'1',text:'hi',sender:{...sender}}]}},{id:'m',rev:'r',body:{id:'m',text:'hi',sender:{...sender}}}],
    patches:[{id:'t',rev:'r',ops:[{i:'2',item:{id:'2',text:'yo',sender:{...sender}}},{i:'1',o:0,t:'x'}],fields:{}}],
  };
  refreshSenderNames(store,value);
  assert.equal(value.entries[0].body.items![0].sender.name,'Current');
  assert.equal(value.entries[1].body.sender!.name,'Current');
  assert.equal((value.patches[0].ops[0] as any).item.sender.name,'Current');
});

test('the data channel signs in members by device and checks their computers on every download',async()=>{
  const {dir,store}=await tempStore();
  const {relay,connector,close}=await startRelay(store);
  try{
    const base=`http://127.0.0.1:${(relay.server.address() as any).port}`;
    const owner=store.createUser({name:'Ada',role:'owner'});store.redeemInvite(store.createInvite(owner.id,null).code,'owner phone');
    const member=store.createUser({name:'Bo',role:'member',machines:['pc-a']});
    const {token,device}=store.redeemInvite(store.createInvite(member.id,null).code,'Bo phone');
    const pulls:string[]=[];
    const a=await connector('pc-a');await connector('pc-b');
    a.ws.on('message',(raw:any)=>{if(JSON.parse(raw.toString()).type==='blob.pull')pulls.push('pc-a');});
    const signIn=(value:string)=>fetch(`${base}/blob/session`,{method:'POST',headers:{Authorization:`Bearer ${value}`}});
    assert.equal((await signIn(MAIN)).status,401,'With a team, the shared token does not sign in.');
    const signed=await signIn(token);
    assert.equal(signed.status,204);
    const cookie=signed.headers.get('set-cookie')!.split(';')[0];
    const file=(machine:string,signal?:AbortSignal)=>fetch(`${base}/blob/${machine}/file?action=file.download&threadId=t&path=x&revision=r`,{headers:{cookie},signal});
    assert.equal((await file('pc-b')).status,403,'A computer the member may not use is refused before it is asked.');
    // The fake computer never sends the file; the download is left waiting and then abandoned.
    const controller=new AbortController(),waiting=file('pc-a',controller.signal).catch(()=>null);
    await new Promise(resolve=>setTimeout(resolve,150));
    controller.abort();await waiting;
    assert.deepEqual(pulls,['pc-a']);
    store.revokeDevice(device.id);
    assert.equal((await file('pc-a')).status,403,'A removed device loses the channel at once.');
  }finally{await close();store.close();await removeTestTemp(dir);}
});
