import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer,type WebSocket} from 'ws';
import {ClaudeVoiceAuth,ClaudeVoiceStreams,proxyFor,readClaudeLogin,VOICE_STREAM_URL} from '../src/connector/claude-voice.js';

const token='claude-login-never-forward';
const pcm=(...samples:number[])=>Buffer.from(new Int16Array(samples).buffer).toString('base64');
const until=async(check:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('timed out');await new Promise(resolve=>setTimeout(resolve,5));}};

type Connection={socket:WebSocket;url:URL;headers:Record<string,string|string[]|undefined>;audio:number[][];text:string[]};
/** Stands in for Claude's dictation service; `reply` answers each connection's frames. */
async function service(t:TestContext,options:{refuse?:(index:number)=>number|undefined;reply?:(connection:Connection,frame:Buffer|string)=>void}={}){
  const server=createServer(),connections:Connection[]=[];
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(request,socket,head)=>{
    const status=options.refuse?.(connections.length);
    if(status){connections.push(undefined as any);socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`);return;}
    wss.handleUpgrade(request,socket,head,ws=>{
      const connection:Connection={socket:ws,url:new URL(request.url!,'ws://service'),headers:request.headers,audio:[],text:[]};connections.push(connection);
      ws.on('message',(data,binary)=>{
        if(binary){const bytes=data as Buffer;connection.audio.push([...new Int16Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length))]);}
        else connection.text.push(data.toString());
        options.reply?.(connection,binary?data as Buffer:data.toString());
      });
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{for(const client of wss.clients)client.terminate();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {endpoint:`ws://127.0.0.1:${(server.address() as any).port}/voice`,connections};
}
/** Echoes how many samples it has heard, and on CloseStream sends a corrected final text. */
function transcriber(final:(heard:number)=>string){
  return (connection:Connection,frame:Buffer|string)=>{
    const heard=connection.audio.flat().length;
    if(typeof frame!=='string')connection.socket.send(JSON.stringify({type:'TranscriptText',data:`听到${heard}`}));
    else if(JSON.parse(frame).type==='CloseStream'){
      connection.socket.send(JSON.stringify({type:'TranscriptText',data:final(heard)}));
      connection.socket.send(JSON.stringify({type:'TranscriptEndpoint'}));
      connection.socket.close();
    }
  };
}
function streams(t:TestContext,endpoint:string,auth=new ClaudeVoiceAuth(async()=>{},async()=>({accessToken:token,expiresAt:Date.now()+3_600_000}))){
  const voice=new ClaudeVoiceStreams(auth,endpoint);t.after(()=>voice.close());return voice;
}

test('the Claude Code login is read from its credentials file and stays on the computer',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'claude-login-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  assert.equal(await readClaudeLogin(dir,'win32'),undefined);
  writeFileSync(join(dir,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:token,refreshToken:'not-used-here',expiresAt:123}}));
  assert.deepEqual(await readClaudeLogin(dir,'win32'),{accessToken:token,expiresAt:123});
  writeFileSync(join(dir,'.credentials.json'),'{"claudeAiOauth":{}}');assert.equal(await readClaudeLogin(dir,'win32'),undefined);
});

test('an expired login is renewed by Claude Code before dictation uses it',async()=>{
  let now=1_000_000,renewals=0,login:any={accessToken:'old',expiresAt:now+30_000};
  const auth=new ClaudeVoiceAuth(async()=>{renewals++;login={accessToken:'new',expiresAt:now+3_600_000};},async()=>login,()=>now);
  assert.equal(await auth.token(),'new');assert.equal(renewals,1);
  assert.equal(await auth.token(),'new');assert.equal(renewals,1);
  // Refused by the service: a renewed token is required, and the same one again is not accepted.
  await assert.rejects(auth.token('new'),(error:any)=>error.code==='voice_auth'&&/过期/.test(error.message));
  login=undefined;await assert.rejects(auth.token(),(error:any)=>error.code==='voice_auth'&&/登录 claude\.ai/.test(error.message));
  now+=10_000_000;login={accessToken:'stale',expiresAt:now-1};
  await assert.rejects(new ClaudeVoiceAuth(async()=>{throw new Error('Claude Code missing');},async()=>login,()=>now).token(),(error:any)=>error.code==='voice_auth');
});

