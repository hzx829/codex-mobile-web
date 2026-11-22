import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WebSocket} from 'ws';
import {createRelay} from '../src/server/relay.js';
import {transcribeVoice} from '../src/connector/voice.js';
import {Control} from '../src/connector/control.js';
import {Ledger} from '../src/connector/ledger.js';
import {MAX_FRAME} from '../src/shared/types.js';
import {MAX_VOICE_BYTES,MAX_VOICE_DURATION_MS,voiceProvider,type VoiceRecording} from '../src/shared/voice.js';
import {applyDictation,createVoiceInput,joinDictation,type DictationSpan,type VoiceCallbacks,type VoiceState} from '../web/voice-input.js';
import {Client} from '../web/client.js';

const recording:VoiceRecording={audio:Buffer.from('recorded audio fixture').toString('base64'),mimeType:'audio/webm',durationMs:1200};
const auth={authMethod:'chatgpt',authToken:'test-credential-never-forward'};
const runtime=(rpc:Function=async()=>auth)=>({rpc}) as any;
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function replaceGlobal(t:TestContext,key:string,value:unknown){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);});
}

test('transcription uploads audio with local Codex auth and returns only text',async()=>{
  for(const [mimeType,extension] of [['audio/webm','webm'],['audio/mp4','m4a'],['audio/ogg','ogg']]){
    const result=await transcribeVoice(runtime(async(method:string,params:any)=>{
      assert.equal(method,'getAuthStatus');assert.deepEqual(params,{includeToken:true,refreshToken:false});return auth;
    }),{...recording,mimeType},async(url,options)=>{
      assert.equal(url,'https://chatgpt.com/backend-api/transcribe');assert.equal(options?.redirect,'error');
      assert.equal(new Headers(options?.headers).get('Authorization'),`Bearer ${auth.authToken}`);
      const file=(options!.body as FormData).get('file') as File;
      assert.equal(file.name,`codex.${extension}`);assert.equal(file.type,mimeType);assert.equal(await file.text(),'recorded audio fixture');
      return Response.json({text:'  识别的文字  ',authToken:'do-not-forward',extra:true});
    });
    assert.deepEqual(result,{text:'识别的文字'});assert.ok(!JSON.stringify(result).includes(auth.authToken));
  }
});

test('unauthorized transcription refreshes local auth once without forwarding provider failures',async()=>{
  const refresh:boolean[]=[],tokens:string[]=[];
  const result=await transcribeVoice(runtime(async(_method:string,params:any)=>{refresh.push(params.refreshToken);return {...auth,authToken:params.refreshToken?'fresh':'old'};}),recording,async(_url,options)=>{
    tokens.push(new Headers(options?.headers).get('Authorization')!);
    return tokens.length===1?new Response('private failure',{status:401}):Response.json({text:'ok'});
  });
  assert.deepEqual(result,{text:'ok'});assert.deepEqual(refresh,[false,true]);assert.deepEqual(tokens,['Bearer old','Bearer fresh']);
  let calls=0;
  await assert.rejects(transcribeVoice(runtime(),recording,async()=>{calls++;return new Response(auth.authToken,{status:401});}),(error:any)=>error.code==='voice_auth'&&!error.message.includes(auth.authToken));
  assert.equal(calls,2);
});

test('API-key auth and invalid recordings never reach the transcription service',async()=>{
  let uploads=0,authReads=0;
  const upload=async()=>{uploads++;return Response.json({text:'unexpected'});};
  await assert.rejects(transcribeVoice(runtime(async()=>({authMethod:'apikey',authToken:'test-api-key'})),recording,upload),(e:any)=>e.code==='voice_auth');
  for(const payload of [{...recording,audio:''},{...recording,audio:'bad!base64'}, {...recording,audio:'YQ'}, {...recording,audio:'A'.repeat(4*Math.ceil(MAX_VOICE_BYTES/3)+4)}, {...recording,mimeType:'text/html'}, {...recording,mimeType:'__proto__'}, {...recording,durationMs:NaN}, {...recording,durationMs:MAX_VOICE_DURATION_MS+3000}]){
    await assert.rejects(transcribeVoice(runtime(async()=>{authReads++;return auth;}),payload,upload),(e:any)=>e.code==='invalid_audio');
  }
  assert.equal(uploads,0);assert.equal(authReads,0);
  assert.ok(Buffer.byteLength(JSON.stringify({type:'request',action:'voice.transcribe',payload:{...recording,audio:Buffer.alloc(MAX_VOICE_BYTES).toString('base64')}}))<MAX_FRAME);
});

