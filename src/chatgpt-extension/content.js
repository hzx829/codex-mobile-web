(()=>{
  if(globalThis.__chatgptMobileBridge)return;globalThis.__chatgptMobileBridge=true;
  const fail=(code,message,uncertain=false)=>{throw Object.assign(new Error(message),{code,uncertain});};
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const text=element=>(element?.innerText??element?.textContent??'').trim();
  const visible=element=>Boolean(element&&!element.hidden&&element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden');
  const idFromPath=path=>path.match(/\/(?:c)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/|$)/i)?.[1]||'';
  const conversationId=()=>idFromPath(location.pathname);
  const composer=()=>document.querySelector('#prompt-textarea');
  function stopButton(){
    return [...document.querySelectorAll('button[data-testid="stop-button"], button[data-testid="stop-generating-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]')].find(visible);
  }
  function sendButton(){return [...document.querySelectorAll('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送消息"]')].find(visible);}
  function draft(){const input=composer();return input?.tagName==='TEXTAREA'?input.value.trim():text(input);}
  function attachments(){return Boolean(composer()?.closest('form')?.querySelector('[data-testid*="attachment"], [data-testid*="file-preview"], [data-testid="upload-preview"]'));}
  function nodes(){return [...document.querySelectorAll('main [data-message-author-role]')].filter(node=>['user','assistant'].includes(node.getAttribute('data-message-author-role')));}
  function status(){return {conversationId:conversationId(),title:document.title,running:Boolean(stopButton()),hasDraft:Boolean(draft()||attachments()),pageReady:Boolean(composer()&&visible(composer()))};}
  function assertConversation(id){if(conversationId()!==id)fail('wrong_conversation','电脑页面已切换聊天，请重新打开目标聊天');}
  function read(id){
    assertConversation(id);
    const state=status(),all=nodes();
    if(!state.pageReady||!all.length)fail('page_unavailable','聊天尚未载入，请在电脑检查登录和页面状态');
    let remaining=350_000;
    const messages=all.map((node,index)=>({id:node.getAttribute('data-message-id')||String(index),role:node.getAttribute('data-message-author-role'),text:text(node)|| (node.querySelector('img')?'[图片或附件]':'')}));
    // Bound the frame and say so. Never expose page HTML, scripts, cookies or storage.
    const recent=[];
    for(const message of messages.toReversed()){
      if(!remaining)break;
      const value=message.text.slice(-Math.min(remaining,100_000));remaining-=value.length;recent.push({...message,text:value});
    }
    return {...state,messages:recent.reverse(),notice:'显示 ChatGPT 网页当前载入的文字内容；图片、工具卡片和未载入的历史请在原网页查看。'};
  }
  function links(){return [...document.querySelectorAll('a[href]')].filter(anchor=>{
    if(anchor.closest('main'))return false;
    try{const url=new URL(anchor.getAttribute('href'),location.origin);return url.origin===location.origin&&Boolean(idFromPath(url.pathname));}catch{return false;}
  });}
  async function list(more){
    if(!status().pageReady)fail('page_unavailable','请在电脑登录 ChatGPT 并等待页面载入');
    if(!links().length){
      const open=document.querySelector('button[data-testid="open-sidebar-button"], button[aria-label="Open sidebar"], button[aria-label="打开边栏"], button[aria-label="打开侧边栏"]');
      if(visible(open)){open.click();await sleep(500);}
    }
    const before=links();
    if(more&&before.length){
      let scroller=before.at(-1).parentElement;
      while(scroller&&scroller!==document.body){
        if(scroller.scrollHeight>scroller.clientHeight+10&&/auto|scroll/.test(getComputedStyle(scroller).overflowY))break;
        scroller=scroller.parentElement;
      }
      if(scroller&&scroller!==document.body){scroller.scrollTop=scroller.scrollHeight;await sleep(1000);}
      else fail('page_unavailable','未找到更多聊天的滚动区域，请在电脑侧栏加载，或在手机粘贴聊天链接');
    }
    const items=new Map();
    for(const anchor of [...before,...links()]){
      const id=idFromPath(new URL(anchor.getAttribute('href'),location.origin).pathname);
      items.set(id,{id,title:text(anchor)||anchor.getAttribute('title')||id});
    }
    return {data:[...items.values()].slice(0,5000),notice:'来自已连接浏览器账号的侧栏。可加载更多，或粘贴 ChatGPT 聊天链接。'};
  }
  async function send(payload){
    const {conversationId:id,text:message}=payload;assertConversation(id);
    if(typeof message!=='string'||!message.trim()||message.length>50_000)fail('invalid','消息无效');
    if(stopButton())fail('active','ChatGPT 正在生成，请等待完成或先停止');
    if(draft()||attachments())fail('draft_exists','电脑 ChatGPT 输入框已有草稿或附件，请先处理');
    const input=composer();if(!visible(input))fail('page_unavailable','未找到 ChatGPT 输入框，请在电脑检查登录或刷新页面');
    const before=nodes().filter(node=>node.getAttribute('data-message-author-role')==='user').map(node=>({node,text:text(node),id:node.getAttribute('data-message-id')}));
    input.focus();
    if(input.tagName==='TEXTAREA'){
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,message);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }else{
      const selection=getSelection(),range=document.createRange();range.selectNodeContents(input);selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('insertText',false,message))fail('page_unavailable','无法填写 ChatGPT 输入框，请在电脑检查草稿');
    }
    const normalize=value=>value.replace(/\s+/g,' ').trim();
    const deadline=Date.now()+2000;let button;
    while(Date.now()<deadline){button=sendButton();if(button&&!button.disabled)break;await sleep(100);}
    assertConversation(id);
    if(!button||button.disabled||normalize(draft())!==normalize(message)||stopButton())fail('page_unavailable','消息尚未发送，已保留在电脑输入框；请检查页面');
    button.click();
    // Receipt requires a newly rendered matching user message, not just a cleared composer.
    const receiptDeadline=Date.now()+12_000;
    while(Date.now()<receiptDeadline){
      if(conversationId()!==id)fail('uncertain','发送后页面发生切换，请核实原聊天；不会自动重发',true);
      const users=nodes().filter(node=>node.getAttribute('data-message-author-role')==='user');
      const last=users.at(-1),lastId=last?.getAttribute('data-message-id');
      if(last&&normalize(text(last))===normalize(message)&&!before.some(old=>old.node===last||lastId&&old.id===lastId)&&users.length>before.length)return {conversationId:id,submitted:true};
      await sleep(200);
    }
    fail('uncertain','未确认新的用户消息，请检查聊天和电脑页面；不会自动重发',true);
  }
  let busy=false;
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||message.type!=='chatgpt.bridge')return;
    if(busy){respond({error:{code:'active',message:'页面仍在处理上次操作'}});return;}
    busy=true;
    void(async()=>{
      const payload=message.payload||{};
      switch(message.action){
        case 'status':return status();
        case 'list':return list(payload.more);
        case 'read':return read(payload.conversationId);
        case 'send':return send(payload);
        case 'stop':{
          assertConversation(payload.conversationId);const button=stopButton();if(!button)return {stopped:true};
          button.click();const deadline=Date.now()+5000;
          while(stopButton()&&Date.now()<deadline)await sleep(200);
          if(stopButton())fail('uncertain','停止请求已点击，请刷新核实生成状态',true);
          return {stopped:true};
        }
        default:fail('invalid','未知页面操作');
      }
    })().then(result=>respond({result}),e=>respond({error:{code:e.code||'page_unavailable',message:e.message,uncertain:e.uncertain??['send','stop'].includes(message.action)}})).finally(()=>{busy=false;});
    return true;
  });
})();