test('audio streams to the service in order with the text so far in every answer; closing returns the corrected text',async t=>{
  const fake=await service(t,{reply:transcriber(heard=>`最终${heard}。`)}),voice=streams(t,fake.endpoint);
  assert.deepEqual(await voice.handle('voice.stream.open',{id:'stream-0001'}),{id:'stream-0001'});
  // Sent before the service answered: queued, then delivered in sequence order.
  assert.deepEqual(await voice.handle('voice.stream.audio',{id:'stream-0001',seq:1,audio:pcm(3,4)}),{text:''});
  await voice.handle('voice.stream.audio',{id:'stream-0001',seq:0,audio:pcm(1,2)});
  await until(()=>fake.connections[0]?.audio.length===2);
  const connection=fake.connections[0];
  assert.deepEqual(connection.audio,[[1,2],[3,4]]);
  assert.equal(connection.headers.authorization,`Bearer ${token}`);assert.equal(connection.headers['user-agent'],'codex-mobile-web');
  assert.deepEqual(Object.fromEntries(connection.url.searchParams),{encoding:'linear16',sample_rate:'16000',channels:'1',endpointing_ms:'300',utterance_end_ms:'1000',language:'zh',use_conversation_engine:'true'});
  await voice.handle('voice.stream.audio',{id:'stream-0001',seq:2,audio:pcm(5)});
  // Each answer carries the newest text the service has sent; an empty send just asks for it.
  let seq=3,answer:any;
  for(const end=Date.now()+3000;!/听到5/.test(answer?.text)&&Date.now()<end;await new Promise(resolve=>setTimeout(resolve,5)))
    answer=await voice.handle('voice.stream.audio',{id:'stream-0001',seq:seq++,audio:''});
  assert.equal(answer.text,'听到5');assert.ok(!JSON.stringify(answer).includes(token));
  assert.deepEqual(await voice.handle('voice.stream.close',{id:'stream-0001',seq}),{text:'最终5。'});
  assert.deepEqual(connection.text.filter(frame=>frame!=='{"type":"KeepAlive"}'),['{"type":"CloseStream"}']);
  await assert.rejects(voice.handle('voice.stream.audio',{id:'stream-0001',seq:4,audio:pcm(6)}),(error:any)=>error.code==='voice_failed');
});

test('a connection the service ends mid-dictation is reopened and keeps the words already heard',async t=>{
  const fake=await service(t,{reply:(connection,frame)=>{
    if(fake.connections.indexOf(connection)===0&&typeof frame!=='string'){connection.socket.send(JSON.stringify({type:'TranscriptText',data:'第一句。'}));connection.socket.close();return;}
    transcriber(()=>'第二句。')(connection,frame);
  }});
  const voice=streams(t,fake.endpoint);
  await voice.handle('voice.stream.open',{id:'stream-0002'});
  await voice.handle('voice.stream.audio',{id:'stream-0002',seq:0,audio:pcm(1)});
  await until(()=>fake.connections[0]?.socket.readyState===3);
  assert.equal((await voice.handle('voice.stream.audio',{id:'stream-0002',seq:1,audio:pcm(2)})).text,'第一句。');
  await until(()=>fake.connections[1]?.audio.length===1);
  assert.deepEqual(await voice.handle('voice.stream.close',{id:'stream-0002',seq:2}),{text:'第一句。第二句。'});
});