test('provider errors and empty transcripts are actionable without leaking response bodies',async()=>{
  for(const status of [403,429,500])await assert.rejects(transcribeVoice(runtime(),recording,async()=>new Response(auth.authToken,{status})),(e:any)=>!e.message.includes(auth.authToken)&&e.code.startsWith('voice_'));
  await assert.rejects(transcribeVoice(runtime(),recording,async()=>{throw new Error(auth.authToken);}),(e:any)=>e.code==='voice_failed'&&!e.message.includes(auth.authToken));
  await assert.rejects(transcribeVoice(runtime(),recording,async()=>Response.json({text:'  '})),(e:any)=>e.code==='voice_empty');
  await assert.rejects(transcribeVoice(runtime(),recording,async()=>new Response('not json')),(e:any)=>e.code==='voice_failed');
});

test('default transcription transport uses the configured HTTPS proxy without global proxy flags',async t=>{
  const requests:{target:string|undefined;authorization:string|undefined}[]=[];
  const proxy=createServer();
  proxy.on('connect',(request,socket)=>{
    requests.push({target:request.url,authorization:request.headers.authorization});
    // Fail locally before TLS: no audio or credentials leave this fixture.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(()=>new Promise<void>(resolve=>proxy.close(()=>resolve())));
  const proxyUrl=`http://127.0.0.1:${(proxy.address() as any).port}`;
  for(const key of ['HTTPS_PROXY','https_proxy','HTTP_PROXY']){
    const env={...process.env};
    for(const name of Object.keys(env))if(/^(https?_proxy|no_proxy|all_proxy|node_use_env_proxy|node_options)$/i.test(name))delete env[name];
    env[key]=proxyUrl;
    const script=`
      import assert from 'node:assert/strict';
      import {transcribeVoice} from ${JSON.stringify(new URL('../src/connector/voice.ts',import.meta.url).href)};
      const runtime={rpc:async()=>(${JSON.stringify(auth)})};
      await assert.rejects(transcribeVoice(runtime,${JSON.stringify(recording)}),error=>error.code==='voice_failed'&&!error.message.includes(${JSON.stringify(auth.authToken)}));
    `;
    await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script],{env,windowsHide:true,timeout:15000});
    assert.equal(requests.length,['HTTPS_PROXY','https_proxy','HTTP_PROXY'].indexOf(key)+1);
    assert.deepEqual(requests.at(-1),{target:'chatgpt.com:443',authorization:undefined});
  }
});

test('control routes dictation without creating a conversation or storing an operation',async t=>{
  class Runtime extends EventEmitter{requests=new Map();rpc=async(method:string)=>{assert.equal(method,'getAuthStatus');return auth;};close(){}}
  class Desktop extends EventEmitter{close(){}}
  t.mock.method(globalThis,'fetch',async()=>Response.json({text:'draft only'}));
  const ledger=new Ledger(':memory:'),control=new Control(ledger,new Runtime() as any,new Desktop() as any);
  try{
    assert.deepEqual(await control.handle({id:'voice',action:'voice.transcribe',payload:recording}),{text:'draft only'});
    assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM operations').get()!.count,0);
  }finally{control.close();}
});

