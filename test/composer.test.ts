import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement as h,act,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {useComposerAttachments} from '../web/composer-attachments.js';
import {AddOptions,Composer} from '../web/composer.js';
import {ModelPicker} from '../web/model-picker.js';
import {PermissionButton,PermissionPicker,type PermissionOption} from '../web/permission-picker.js';
import {QueuedMessages} from '../web/queued-messages.js';

const OPTIONS:PermissionOption[]=[{id:'default',label:'按需审批',description:'需要时审批'},{id:'bypass',label:'全部允许',description:'不再审批',elevated:true}];
const voice={state:'idle' as const,start(){},stop(){},cancel(){}};
const noop=()=>{};

test('the shared composer, "+" sheet, pickers and queue show what each runtime supports',async t=>{
  const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');
  const install=(key:string,value:unknown)=>{const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else Reflect.deleteProperty(globalThis,key);});};
  for(const [key,value] of Object.entries({window,document,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class {observe(){}disconnect(){}}}))install(key,value);
  const root=createRoot(document.getElementById('root')!);
  const render=(node:ReactNode)=>act(async()=>root.render(node));
  const $=(selector:string)=>document.querySelector(selector) as HTMLElement|null;
  const labels=()=>Array.from(document.querySelectorAll('.composer-actions button')).map(button=>button.getAttribute('aria-label'));
  const click=(element:Element)=>act(async()=>{element.dispatchEvent(new window.Event('click',{bubbles:true}));});
  type Running={stop:()=>void;disabled:boolean;queue:boolean};
  function Probe({draft,running,permission,add}:{draft:string;running?:Running;permission?:ReactNode;add?:(attachments:ReturnType<typeof useComposerAttachments>)=>ReactNode}){
    const attachments=useComposerAttachments({disabled:false,notify:noop});
    return h('div',null,
      h(Composer,{attachments,input:{current:null},draft,edit:noop,placeholder:'',readOnly:false,submit:noop,locked:false,showImage:noop,uploadProgress:null,
        voice,voiceMode:'keyboard',voiceDisabled:false,onVoiceStart:noop,connected:true,add:noop,addDisabled:false,permission,running,
        send:{label:'完成后发送',sending:false,disabled:false}}),
      add?.(attachments));
  }
  try{
    // Stop and send, as Codex does: stop alone without a draft; with one, stop plus "send when done" if the runtime queues.
    const running:Running={stop:noop,disabled:false,queue:true};
    await render(h(Probe,{draft:''}));
    assert.deepEqual(labels(),['语音输入：系统键盘','完成后发送']);
    assert.equal($('.composer-permission'),null,'a runtime without permission levels shows no shield');
    await render(h(Probe,{draft:'',running}));
    assert.deepEqual(labels(),['语音输入：系统键盘','停止当前任务']);
    await render(h(Probe,{draft:'还有这个',running}));
    assert.deepEqual(labels(),['语音输入：系统键盘','停止当前任务','完成后发送']);
    await render(h(Probe,{draft:'还有这个',running:{...running,queue:false}}));
    assert.deepEqual(labels(),['语音输入：系统键盘','停止当前任务'],'without a queue only stopping is offered');

    // The permission button names the level the next message uses; elevated levels are marked.
    const button=(value:string,current={id:'default',label:'按需审批'})=>h(PermissionButton,{options:OPTIONS,value,current,expanded:false,disabled:false,open:noop});
    await render(h(Probe,{draft:'',permission:button('')}));
    assert.equal($('.composer-permission')?.getAttribute('aria-label'),'许可：按需审批');assert.equal($('.composer-permission.unrestricted'),null);
    await render(h(Probe,{draft:'',permission:button('bypass')}));
    assert.equal($('.composer-permission.unrestricted')?.getAttribute('aria-label'),'许可：全部允许');
    await render(h(Probe,{draft:'',permission:button('',{id:'bypass',label:'全部允许'})}));
    assert.ok($('.composer-permission.unrestricted'),'an elevated level kept from the session is marked too');

    // The "+" sheet lists what the runtime offers; photos blocked by the model say why.
    const menu=()=>Array.from(document.querySelectorAll('.menu-item')).map(item=>[item.textContent,(item as HTMLButtonElement).disabled]);
    const options=(extra:object)=>(attachments:ReturnType<typeof useComposerAttachments>)=>h(AddOptions,{attachments,pick:{images:noop,documents:noop},disabled:false,connected:true,voiceLabel:'系统键盘',chooseVoice:noop,...extra});
    await render(h(Probe,{draft:'',add:options({})}));
    assert.deepEqual(menu(),[['添加图片大图自动压缩',false],['添加文件PDF、Word 等',false],['语音输入系统键盘',false]]);
    await render(h(Probe,{draft:'',add:options({imagesBlocked:'当前模型未确认图片能力',browse:noop,projectFiles:noop,refresh:noop,chooseProject:noop})}));
    assert.deepEqual(menu(),[['添加图片大图自动压缩',true],['添加文件PDF、Word 等',false],['语音输入系统键盘',false],['打开本机网页',false],['查看项目文件',false],['刷新会话',false],['选择项目',false]]);
    assert.ok(Array.from(document.querySelectorAll('.muted')).some(note=>note.textContent==='当前模型未确认图片能力'));

    // Permission picker: each level with what it means, the one in use checked; choosing closes it.
    let chosen='',closed=0;
    await render(h(PermissionPicker,{point:{x:0,y:0},options:OPTIONS,value:'',current:{id:'default',label:'按需审批'},onChange:id=>{chosen=id;},close:()=>closed++}));
    let rows=Array.from(document.querySelectorAll('.model-picker-options button'));
    assert.equal($('.permission-picker-title')?.textContent,'模式');
    assert.deepEqual(rows.map(row=>[row.textContent,row.getAttribute('aria-pressed')]),[['按需审批需要时审批','true'],['全部允许不再审批','false']]);
    assert.ok(rows[1].classList.contains('elevated'));
    await click(rows[1]);
    assert.deepEqual([chosen,closed],['bypass',1]);
    // Choosing the level in use clears the choice.
    await render(h(PermissionPicker,{point:{x:0,y:0},options:OPTIONS,value:'bypass',current:{id:'default',label:'按需审批'},onChange:id=>{chosen=id;},close:()=>closed++}));
    await click(Array.from(document.querySelectorAll('.model-picker-options button'))[0]);
    assert.equal(chosen,'');
    // A level left to the computer is listed first so it can be chosen again.
    await render(h(PermissionPicker,{point:{x:0,y:0},options:OPTIONS,value:'default',current:{id:'',label:'电脑配置'},title:'许可',onChange:id=>{chosen=id;},close:()=>closed++}));
    rows=Array.from(document.querySelectorAll('.model-picker-options button'));
    assert.deepEqual(rows.map(row=>[row.textContent,row.getAttribute('aria-pressed')]),[['电脑配置使用电脑上的配置','false'],['按需审批需要时审批','true'],['全部允许不再审批','false']]);
    await click(rows[0]);
    assert.equal(chosen,'');

    // A model list without effort or fast tier (Claude Code, Antigravity).
    let model='unset';closed=0;
    await render(h(ModelPicker,{point:{x:0,y:0},tuning:false,models:[{model:'opus',displayName:'Opus'},{model:'sonnet',displayName:'Sonnet'}],value:{model:'sonnet',effort:''},current:{model:'claude-opus-5-5'},
      currentLabel:'claude-opus-5-5',onChange:selection=>{model=selection.model;},close:()=>closed++,status:h('p',{role:'status'},'正在读取模型…')}));
    assert.equal($('.model-picker-speed'),null);assert.equal($('.model-picker-slider'),null);
    assert.deepEqual(Array.from(document.querySelectorAll('.model-picker-options button')).map(row=>[row.textContent,row.getAttribute('aria-pressed')]),[['沿用当前 · claude-opus-5-5','false'],['Opus','false'],['Sonnet','true']]);
    assert.equal($('[role=status]')?.textContent,'正在读取模型…');
    await click(document.querySelector('.model-picker-options button')!);
    assert.deepEqual([model,closed],['',1],'"keep the current model" clears the choice');

    // Queued messages offer "send now" only where the runtime can interrupt.
    const queue=(onNow?:(id:string)=>void)=>h(QueuedMessages,{messages:[{id:'q1',text:'下一步',imageCount:0,state:'queued'}],disabled:false,canSteer:true,attachmentsFull:()=>false,onSteer:noop,onWithdraw:noop,onCancel:noop,onNow});
    const actions=()=>Array.from(document.querySelectorAll('.queued-actions button')).map(button=>button.getAttribute('aria-label')?.split('（')[0]);
    await render(queue());
    assert.deepEqual(actions(),['立即追加到当前任务','撤回到输入框','删除排队消息']);
    let now='';
    await render(queue(id=>{now=id;}));
    assert.deepEqual(actions(),['立即发送','立即追加到当前任务','撤回到输入框','删除排队消息']);
    await click(document.querySelector('.queued-actions button')!);
    assert.equal(now,'q1');
  }finally{await act(async()=>root.unmount());}
});