test('a refused login is renewed once; other refusals end the dictation with a clear reason',async t=>{
  const tokens:(string|undefined)[]=[];
  const fake=await service(t,{refuse:index=>index===0?401:undefined,reply:transcriber(()=>'ok')});
  const voice=streams(t,fake.endpoint,{token:async(rejected?:string)=>{tokens.push(rejected);return rejected?'renewed':token;}} as unknown as ClaudeVoiceAuth);
  await voice.handle('voice.stream.open',{id:'stream-0003'});await voice.handle('voice.stream.audio',{id:'stream-0003',seq:0,audio:pcm(1)});
  await until(()=>fake.connections[1]?.audio.length===1);
  assert.deepEqual(tokens,[undefined,token]);assert.equal(fake.connections[1].headers.authorization,'Bearer renewed');
  assert.deepEqual(await voice.handle('voice.stream.close',{id:'stream-0003',seq:1}),{text:'ok'});
  for(const [status,code] of [[429,'voice_limit'],[403,'voice_auth'],[500,'voice_failed']] as const){
    const refused=await service(t,{refuse:()=>status}),other=streams(t,refused.endpoint,{token:async()=>token} as unknown as ClaudeVoiceAuth);
    await other.handle('voice.stream.open',{id:'stream-0004'});
    // The refusal reaches the phone with the next send after the connector learns of it.
    let failure:any;
    for(let seq=0,end=Date.now()+3000;!failure&&Date.now()<end;seq++){
      failure=await other.handle('voice.stream.audio',{id:'stream-0004',seq,audio:pcm(1)}).then(()=>undefined,error=>error);
      if(!failure)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(failure?.code,code);assert.ok(!failure.message.includes(token));
  }
});

test('requests are validated; stopping without audio and cancelling end at once',async t=>{
  const fake=await service(t,{reply:transcriber(()=>'unused')}),voice=streams(t,fake.endpoint);
  for(const id of [undefined,'short','x'.repeat(65),'has space!'])await assert.rejects(voice.handle('voice.stream.open',{id}),(error:any)=>error.code==='invalid');
  await voice.handle('voice.stream.open',{id:'stream-0005'});
  for(const payload of [{seq:-1,audio:pcm(1)},{seq:1.5,audio:pcm(1)},{seq:0,audio:'AQ'},{seq:0,audio:'not base64!'},{seq:0,audio:'A'.repeat(700_000)}])
    await assert.rejects(voice.handle('voice.stream.audio',{id:'stream-0005',...payload}),(error:any)=>error.code==='invalid');
  const started=Date.now();assert.deepEqual(await voice.handle('voice.stream.close',{id:'stream-0005',seq:0}),{text:''});assert.ok(Date.now()-started<500);
  await voice.handle('voice.stream.open',{id:'stream-0006'});await voice.handle('voice.stream.audio',{id:'stream-0006',seq:0,audio:pcm(1)});
  await until(()=>fake.connections.length>0);
  assert.deepEqual(await voice.handle('voice.stream.cancel',{id:'stream-0006'}),{cancelled:true});
  await assert.rejects(voice.handle('voice.stream.audio',{id:'stream-0006',seq:1,audio:pcm(1)}),(error:any)=>error.code==='voice_failed');
});

test('the service is reached through the HTTPS proxy unless NO_PROXY exempts it',async t=>{
  assert.equal(proxyFor(VOICE_STREAM_URL,{HTTPS_PROXY:'http://127.0.0.1:7890'})?.href,'http://127.0.0.1:7890/');
  assert.equal(proxyFor(VOICE_STREAM_URL,{HTTP_PROXY:'http://proxy.local:8080'})?.host,'proxy.local:8080');
  for(const exempt of ['anthropic.com','.anthropic.com','api.anthropic.com:443','*','localhost, *.anthropic.com'])
    assert.equal(proxyFor(VOICE_STREAM_URL,{HTTPS_PROXY:'http://127.0.0.1:7890',NO_PROXY:exempt}),undefined,exempt);
  assert.ok(proxyFor(VOICE_STREAM_URL,{HTTPS_PROXY:'http://127.0.0.1:7890',NO_PROXY:'notanthropic.com'}));
  assert.equal(proxyFor(VOICE_STREAM_URL,{HTTPS_PROXY:'socks5://127.0.0.1:1080'}),undefined);
  const requests:{target?:string;headers:Record<string,unknown>}[]=[];
  const proxy=createServer();
  proxy.on('connect',(request,socket)=>{
    requests.push({target:request.url,headers:request.headers});
    // Refused before TLS: no audio or login leaves this fixture.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');t.after(()=>new Promise<void>(resolve=>proxy.close(()=>resolve())));
  const voice=new ClaudeVoiceStreams({token:async()=>token} as unknown as ClaudeVoiceAuth,VOICE_STREAM_URL,Date.now,{HTTPS_PROXY:`http://user:pa%40ss@127.0.0.1:${(proxy.address() as any).port}`});
  t.after(()=>voice.close());
  await voice.handle('voice.stream.open',{id:'stream-0007'});
  await until(()=>requests.length>0);
  assert.equal(requests[0].target,'api.anthropic.com:443');
  assert.equal(requests[0].headers['proxy-authorization'],'Basic '+Buffer.from('user:pa@ss').toString('base64'));
  assert.ok(!JSON.stringify(requests[0].headers).includes(token));
});
