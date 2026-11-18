const status=document.querySelector('#status');
const services=['chatgpt','cowork'];
async function show(){
  try{
    const result=await chrome.runtime.sendMessage({type:'bridge.status'});
    status.textContent=result.connected?['ChatGPT','Cowork'].filter((_,i)=>result[services[i]]).join('、')+' 已连接':result.notice||'尚未连接';
    for(const service of services)document.querySelector('#disconnect-'+service).hidden=!result[service];
  }
  catch{status.textContent='扩展启动失败，请在扩展管理页重新加载。';}
}
document.querySelector('#connect').onclick=async()=>{
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const cowork=tab?.url?.startsWith('https://claude.ai/');
    if(!cowork&&!tab?.url?.startsWith('https://chatgpt.com/')){status.textContent='请打开已登录的 ChatGPT 或 Claude 标签页。';return;}
    if(cowork&&!await chrome.permissions.request({origins:['https://claude.ai/*']})){status.textContent='连接 Cowork 需要你允许扩展读取 Claude 页面。';return;}
    const result=await chrome.runtime.sendMessage({type:'bridge.bind',tabId:tab.id,service:cowork?'cowork':'chatgpt'});
    status.textContent=result.error||'已选定页面，正在连接…';if(!result.error)setTimeout(show,1000);
  }catch{status.textContent='连接失败，请检查电脑页面及浏览器扩展。';}
};
for(const service of services)document.querySelector('#disconnect-'+service).onclick=async()=>{await chrome.runtime.sendMessage({type:'bridge.unbind',service});await show();};
void show();
