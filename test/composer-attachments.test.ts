import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {useComposerAttachments} from '../web/composer-attachments.js';

type Attachments=ReturnType<typeof useComposerAttachments>;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('composer attachments read one selection at a time, drop late results and compress pasted Base64',async t=>{
  const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
  const install=(key:string,value:unknown)=>{const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});};
  // Each photo finishes reading only when the test releases it, so a selection can be caught half-way.
  const reads:(()=>Promise<void>)[]=[];
  for(const [key,value] of Object.entries({window,document,IS_REACT_ACT_ENVIRONMENT:true}))install(key,value);
  install('FileReader',class {result='';onload?:()=>void;readAsDataURL(blob:Blob){reads.push(async()=>{this.result=`data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;this.onload?.();});}});
  let current!:Attachments,added=0;
  const notes:string[]=[];
  function Probe(props:{disabled:boolean;imagesBlocked?:string}){current=useComposerAttachments({...props,notify:message=>notes.push(message),added:()=>added++});return null;}
  const root=createRoot(document.getElementById('root')!);
  const render=(props:{disabled:boolean;imagesBlocked?:string})=>act(async()=>root.render(createElement(Probe,props)));
  const photo=()=>new File(['png'],'photo.png',{type:'image/png'}),doc=()=>new File(['pdf'],'notes.pdf',{type:'application/pdf'});
  const release=async(pending:Promise<void>)=>act(async()=>{await reads.shift()!();await pending;});
  try{
    await render({disabled:false});
    let pending!:Promise<void>;
    await act(async()=>{pending=current.add([photo()]);await tick();});
    assert.equal(current.loading,true);assert.equal(reads.length,1);
    await act(async()=>{await current.add([doc()]);});
    assert.equal(notes.at(-1),'附件正在读取，请稍候','a second selection waits instead of working from stale lists');
    await release(pending);
    assert.equal(current.loading,false);assert.equal(current.images.length,1);assert.equal(current.files.length,0);assert.equal(added,1);

    // Opening another conversation while a photo is still being read: the late result is dropped.
    await act(async()=>{pending=current.add([photo(),doc()]);await tick();});
    await act(async()=>current.reset());
    assert.equal(current.loading,false);assert.deepEqual(current.images,[]);
    await release(pending);
    assert.deepEqual(current.images,[]);assert.deepEqual(current.files,[]);assert.equal(added,1);

    // An image pasted as Base64 text is read like a picked photo, not appended as is.
    let prevented=false;
    const event={clipboardData:{items:[],files:[],getData:()=>'iVBORw0KGgoAAAANSUhEUg=='},preventDefault(){prevented=true;}};
    await act(async()=>{current.paste(event as any);await tick();});
    assert.equal(prevented,true);assert.equal(current.loading,true);
    await act(async()=>{await reads.shift()!();await tick();await tick();});
    assert.equal(current.loading,false);assert.equal(current.images.length,1);assert.match(current.images[0],/^data:image\/png;base64,/);

    // An edited photo takes the place of the one it was made from, read like a picked photo.
    const original=current.images[0];
    let replaced!:Promise<string>;
    await act(async()=>{replaced=current.replace(original,new File(['edited'],'edited-image',{type:'image/webp'}));await tick();});
    assert.equal(current.loading,true);
    assert.equal(await current.replace(original,photo()),'附件正在读取，请稍候','one reading at a time, edits included');
    await act(async()=>{await reads.shift()!();await tick();});
    assert.equal(await replaced,'');
    assert.equal(current.loading,false);assert.equal(current.images.length,1);
    assert.equal(current.images[0],`data:image/webp;base64,${Buffer.from('edited').toString('base64')}`);
    // A photo that has left the composer meanwhile is not brought back.
    await act(async()=>{replaced=current.replace('data:image/png;base64,AAAA',photo());await tick();});
    await act(async()=>{await reads.shift()!();await tick();});
    assert.equal(await replaced,'这张图片已不在输入框里');assert.equal(current.images.length,1);

    await render({disabled:false,imagesBlocked:'当前模型未确认图片能力'});
    await act(async()=>{await current.add([photo()]);});
    assert.equal(notes.at(-1),'当前模型未确认图片能力');assert.equal(reads.length,0);assert.equal(current.images.length,1);
    await act(async()=>{await current.add([doc()]);});
    assert.equal(current.files.length,1,'documents are still accepted when only images are blocked');

    await render({disabled:true});
    await act(async()=>{await current.add([doc()]);});
    assert.equal(current.files.length,1,'nothing is added while the composer is disabled');
    await act(async()=>current.clear());
    assert.equal(current.count,0);
  }finally{await act(async()=>root.unmount());}
});
