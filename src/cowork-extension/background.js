importScripts('cowork-page.js','cowork.js');
let socket,connected=false,notice='',connecting=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const error=(code,message)=>Object.assign(new Error(message),{code});
async function connect(){
  if(socket||connecting)return;connecting=true;
  try{
    if(!await selectedCoworkTab().catch(()=>null))return;
    const config=await (await fetch(chrome.runtime.getURL('pairing.json'))).json();
    if(!/^ws:\/\/127\.0\.0\.1:\d+\/cowork$/.test(config.url)||!/^[a-f0-9]{64}$/.test(config.token))throw error('config','本地配对文件无效，请重新运行安装准备脚本');
    const ws=new WebSocket(config.url);socket=ws;
    const pulse=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ping'}));},20_000);
    ws.onopen=()=>ws.send(JSON.stringify({type:'hello',token:config.token}));
    ws.onmessage=async event=>{
      let message;try{message=JSON.parse(event.data);}catch{return;}
      if(!message||typeof message!=='object')return;
      if(message.type==='ready'){connected=true;notice='';return;}
      if(message.type!=='request')return;
      let response;
      if (['cowork.list','cowork.read'].includes(message.action)) {
        try {response={result:await executeCowork(message.action,message.payload||{})};}
        catch(e){response={error:{code:e.code||'page_unavailable',message:e.code?e.message:'无法读取 Cowork 页面，请检查电脑标签页后重试'}};}
      }
      else response={error:{code:'unsupported',message:'不支持此 Cowork 操作'}};
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
function disconnect(){
  const ws=socket;socket=undefined;connected=false;notice='已断开';ws?.close();
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||sender.tab)return;
  void(async()=>{
    if(message.type==='bridge.status')return {connected,notice,bound:Boolean(await selectedCoworkTab().catch(()=>null))};
    if(message.type==='bridge.unbind'){await chrome.storage.session.remove('coworkTabId');disconnect();return {};}
    if(message.type==='bridge.bind'){
      const tab=await chrome.tabs.get(message.tabId);
      if(!isCoworkTab(tab))throw error('invalid','请选择 Claude 页面');
      await chrome.storage.session.set({coworkTabId:tab.id});await connect();return {};
    }
    throw error('invalid','未知操作');
  })().then(respond,e=>respond({error:e.message}));return true;
});
chrome.alarms.create('bridge-reconnect',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(()=>void connect());
chrome.tabs.onRemoved.addListener(async id=>{
  const {coworkTabId}=await chrome.storage.session.get('coworkTabId');
  if(id!==coworkTabId)return;
  await chrome.storage.session.remove('coworkTabId');disconnect();
});
void connect();
