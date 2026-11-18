// Serialized by chrome.scripting and run in the selected tab's isolated world.
function coworkSnapshot(kind, expectedPath = '') {
  const domain = 'https://claude.ai';
  if (location.origin !== domain) return {failure:'origin'};
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (/^\/(?:login|oauth|onboarding|signup)(?:\/|$)/.test(path)) return {failure:'login'};
  if (expectedPath && path !== expectedPath) return {failure:'loading'};
  const main = document.querySelector('main,[role="main"]');
  const shown = element => !element.closest('[hidden],[aria-hidden="true"],[inert]') && element.getClientRects().length > 0;
  const text = element => (element.innerText ?? element.textContent ?? '').trim();
  const links = (anchors, pattern) => {
    const result = new Map();
    for (const anchor of anchors) {
      if (!shown(anchor)) continue;
      let url;
      try {url = new URL(anchor.getAttribute('href'),domain);} catch {continue;}
      const id = url.pathname.replace(/\/$/, '');
      const title = (anchor.getAttribute('title') || text(anchor) || anchor.getAttribute('aria-label') || '').trim().slice(0,240);
      if (url.origin === domain && pattern.test(id) && title && !result.has(id)) result.set(id,{id,title});
      if (result.size >= 500) break;
    }
    return [...result.values()];
  };

  if (kind === 'thread') {
    if (!main) return {failure:'loading'};
    const selector = '[data-message-author-role="user"],[data-message-author-role="assistant"],[data-testid="user-message"],[data-testid="assistant-message"],.font-claude-response';
    const items = [...main.querySelectorAll(selector)].filter(element => shown(element) && !element.parentElement?.closest(selector));
    const messages = [];
    let budget = 300_000;
    for (const [index,element] of [...items.entries()].reverse()) {
      const body = text(element.querySelector('.standard-markdown') || element);
      if (!body) continue;
      const role = element.getAttribute('data-message-author-role') === 'user' || element.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
      const excerpt = body.slice(-Math.min(budget,80_000));
      messages.push({id:String(index),role,text:excerpt});
      budget -= excerpt.length;
      if (budget <= 0 || messages.length >= 150) break;
    }
    if (!messages.length) return {failure:'loading'};
    const title = (document.title || 'Cowork 会话').replace(/\s+[|–—-]\s+Claude$/i,'').slice(0,240);
    return {title,messages:messages.reverse()};
  }

  const projectPath = /^\/(?:project|cowork\/projects?)\/(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?:claude_proj|proj)_[a-z0-9]+)$/i;
  const threadPath = /^\/cowork\/(?:cse|session|local)_[a-z0-9-]{6,120}$/i;
  const anchors = [...document.querySelectorAll('a[href]')];
  const outsideMain = anchors.filter(anchor => !main?.contains(anchor));
  const projects = kind === 'catalog' ? links(path === '/projects' ? anchors : outsideMain,projectPath).map(({id,title}) => ({id,name:title})) : [];
  const data = links(kind === 'project' ? anchors.filter(anchor => main?.contains(anchor)) : outsideMain,threadPath);
  if (!main && !projects.length && !data.length) return {failure:'loading'};
  return {data,projects};
}
