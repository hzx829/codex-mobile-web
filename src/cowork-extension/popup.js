const status=document.querySelector('#status');
const disconnect=document.querySelector('#disconnect');
async function show(){
  try{
    const state=await chrome.runtime.sendMessage({type:'bridge.status'});
    disconnect.hidden=!state.bound;
    status.textContent=state.bound?(state.connected?'Cowork 已连接':state.notice||'正在连接…'):'请选择要连接的 Claude 标签页。';
  }catch{status.textContent='无法读取扩展状态，请重新打开扩展。';}
}
document.querySelector('#connect').onclick=async()=>{
  try{
    const origin='https://claude.ai/';
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.url?.startsWith(origin)){status.textContent='请打开已登录的 Claude 标签页。';return;}
    if(!await chrome.permissions.request({origins:[origin+'*']})){status.textContent='连接 Cowork 需要允许扩展读取 Claude 页面。';return;}
    const result=await chrome.runtime.sendMessage({type:'bridge.bind',tabId:tab.id});
    status.textContent=result.error||'已选定页面，正在连接…';
    if(!result.error)setTimeout(show,1000);
  }catch{status.textContent='连接失败，请检查电脑页面及浏览器扩展。';}
};
disconnect.onclick=async()=>{await chrome.runtime.sendMessage({type:'bridge.unbind'});await show();};
void show();