const drain=async()=>{for(let i=0;i<5;i++)await flush();};
function captureFixture(t:TestContext,options:{permission?:Promise<any>;transcript?:Promise<{text:string}>;secure?:boolean;mime?:string;empty?:boolean}={}){
  const states:VoiceState[]=[],texts:string[]=[],errors:Error[]=[],uploads:VoiceRecording[]=[];
  let stopped=0,requested=0,keyboard=0;
  const track={stop(){stopped++;},onended:null as null|(()=>void)},stream={getTracks:()=>[track]};
  class Recorder{
    static latest:Recorder;
    static isTypeSupported(type:string){return type===(options.mime||'audio/webm;codecs=opus');}
    state='inactive';mimeType=options.mime||'audio/webm;codecs=opus';
    ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror:(()=>void)|null=null;
    constructor(){Recorder.latest=this;}
    start(){this.state='recording';}
    stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(options.empty?[]:['recorded bytes'])});this.onstop?.();});}
  }
  replaceGlobal(t,'isSecureContext',options.secure??true);
  replaceGlobal(t,'navigator',{mediaDevices:{getUserMedia:()=>{requested++;return options.permission||Promise.resolve(stream);}}});
  replaceGlobal(t,'MediaRecorder',Recorder);
  const callbacks:VoiceCallbacks={state:state=>states.push(state),text:text=>texts.push(text),live:()=>{throw new Error('Codex does not stream');},error:error=>errors.push(error),keyboard:()=>{keyboard++;},
    transcribe:async audio=>{uploads.push(audio);return options.transcript||{text:'  hello  '};},stream:async()=>{throw new Error('Codex does not stream');}};
  const input=createVoiceInput('codex',callbacks);t.after(()=>input.cancel());
  return {input,callbacks,states,texts,errors,uploads,stream,track,Recorder,stopped:()=>stopped,requested:()=>requested,keyboard:()=>keyboard};
}

test('factory keeps keyboard input free of browser capture and remote requests; Claude is the default',t=>{
  const f=captureFixture(t,{secure:false});
  assert.equal(voiceProvider('keyboard'),'keyboard');assert.equal(voiceProvider('codex'),'codex');assert.equal(voiceProvider('invalid'),'claude');assert.equal(voiceProvider(undefined),'claude');
  const keyboard=createVoiceInput('keyboard',f.callbacks);keyboard.start();keyboard.stop();keyboard.cancel();
  assert.equal(f.keyboard(),1);assert.equal(f.requested(),0);assert.equal(f.uploads.length,0);
});

test('Codex capture records one clip, stops the microphone, and fills text only after stopping',async t=>{
  const f=captureFixture(t,{mime:'audio/mp4'});f.input.start();f.input.start();await flush();
  assert.equal(f.requested(),1);assert.deepEqual(f.states,['starting','recording']);assert.equal(f.uploads.length,0);
  f.input.stop();await flush();
  assert.equal(f.stopped(),1);assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].mimeType,'audio/mp4');
  assert.equal(Buffer.from(f.uploads[0].audio,'base64').toString(),'recorded bytes');assert.deepEqual(f.texts,['hello']);assert.equal(f.states.at(-1),'idle');
});

test('cancelling while permission is pending releases a late stream without uploading',async t=>{
  let grant!:(stream:any)=>void;
  const f=captureFixture(t,{permission:new Promise(resolve=>{grant=resolve;})});f.input.start();f.input.cancel();grant(f.stream);await flush();
  assert.equal(f.stopped(),1);assert.equal(f.uploads.length,0);assert.equal(f.errors.length,0);assert.equal(f.states.at(-1),'idle');
});

test('cancelling capture discards audio; late transcription cannot change another draft',async t=>{
  let resolve!:(value:{text:string})=>void;
  const f=captureFixture(t,{transcript:new Promise(done=>{resolve=done;})});f.input.start();await flush();f.input.stop();await flush();
  assert.equal(f.uploads.length,1);f.input.cancel();resolve({text:'old conversation'});await flush();assert.deepEqual(f.texts,[]);
  const second=createVoiceInput('codex',f.callbacks);second.start();await flush();second.cancel();await flush();assert.equal(f.uploads.length,1);assert.equal(f.stopped(),2);
});

test('dictated pieces join with a space between Latin words and nothing between Chinese ones',()=>{
  assert.equal(joinDictation('','你好'),'你好');assert.equal(joinDictation('  ','你好'),'你好');
  assert.equal(joinDictation('你好，','世界'),'你好，世界');assert.equal(joinDictation('fix the bug.','Then deploy'),'fix the bug. Then deploy');
  assert.equal(joinDictation('第一行\n','第二行'),'第一行\n第二行');assert.equal(joinDictation('打开 README','然后'),'打开 README然后');
  assert.equal(joinDictation('kept',''),'kept');
});

