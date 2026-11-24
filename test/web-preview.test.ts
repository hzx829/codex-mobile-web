import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {BrowserPreview,lanAddress,previewAddress} from '../src/connector/browser-preview.js';
import {lanHost,previewRoute,samePreviewTarget} from '../web/preview-target.js';
import {desktopFrame,previewWidthKey,reachable} from '../web/thread-preview.js';

test('an address alone decides how its page reaches the phone',()=>{
  for(const url of ['https://claude.ai/artifact/abcdefgh1234','https://claude.ai/code/artifact/abcdefgh1234'])assert.equal(previewRoute(url),'artifact');
  for(const url of ['http://localhost:5173','http://127.0.0.1:3000/a','http://[::1]:8080','http://192.168.1.20:5173','https://10.0.0.8','http://172.16.0.1','http://172.31.255.1','http://[fd12:3456::1]:80','http://devbox.local:3000','http://devbox:3000',' http://192.168.1.20 '])assert.equal(previewRoute(url),'tunnel',url);
  for(const url of ['https://example.com','https://claude.ai/new','https://172.32.0.1','https://8.8.8.8'])assert.equal(previewRoute(url),'direct',url);
  for(const url of ['http://example.com','http://172.15.0.1','http://169.254.169.254','http://[2001:db8::1]'])assert.equal(previewRoute(url),'external',url);
  // A relay served over plain http can frame plain http pages.
  assert.equal(previewRoute('http://example.com',false),'direct');
  for(const url of ['','example.com','ftp://example.com','file:///C:/a.html','javascript:alert(1)','http://user:pass@192.168.1.2','https://user@example.com'])assert.equal(previewRoute(url),null,url);
  assert.equal(lanHost('192.168.1.2.example.com'),false);assert.equal(lanHost('10.example.com'),false);
});

test('direct pages are tabs of their own thread',()=>{
  const site={kind:'site' as const,machineId:'pc',threadId:'a',url:'https://example.com/'};
  assert.equal(samePreviewTarget(site,{...site}),true);
  assert.equal(samePreviewTarget(site,{...site,url:'https://example.com/b'}),false);
  assert.equal(samePreviewTarget(site,{...site,threadId:'b'}),false);
  assert.notEqual(previewWidthKey('pc','a'),previewWidthKey('pc','b'));
});

test('a desktop-wide frame is shrunk to fill its box and left alone when the box is wide enough',()=>{
  assert.deepEqual(desktopFrame(640,360,1280),{width:1280,height:720,scale:.5});
  const phone=desktopFrame(900,400,1920)!;
  assert.equal(phone.width,1920);assert.ok(Math.abs(phone.width*phone.scale-900)<1e-9);assert.ok(phone.height*phone.scale>=400&&phone.height*phone.scale<401);
  for(const [w,h,width] of [[1400,800,1280],[1280,800,1280],[900,400,0],[0,400,1280],[900,0,1280]])assert.equal(desktopFrame(w,h,width),null);
});

test('probing a page counts any answer as reachable and gives up on silence',async()=>{
  let seen:any;
  assert.equal(await reachable('https://example.com',50,(async(_url:any,init:any)=>{seen=init;return new Response('');}) as any),true);
  assert.equal(seen.mode,'no-cors');assert.equal(seen.credentials,'omit');
  assert.equal(await reachable('https://example.com',50,(async()=>{throw new TypeError('failed');}) as any),false);
  assert.equal(await reachable('https://example.com',20,((_url:any,init:any)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted'))))) as any),false);
});

test('the connector relays private-network pages only, and only when allowed to',async()=>{
  for(const address of ['10.1.2.3','172.16.0.1','172.31.9.9','192.168.0.9','127.0.0.1','::1','fd00::1','::ffff:192.168.1.1'])assert.equal(lanAddress(address),true,address);
  for(const address of ['8.8.8.8','172.32.0.1','169.254.169.254','fe80::1','2001:db8::1','::ffff:8.8.8.8','devbox'])assert.equal(lanAddress(address),false,address);
  const resolve=async(host:string)=>host==='devbox.local'?[{address:'192.168.1.20',family:4}]:host==='mixed.example'?[{address:'192.168.1.20',family:4},{address:'93.184.216.34',family:4}]:host==='public.example'?[{address:'93.184.216.34',family:4}]:Promise.reject(new Error('ENOTFOUND'));
  assert.deepEqual(await previewAddress('http://localhost:5173/',false),{url:'http://localhost:5173/'});
  assert.deepEqual(await previewAddress('http://192.168.1.20:5173/app',true,resolve),{url:'http://192.168.1.20:5173/app'});
  assert.deepEqual(await previewAddress('http://devbox.local:3000/',true,resolve),{url:'http://devbox.local:3000/',pin:{address:'192.168.1.20',family:4}});
  assert.deepEqual(await previewAddress('http://[fd00::1]:3000/',true,resolve),{url:'http://[fd00::1]:3000/'});
  for(const url of ['http://192.168.1.20:5173','http://devbox.local:3000'])await assert.rejects(previewAddress(url,false,resolve),/localhost/);
  for(const url of ['http://public.example','http://mixed.example','https://8.8.8.8','http://169.254.169.254/latest','http://missing.example','http://user:pass@192.168.1.20','ftp://192.168.1.20',42])await assert.rejects(previewAddress(url,true,resolve));
});

test('a relayed page keeps going to the address checked at the start, under its own host name',async t=>{
  let host='';
  const app=createServer((req,res)=>{host=req.headers.host||'';res.end('lan page');});
  app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>{app.close();});
  const port=(app.address() as any).port;
  let lookups=0;
  const tunnel=new BrowserPreview({lan:true,resolve:async()=>{lookups++;return [{address:'127.0.0.1',family:4}];}});
  t.after(()=>{tunnel.stop();});
  const session=await tunnel.startAddress(`http://devbox.test:${port}/`,'a');
  const id=crypto.randomUUID(),messages:any[]=[];
  await new Promise<void>(done=>{
    const receive=(message:any)=>{if(message.id!==id)return;messages.push(message);if(['proxy.http.fail','proxy.http.end'].includes(message.type)){tunnel.off('message',receive);done();}};
    tunnel.on('message',receive);tunnel.handle({type:'proxy.http.request',sessionId:session.sessionId,id,path:'/',method:'GET',headers:{},body:''});
  });
  assert.equal(messages[0].status,200);assert.equal(Buffer.from(messages[1].data,'base64').toString(),'lan page');
  assert.equal(host,`devbox.test:${port}`);assert.equal(lookups,1);
  await assert.rejects(new BrowserPreview().startAddress(`http://192.168.1.20:${port}/`,'a'),/localhost/);
});
