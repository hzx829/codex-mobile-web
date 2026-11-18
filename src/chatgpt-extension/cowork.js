const coworkOrigin = 'https://claude.ai';
const isCoworkTab = tab => tab?.url?.startsWith(coworkOrigin + '/');
const coworkProject = /^\/(?:project|cowork\/projects?)\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?:claude_proj|proj)_[a-z0-9]+)$/i;
const coworkThread = /^\/cowork\/(?:cse|session|local)_[a-z0-9-]{6,120}$/i;

async function selectedCoworkTab() {
  const {coworkTabId} = await chrome.storage.session.get('coworkTabId');
  if (!Number.isInteger(coworkTabId)) throw error('browser_offline','请在电脑浏览器扩展中连接已登录的 Cowork 页面');
  const tab = await chrome.tabs.get(coworkTabId).catch(() => null);
  if (!isCoworkTab(tab)) throw error('browser_offline','选定的 Cowork 页面已关闭或离开，请重新连接');
  return tab;
}

async function readCoworkTab(tabId, kind, path, deadline) {
  let emptySince;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw error('browser_offline','Cowork 页面已关闭，请重新连接');
    if (isCoworkTab(tab) && tab.status === 'complete') {
      const [frame] = await chrome.scripting.executeScript({target:{tabId},func:coworkSnapshot,args:[kind,path]});
      const result = frame?.result;
      if (result?.failure === 'login') throw error('browser_offline','请在电脑的 Claude 页面登录');
      if (result && !result.failure) {
        if (kind === 'thread' || result.data.length || result.projects.length) return result;
        // Let the client hydrate before treating a freshly opened view as empty.
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= 1600) return result;
      }
    }
    await sleep(400);
  }
  throw error('page_unavailable',kind==='thread'?'当前页面未能读取会话文字，请用「在 Claude 中打开」查看。':'Cowork 页面尚未载入，请检查电脑网页后重试。');
}

async function coworkPage(tab, kind, path) {
  const deadline = Date.now() + 19_000;
  const current = new URL(tab.url).pathname.replace(/\/$/,'');
  if (!path || current === path) return readCoworkTab(tab.id,kind,path,deadline);
  // Read project and thread pages in a temporary tab so the paired tab keeps its place.
  const reader = await chrome.tabs.create({windowId:tab.windowId,url:coworkOrigin+path,active:false});
  try {return await readCoworkTab(reader.id,kind,path,deadline);}
  finally {await chrome.tabs.remove(reader.id).catch(()=>{});}
}

async function executeCowork(action,payload) {
  const tab = await selectedCoworkTab();
  const result = await readCowork(action,payload,tab);
  if ((await selectedCoworkTab()).id !== tab.id) throw error('browser_offline','Cowork 页面已切换，请重新读取');
  return result;
}

async function readCowork(action,payload,tab) {
  if (action === 'cowork.read') {
    if (typeof payload.conversationId !== 'string' || !coworkThread.test(payload.conversationId)) throw error('invalid','Cowork 会话链接无效');
    return coworkPage(tab,'thread',payload.conversationId);
  }
  if (action !== 'cowork.list') throw error('invalid','未知 Cowork 操作');
  const {project=''} = payload;
  if (project) {
    if (typeof project !== 'string' || !coworkProject.test(project)) throw error('invalid','Cowork 项目链接无效');
    return coworkPage(tab,'project',project);
  }
  const [home,index] = await Promise.all([
    coworkPage(tab,'catalog',''),
    coworkPage(tab,'catalog','/projects').catch(()=>null),
  ]);
  const merge = (first, second) => [...new Map([...first,...second].map(item=>[item.id,item])).values()];
  return {data:merge(home.data,index?.data||[]),projects:merge(home.projects,index?.projects||[]),
    notice:index?'显示 Claude 网页当前载入的项目和 Cowork 会话。':'项目页暂时无法读取，当前显示已连接页面的侧栏。'};
}