test('Codex recording limit stops capture; interrupted tracks and insecure pages never upload',async t=>{
  const f=captureFixture(t);t.mock.timers.enable({apis:['setTimeout','Date']});f.input.start();await flush();
  t.mock.timers.tick(MAX_VOICE_DURATION_MS);await flush();assert.equal(f.stopped(),1);assert.equal(f.uploads[0].durationMs,MAX_VOICE_DURATION_MS);
  const second=createVoiceInput('codex',f.callbacks);second.start();await flush();f.track.onended?.();await flush();assert.equal(f.uploads.length,1);assert.match(f.errors.at(-1)!.message,/中断/);
  replaceGlobal(t,'isSecureContext',false);const third=createVoiceInput('codex',f.callbacks);third.start();await flush();assert.equal(f.requested(),2);assert.match(f.errors.at(-1)!.message,/HTTPS/);
});

test('streamed text replaces what this dictation wrote and leaves the person\'s own edits alone',()=>{
  let draft='已有内容。',span:DictationSpan=null;
  const hear=(text:string)=>{({draft,span}=applyDictation(draft,span,text));return draft;};
  assert.equal(hear(''),'已有内容。');
  assert.equal(hear('帮我'),'已有内容。帮我');assert.equal(hear('帮我看一下'),'已有内容。帮我看一下');
  // The final pass may correct earlier words.
  assert.equal(hear('帮我看一下，'),'已有内容。帮我看一下，');
  // Text typed before the dictated words stays, and the dictated words keep updating.
  draft='已有内容。请帮我看一下，';
  assert.equal(hear('帮我看一下，延迟'),'已有内容。请帮我看一下，延迟');
  // The person fixes a dictated word; only words heard afterwards are added.
  draft='已有内容。请帮我瞧一下，延迟';
  assert.equal(hear('帮我看一下，延迟问题'),'已有内容。请帮我瞧一下，延迟问题');assert.equal(hear('帮我看一下，延迟问题，然后'),'已有内容。请帮我瞧一下，延迟问题，然后');
  // A correction to words they took over is not applied over theirs.
  assert.equal(hear('帮我看看，延迟问题，然后。'),'已有内容。请帮我瞧一下，延迟问题，然后');
  let latin='fix the bug.',latinSpan:DictationSpan=null;
  ({draft:latin,span:latinSpan}=applyDictation(latin,latinSpan,'Then'));({draft:latin}=applyDictation(latin,latinSpan,'Then deploy'));
  assert.equal(latin,'fix the bug. Then deploy');
});

/** A browser with an audio worklet; `post` feeds captured PCM as the worklet would. */
function streamFixture(t:TestContext,options:{open?:()=>Promise<any>;audio?:(payload:any)=>Promise<any>;close?:(payload:any)=>Promise<any>;worklet?:boolean;permission?:Promise<any>}={}){
  const states:VoiceState[]=[],live:string[]=[],errors:Error[]=[],requests:{action:string;payload:any}[]=[],modules:string[]=[];
  let stopped=0,closedContexts=0;
  const track={stop(){stopped++;},onended:null as null|(()=>void)},stream={getTracks:()=>[track]};
  class Port{
    onmessage:((event:{data:any})=>void)|null=null;listeners:((event:{data:any})=>void)[]=[];tail:ArrayBuffer|null=null;
    addEventListener(_type:string,listener:(event:{data:any})=>void){this.listeners.push(listener);}
    emit(data:any){this.onmessage?.({data});for(const listener of this.listeners)listener({data});}
    postMessage(message:any){if(message==='flush')queueMicrotask(()=>{if(this.tail)this.emit(this.tail);this.emit('flushed');});}
  }
  class Worklet{static latest:Worklet;port=new Port();constructor(){Worklet.latest=this;}connect(){}disconnect(){}}
  class Context{
    state='suspended';destination={};
    audioWorklet=options.worklet===false?undefined:{addModule:async(url:string)=>{modules.push(url);}};
    createGain(){return {gain:{value:1},connect(){}};}
    createMediaStreamSource(){return {connect(){}};}
    resume(){this.state='running';return Promise.resolve();}
    close(){this.state='closed';closedContexts++;return Promise.resolve();}
  }
  replaceGlobal(t,'isSecureContext',true);
  replaceGlobal(t,'navigator',{mediaDevices:{getUserMedia:()=>options.permission||Promise.resolve(stream)}});
  replaceGlobal(t,'AudioContext',Context);replaceGlobal(t,'AudioWorkletNode',Worklet);
  const callbacks:VoiceCallbacks={state:state=>states.push(state),text:()=>{throw new Error('streamed text replaces');},live:text=>live.push(text),error:error=>errors.push(error),keyboard:()=>{},
    transcribe:async()=>{throw new Error('Claude streams');},
    stream:async(action,payload)=>{
      requests.push({action,payload});
      if(action==='voice.stream.open')return options.open?options.open():{id:payload.id};
      if(action==='voice.stream.audio')return options.audio?options.audio(payload):{text:`heard ${payload.seq}`};
      if(action==='voice.stream.close')return options.close?options.close(payload):{text:'final text'};
      return {cancelled:true};
    }};
  const input=createVoiceInput('claude',callbacks);t.after(()=>input.cancel());
  const post=(...samples:number[])=>Worklet.latest.port.emit(new Int16Array(samples).buffer);
  return {input,states,live,errors,requests,modules,post,Worklet,track,stopped:()=>stopped,closedContexts:()=>closedContexts};
}

