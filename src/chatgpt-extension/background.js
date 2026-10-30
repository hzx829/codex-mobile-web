let socket,connected=false,busy=false,notice='',connecting=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const error=(code,message,uncertain=false)=>Object.assign(new Error(message),{code,uncertain});
const validTab=tab=>tab?.url?.startsWith('https://chatgpt.com/');
async function selectedTab(){
  const {tabId}=await chrome.storage.session.get('tabId');
  if(!Number.isInteger(tabId))throw error('browser_offline','请在电脑扩展中连接一个 ChatGPT 页面');
  let tab;try{tab=await chrome.tabs.get(tabId);}catch{}
  if(!validTab(tab))throw error('browser_offline','选定的 ChatGPT 页面已关闭或离开，请重新连接');
  return tab;
}
async function page(tabId,action,payload={}){
  const response=await chrome.tabs.sendMessage(tabId,{type:'chatgpt.bridge',action,payload});
  if(response?.error)throw error(response.error.code,response.error.message,response.error.uncertain);
  if(!response?.result)throw error('page_unavailable','ChatGPT 页面尚未就绪，请在电脑刷新页面');
  return response.result;
}
async function read(tab,id){
  const state=await page(tab.id,'status');
  if(state.conversationId!==id){
    if(state.running||state.hasDraft)throw error('active','电脑 ChatGPT 页面正在生成或有未发送草稿，请先处理后再切换聊天');
    await chrome.tabs.update(tab.id,{url:`https://chatgpt.com/c/${id}`});
  }
  const deadline=Date.now()+22_000;
  while(Date.now()<deadline){
    try{return await page(tab.id,'read',{conversationId:id});}
    catch(e){if(!['page_unavailable','wrong_conversation'].includes(e.code)&&!e.message?.includes('Receiving end does not exist'))throw e;}
    await sleep(400);
  }
  throw error('page_unavailable','聊天尚未载入，请在电脑完成登录或检查该聊天后重试');
}
async function execute(action,payload){
  const tab=await selectedTab();
  if(action==='read')return read(tab,payload.conversationId);
  if(['status','list'].includes(action))return page(tab.id,action,payload);
  if(!['send','stop'].includes(action))throw error('invalid','未知浏览器操作');
  // Persist a receipt before touching the page. Worker/reconnect retries never click twice.
  if(!/^\d{13}:[0-9a-f-]{36}$/i.test(payload.opId||''))throw error('invalid','操作标识无效');
  const key=`operation:${payload.opId}`;
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({action,...payload}))))).map(b=>b.toString(16).padStart(2,'0')).join('');
  const previous=(await chrome.storage.local.get(key))[key];
  if(previous){
    if(previous.hash!==hash)throw error('conflict','同一操作的内容发生变化');
    if(previous.result)return previous.result;
    if(previous.error)throw Object.assign(new Error(previous.error.message),previous.error);
    throw error('uncertain','上次操作结果尚未确认，请查看聊天；不会重复发送',true);
  }
  try{await chrome.storage.local.set({[key]:{hash,at:Date.now()}});}
  catch{throw error('storage','无法保存发送回执，未执行操作；请检查扩展存储');}
  try{
    const result=await page(tab.id,action,payload);
    await chrome.storage.local.set({[key]:{hash,result,at:Date.now()}}).catch(()=>{});return result;
  }catch(e){
    const failure={code:e.code||'uncertain',message:e.code?e.message:'页面连接中断，请核实聊天；不会自动重发',uncertain:e.code?Boolean(e.uncertain):true};
    await chrome.storage.local.set({[key]:{hash,error:failure,at:Date.now()}}).catch(()=>{});throw Object.assign(new Error(failure.message),failure);
  }
}
async function connect(){
  if(socket||connecting)return;connecting=true;
  try{
    await selectedTab();
    const config=await (await fetch(chrome.runtime.getURL('pairing.json'))).json();
    if(!/^ws:\/\/127\.0\.0\.1:\d+\/chatgpt$/.test(config.url)||!/^[a-f0-9]{64}$/.test(config.token))throw error('config','本地配对文件无效，请重新运行安装准备脚本');
    const ws=new WebSocket(config.url);socket=ws;
    const pulse=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping'}));},20_000);
    ws.onopen=()=>ws.send(JSON.stringify({type:'hello',token:config.token}));
    ws.onmessage=async event=>{
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(message.type==='ready'){connected=true;notice='';return;}
      if(message.type!=='request')return;
      let response;
      if(busy)response={error:{code:'active',message:'ChatGPT 页面仍在处理上次操作'}};
      else{
        busy=true;
        try{response={result:await execute(message.action,message.payload||{})};}
        catch(e){response={error:{code:e.code||'page_unavailable',message:e.code?e.message:'无法连接 ChatGPT 页面，请在电脑刷新后重新连接',uncertain:Boolean(e.uncertain)}};}
        finally{busy=false;}
      }
      if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'response',id:message.id,...response}));
    };
    ws.onclose=event=>{
      clearInterval(pulse);if(socket!==ws)return;socket=undefined;connected=false;
      notice=event.code===4401?'配对失效，请重新运行安装准备脚本并重新加载扩展':event.code===4409?'已有另一个浏览器扩展连接，请先断开它':'电脑连接器尚未启动或连接已断开';
      if(![4401,4409].includes(event.code))setTimeout(()=>void connect(),3000);
    };
    ws.onerror=()=>{};
  }catch(e){notice=e.code?e.message:'缺少配对文件，请先运行安装准备脚本';}
  finally{connecting=false;}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  // Binding is available only to our popup, never the page/content script.
  if(sender.id!==chrome.runtime.id||sender.tab)return;
  void(async()=>{
    if(message.type==='bridge.status')return {connected,notice};
    if(busy)throw error('active','正在处理手机操作，请稍后切换');
    if(message.type==='bridge.unbind'){await chrome.storage.session.remove('tabId');socket?.close();socket=undefined;connected=false;notice='已断开';return {};}
    if(message.type==='bridge.bind'){
      const tab=await chrome.tabs.get(message.tabId);if(!validTab(tab))throw error('invalid','请选择 ChatGPT 页面');
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
      await chrome.storage.session.set({tabId:tab.id});socket?.close();socket=undefined;connected=false;await connect();return {};
    }
    throw error('invalid','未知操作');
  })().then(respond,e=>respond({error:e.message}));return true;
});
chrome.alarms.create('bridge-reconnect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>void connect());
chrome.tabs.onRemoved.addListener(async id=>{const {tabId}=await chrome.storage.session.get('tabId');if(id===tabId){await chrome.storage.session.remove('tabId');socket?.close();}});
// Keep only receipt hashes/status, never cookies, auth tokens, or message text.
void chrome.storage.local.get(null).then(values=>chrome.storage.local.remove(Object.entries(values).filter(([key,value])=>key.startsWith('operation:')&&value.at<Date.now()-7*86400_000).map(([key])=>key)));
void connect();
