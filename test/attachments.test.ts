import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageDataUrl,MAX_IMAGE_BYTES,MAX_IMAGES,MAX_IMAGE_INPUT_BYTES,MAX_TOTAL_IMAGE_BYTES,validateImages,imageBytes} from '../src/shared/images.js';
import {appendImages,pastedImage,readImageFiles,clipboardImageFiles,imageFile} from '../web/attachments.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6sAAAAASUVORK5CYII=';
const url=`data:image/png;base64,${png}`;
test('clipboard accepts image URLs and bare image Base64 while preserving ordinary text',()=>{
  assert.equal(pastedImage(` \n${url}\n `),url);
  assert.equal(pastedImage(png),url);
  assert.equal(pastedImage('data:image/PNG;base64,\n'+png),url);
  const webp=Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 ', 'binary').toString('base64');
  assert.equal(pastedImage(webp),`data:image/webp;base64,${webp}`);
  assert.equal(pastedImage('/9j/2Q=='),'data:image/jpeg;base64,/9j/2Q==');
  for(const text of ['hello world','const foo = 42;','aGVsbG8=','https://example.test/a.png','data:text/plain;base64,aGVsbG8=',''])assert.equal(pastedImage(text),null);
  assert.throws(()=>pastedImage('data:image/png;base64,not-a-valid-image'),/图片/);
  assert.throws(()=>pastedImage('data:image/gif;base64,R0lGODlh'),/PNG/);
});

test('attachments append, deduplicate and reject overflow without changing the previous selection',()=>{
  const second='data:image/jpeg;base64,/9j/2Q==',third='data:image/webp;base64,UklGRiAAAABXRUJQ';
  const current=appendImages([], [url]);
  const two=appendImages(current,[second]);
  assert.deepEqual(current,[url]);assert.deepEqual(two,[url,second]);
  assert.deepEqual(appendImages(two,[url]),two);
  assert.deepEqual(appendImages(two,[`data:image/PNG;base64,\n${png}`]),two);
  assert.deepEqual(appendImages(two,[third]),[...two,third]);
  const full=Array.from({length:MAX_IMAGES},(_,i)=>`data:image/png;base64,${Buffer.from(`image-${i}`).toString('base64')}`);
  assert.equal(appendImages([],full).length,MAX_IMAGES);
  assert.throws(()=>appendImages(full,[url]),/最多添加 10 张/);
  assert.deepEqual(two,[url,second]);
  assert.deepEqual(appendImages(two.filter(value=>value!==url),[third]),[second,third]);
});

test('image limits apply to decoded bytes, and invalid files are rejected before reading',async()=>{
  const data=(size:number)=>`data:image/png;base64,${Buffer.alloc(size).toString('base64')}`;
  assert.equal(imageDataUrl(data(MAX_IMAGE_BYTES)),data(MAX_IMAGE_BYTES));
  assert.throws(()=>imageDataUrl(data(MAX_IMAGE_BYTES+1)),/2 MiB/);
  assert.throws(()=>imageDataUrl('data:image/png;base64,A'),/Base64/);
  assert.throws(()=>imageDataUrl('data:image/png;base64, '),/0 B/);
  await assert.rejects(readImageFiles([new File(['text'],'bad.txt',{type:'text/plain'})]),/PNG/);
  await assert.rejects(readImageFiles([new File([],'empty.png',{type:'image/png'})]),/20 MiB/);
  await assert.rejects(readImageFiles(Array.from({length:MAX_IMAGES+1},()=>new File(['x'],'1.png'))),/最多添加 10 张/);
  await assert.rejects(readImageFiles([new File([new Uint8Array(MAX_IMAGE_INPUT_BYTES+1)],'large.png',{type:'image/png'})]),/20 MiB/);
});

test('base64 canonicalization matches native decoding without decoding the complete image',()=>{
  for(let size=1;size<150;size++){
    const bytes=Buffer.from(Array.from({length:size},(_,i)=>(i*137+size)%256)),encoded=bytes.toString('base64');
    for(const data of [encoded,encoded.replace(/=+$/,''),encoded.replace(/.{8}/g,'$&\n')])assert.equal(imageDataUrl(`data:image/png;base64,${data}`),`data:image/png;base64,${encoded}`);
    assert.equal(imageBytes(imageDataUrl(`data:image/png;base64,${encoded}`)),size);
  }
  assert.equal(imageDataUrl('data:image/png;base64,/x=='),'data:image/png;base64,/w==');
  for(const invalid of ['A','A===','ab=c','AA=','====','a?aa'])assert.throws(()=>imageDataUrl(`data:image/png;base64,${invalid}`),/Base64/);
});

test('the total image budget fits a transport frame and large clipboard images can enter compression',async()=>{
  const image=`data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES).toString('base64')}`;
  assert.equal(validateImages(Array(MAX_TOTAL_IMAGE_BYTES/MAX_IMAGE_BYTES).fill(image)).length,4);
  assert.throws(()=>validateImages(Array(5).fill(image)),/8 MiB/);
  const large=`data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')}`;
  assert.equal(pastedImage(large),large);
  const file=imageFile(large);assert.equal(file.size,MAX_IMAGE_BYTES+1);assert.equal(file.type,'image/png');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'),large.split(',')[1]);
});

test('clipboard files fallback works and items do not duplicate the same image',()=>{
  const file=new File(['image'],'screenshot.png',{type:'image/png'}),text=new File(['text'],'text.txt',{type:'text/plain'});
  assert.deepEqual(clipboardImageFiles({items:[],files:[file,text]} as any),[file]);
  assert.deepEqual(clipboardImageFiles({items:[{kind:'file',type:'image/png',getAsFile:()=>file}],files:[file]} as any),[file]);
});

test('photo processing is sequential, respects the remaining budget, and releases decoded images',async t=>{
  let active=0,maxActive=0,closed=0,encodes=0;
  const install=(key:string,value:unknown)=>{const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});};
  install('createImageBitmap',async()=>{active++;maxActive=Math.max(maxActive,active);return {width:4000,height:3000,close(){active--;closed++;}};});
  install('document',{createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toBlob(callback:(blob:Blob)=>void){encodes++;callback(new Blob([new Uint8Array(400*1024)],{type:'image/webp'}));}})});
  install('FileReader',class {result='';onload?:()=>void;async readAsDataURL(blob:Blob){this.result=`data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;this.onload?.();}});
  const files=Array.from({length:3},()=>new File([new Uint8Array(3*1024*1024)],'photo.jpg',{type:'image/jpeg'}));
  const images=await readImageFiles(files,2*1024*1024);
  assert.equal(images.length,3);assert.equal(maxActive,1);assert.equal(closed,3);assert.equal(encodes,3);
  assert.ok(images.reduce((sum,url)=>sum+imageBytes(url),0)<=2*1024*1024);
  assert.deepEqual(await readImageFiles(files,2*1024*1024,()=>true),[]);
});