test('Claude dictation streams PCM in order and fills the draft with the text so far',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f=streamFixture(t);f.input.start();await drain();
  assert.deepEqual(f.states,['starting','recording']);assert.deepEqual(f.modules,['/pcm-worklet.js']);
  const id=f.requests[0].payload.id;assert.equal(f.requests[0].action,'voice.stream.open');assert.match(id,/^[0-9a-f]{32}$/);
  t.mock.timers.tick(200);await drain();assert.equal(f.requests.length,1,'nothing captured, nothing sent');
  f.post(1,2);f.post(3);t.mock.timers.tick(200);await drain();
  assert.deepEqual(f.requests[1],{action:'voice.stream.audio',payload:{id,seq:0,audio:Buffer.from(new Int16Array([1,2,3]).buffer).toString('base64')}});
  assert.deepEqual(f.live,['heard 0']);
  f.post(4);t.mock.timers.tick(200);await drain();assert.equal(f.requests[2].payload.seq,1);
  // Stopping sends the worklet's last samples, then asks for the final text.
  f.Worklet.latest.port.tail=new Int16Array([5]).buffer;f.input.stop();await drain();
  assert.deepEqual(f.requests.slice(3).map(r=>[r.action,r.payload.seq]),[['voice.stream.audio',2],['voice.stream.close',3]]);
  assert.deepEqual(f.live,['heard 0','heard 1','heard 2','final text']);
  assert.equal(f.stopped(),1);assert.equal(f.closedContexts(),1);assert.equal(f.states.at(-1),'idle');assert.equal(f.errors.length,0);
  assert.ok(!f.requests.some(r=>r.action==='voice.stream.cancel'),'a finished dictation is not cancelled');
});

test('Claude dictation shows only the newest answer and gathers audio while sends are slow',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const answers:((value:any)=>void)[]=[];
  const f=streamFixture(t,{audio:payload=>new Promise(resolve=>{answers[payload.seq]=resolve;})});f.input.start();await drain();
  for(let i=0;i<6;i++){f.post(i);t.mock.timers.tick(200);await drain();}
  // Four sends wait for answers; the rest of the audio waits to go in one piece.
  assert.equal(f.requests.filter(r=>r.action==='voice.stream.audio').length,4);
  answers[1]({text:'newer'});await drain();answers[0]({text:'older'});await drain();
  assert.deepEqual(f.live,['newer']);
  t.mock.timers.tick(200);await drain();
  const merged=f.requests.filter(r=>r.action==='voice.stream.audio')[4].payload;
  assert.equal(merged.seq,4);assert.deepEqual([...new Int16Array(new Uint8Array(Buffer.from(merged.audio,'base64')).buffer)],[4,5]);
});

