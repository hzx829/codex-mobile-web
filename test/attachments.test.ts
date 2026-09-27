import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageDataUrl,MAX_IMAGE_BYTES} from '../src/shared/images.js';
import {appendImages,pastedImage,readImageFiles} from '../web/attachments.js';

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
  assert.throws(()=>appendImages(two,[third]),/最多添加 2 张/);
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
  await assert.rejects(readImageFiles([new File([],'empty.png',{type:'image/png'})]),/2 MiB/);
  await assert.rejects(readImageFiles([new File(['x'],'1.png'),new File(['x'],'2.png'),new File(['x'],'3.png')]),/最多添加 2 张/);
});
