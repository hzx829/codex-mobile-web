const status=document.querySelector('#status');
async function show(){
  try{const result=await chrome.runtime.sendMessage({type:'bridge.status'});status.textContent=result.connected?'已连接手机桥接':result.notice||'尚未连接';}
  catch{status.textContent='扩展启动失败，请在扩展管理页重新加载。';}
}
document.querySelector('#connect').onclick=async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.url?.startsWith('https://chatgpt.com/')){status.textContent='请先打开 https://chatgpt.com/ 并登录。';return;}
  const result=await chrome.runtime.sendMessage({type:'bridge.bind',tabId:tab.id});
  status.textContent=result.error||'已选定页面，正在连接…';setTimeout(show,1000);
};
document.querySelector('#disconnect').onclick=async()=>{await chrome.runtime.sendMessage({type:'bridge.unbind'});await show();};
void show();