test('Claude dictation failures keep the text already written and release the microphone',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const f=streamFixture(t,{audio:payload=>payload.seq===0?Promise.resolve({text:'kept'}):Promise.reject({code:'voice_limit',message:'Claude 语音识别暂时达到限额'})});
  f.input.start();await drain();f.post(1);t.mock.timers.tick(200);await drain();f.post(2);t.mock.timers.tick(200);await drain();
  assert.deepEqual(f.live,['kept']);assert.match(f.errors[0].message,/限额/);assert.equal(f.stopped(),1);assert.equal(f.states.at(-1),'idle');
  assert.equal(f.requests.at(-1)!.action,'voice.stream.cancel');
  // A computer whose connector predates streaming says so.
  const old=streamFixture(t,{open:()=>Promise.reject({code:'unsupported',message:'此操作暂不支持'})});old.input.start();await drain();
  assert.match(old.errors[0].message,/连接器版本较旧/);
  const unsupported=streamFixture(t,{worklet:false});unsupported.input.start();await drain();
  assert.match(unsupported.errors[0].message,/切换识别方式/);assert.equal(unsupported.requests.length,0);
});

test('Claude dictation without words says so; cancelling tells the computer and ignores late answers',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const silent=streamFixture(t,{close:async()=>({text:''})});silent.input.start();await drain();silent.input.stop();await drain();
  assert.match(silent.errors[0].message,/没有录到声音/);
  let answer!:(value:any)=>void;
  const f=streamFixture(t,{audio:()=>new Promise(resolve=>{answer=resolve;})});f.input.start();await drain();
  f.post(1);t.mock.timers.tick(200);await drain();f.input.cancel();answer({text:'too late'});await drain();
  assert.deepEqual(f.live,[]);assert.equal(f.requests.at(-1)!.action,'voice.stream.cancel');assert.equal(f.stopped(),1);assert.equal(f.states.at(-1),'idle');
  let grant!:(stream:any)=>void;
  const pending=streamFixture(t,{permission:new Promise(resolve=>{grant=resolve;})});pending.input.start();pending.input.cancel();grant({getTracks:()=>[pending.track]});await drain();
  assert.equal(pending.stopped(),1);assert.ok(!pending.requests.some(r=>r.action==='voice.stream.audio'));
});

test('microphone denial never uploads or changes the draft',async t=>{
  const permission=Promise.reject(new DOMException('denied','NotAllowedError'));
  const f=captureFixture(t,{permission});f.input.start();await flush();assert.match(f.errors[0].message,/允许/);assert.equal(f.states.at(-1),'idle');assert.equal(f.uploads.length,0);assert.equal(f.texts.length,0);
});

test('empty captures and recorder failures release the microphone without uploading',async t=>{
  const f=captureFixture(t,{empty:true});f.input.start();await flush();f.input.stop();await flush();
  assert.equal(f.stopped(),1);assert.equal(f.uploads.length,0);assert.match(f.errors[0].message,/没有录到/);
  const next=createVoiceInput('codex',f.callbacks);next.start();await flush();
  f.Recorder.latest.stop=()=>{throw new Error('recorder stopped unexpectedly');};next.stop();
  assert.equal(f.stopped(),2);assert.equal(f.states.at(-1),'idle');assert.equal(f.texts.length,0);
});

test('relay acknowledges audio and keeps its route alive beyond the ordinary timeout',async t=>{
  const relay=createRelay('voice-fixture',undefined,0);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  const address=`ws://127.0.0.1:${(relay.server.address() as any).port}/ws`;
  function frame(socket:WebSocket,predicate:(message:any)=>boolean):Promise<any>{return new Promise(resolve=>{
    const listen=(data:any)=>{const message=JSON.parse(data.toString());if(predicate(message)){socket.off('message',listen);resolve(message);}};socket.on('message',listen);
  });}
  async function peer(role:string){const socket=new WebSocket(address);await once(socket,'open');const ready=frame(socket,m=>m.type==='ready');socket.send(JSON.stringify({type:'hello',token:'voice-fixture',role,machineId:'voice-pc',name:'PC'}));await ready;return socket;}
  try{
    const connector=await peer('connector'),phone=await peer('phone');
    t.mock.timers.enable({apis:['setTimeout']});
    const received=frame(phone,m=>m.type==='received'),routed=frame(connector,m=>m.type==='request');
    const responses:any[]=[];phone.on('message',data=>{const message=JSON.parse(data.toString());if(message.type==='response')responses.push(message);});
    phone.send(JSON.stringify({type:'request',id:'voice-request',machineId:'voice-pc',action:'voice.transcribe',payload:recording}));
    assert.equal((await received).id,'voice-request');const request=await routed;assert.deepEqual(request.payload,recording);
    t.mock.timers.tick(60_000);await flush();assert.equal(responses.length,0);
    const response=frame(phone,m=>m.type==='response');connector.send(JSON.stringify({type:'response',id:request.id,result:{text:'recognized'}}));
    assert.deepEqual(await response,{type:'response',id:'voice-request',result:{text:'recognized'}});
  }finally{t.mock.timers.reset();await relay.close();}
});

test('voice requests allow slow uploads and transcription after the relay receipt',async t=>{
  class Socket{
    static latest:Socket;onopen:(()=>void)|null=null;onmessage:((e:{data:string})=>void)|null=null;onclose:(()=>void)|null=null;sent:any[]=[];
    constructor(){Socket.latest=this;}
    send(data:string){this.sent.push(JSON.parse(data));}close(){}
    receive(data:any){this.onmessage?.({data:JSON.stringify(data)});}
  }
  replaceGlobal(t,'WebSocket',Socket);replaceGlobal(t,'location',{protocol:'https:',host:'bridge.test'});
  t.mock.timers.enable({apis:['setTimeout']});
  const client=new Client('fixture',()=>{},()=>{});t.after(()=>client.close());Socket.latest.receive({type:'ready'});
  let failure:unknown;const result=client.request('voice.transcribe',recording,'selected-pc').catch(error=>{failure=error;});
  const request=Socket.latest.sent.at(-1);assert.equal(request.machineId,'selected-pc');
  t.mock.timers.tick(60_000);await flush();assert.equal(failure,undefined);
  Socket.latest.receive({type:'received',id:request.id});t.mock.timers.tick(60_000);await flush();assert.equal(failure,undefined);
  Socket.latest.receive({type:'response',id:request.id,result:{text:'done'}});assert.deepEqual(await result,{text:'done'});
});

test('the audio worklet turns any device rate into 16 kHz 16-bit PCM about every 100 ms',async()=>{
  const {runInNewContext}=await import('node:vm'),{readFileSync}=await import('node:fs');
  const code=readFileSync(new URL('../web/public/pcm-worklet.js',import.meta.url),'utf8');
  for(const rate of [48_000,44_100,16_000]){
    let Processor:any;const posted:any[]=[];
    runInNewContext(code,{sampleRate:rate,AudioWorkletProcessor:class{port={postMessage:(message:any)=>posted.push(message),onmessage:null as any};},registerProcessor:(name:string,value:any)=>{assert.equal(name,'pcm-16k');Processor=value;}});
    const processor=new Processor();
    // One second of a 440 Hz tone at half scale, in the 128-sample blocks a browser renders.
    const input=Float32Array.from({length:rate},(_,i)=>0.5*Math.sin(2*Math.PI*440*i/rate));
    for(let offset=0;offset<input.length;offset+=128)assert.equal(processor.process([[input.subarray(offset,offset+128)]]),true);
    processor.port.onmessage({data:'flush'});
    assert.equal(posted.at(-1),'flushed');
    const chunks=posted.filter(message=>Object.prototype.toString.call(message)==='[object ArrayBuffer]').map(buffer=>new Int16Array(buffer));
    assert.ok(chunks.slice(0,-1).every(chunk=>chunk.length===1600),'100 ms chunks');
    const samples=chunks.reduce((sum,chunk)=>sum+chunk.length,0),peak=Math.max(...chunks.flatMap(chunk=>[...chunk]));
    assert.ok(Math.abs(samples-16_000)<=1,`${rate}: ${samples} samples`);
    assert.ok(peak>0.45*0x7fff&&peak<=0.5*0x7fff+1,`${rate}: peak ${peak}`);
    assert.equal(processor.process([[]]),true,'a block without input keeps the node alive');
  }
});
