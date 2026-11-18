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
  const escape = value => value.replace(/\s+/g,' ').replace(/[\\\x60*_[\]<>#~!+|=-]/g,'\\$&');
  const fence = (body, pattern, mark, size) => {
    for (const run of body.matchAll(pattern)) size = Math.max(size,run[0].length+1);
    return mark.repeat(size);
  };
  function markdown(node) {
    if (node.nodeType === 3) return escape(node.nodeValue || '');
    if (node.nodeType !== 1 || node.matches('[hidden],[aria-hidden="true"],[inert],button,svg,script,style')) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '  \n';
    if (tag === 'PRE' || tag === 'CODE') {
      const code = (tag==='PRE'?node.querySelector('code')||node:node).textContent || '';
      if (tag === 'PRE') {
        const marker = fence(code,/~+/g,'~',3);
        return '\n\n'+marker+'\n'+code+'\n'+marker+'\n\n';
      }
      const marker = fence(code,/\x60+/g,String.fromCharCode(96),1);
      return marker+' '+code.replace(/\n/g,' ')+' '+marker;
    }
    const children = [...node.childNodes].map(markdown).join('');
    const body = children.trim();
    if (/^H[1-6]$/.test(tag) && body) return '\n\n'+'#'.repeat(Number(tag[1]))+' '+body+'\n\n';
    if (tag === 'P' || tag === 'DIV' || tag === 'SECTION') return body?'\n\n'+body+'\n\n':'';
    if (tag === 'STRONG' || tag === 'B') return body?'**'+body+'**':'';
    if (tag === 'EM' || tag === 'I') return body?'*'+body+'*':'';
    if (tag === 'BLOCKQUOTE') return '\n\n'+body.split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    if (tag === 'UL' || tag === 'OL') {
      const items = [...node.children].filter(child=>child.tagName==='LI').map((child,index)=>{
        const prefix = tag==='UL'?'- ':(index+1)+'. ';
        return prefix+markdown(child).trim().replace(/\n/g,'\n'+' '.repeat(prefix.length));
      });
      return '\n\n'+items.join('\n')+'\n\n';
    }
    if (tag === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].map(row=>[...row.children].map(cell=>
        markdown(cell).trim().replace(/\s*\n\s*/g,' ')));
      if (rows.length && rows[0].length && rows.every(row=>row.length===rows[0].length)) {
        const table = [rows[0],rows[0].map(()=> '---'),...rows.slice(1)];
        return '\n\n'+table.map(row=>'| '+row.join(' | ')+' |').join('\n')+'\n\n';
      }
      return '\n\n'+rows.map(row=>row.join(' · ')).join('  \n')+'\n\n';
    }
    return children;
  }
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
      const role = element.getAttribute('data-message-author-role') === 'user' || element.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant';
      const blocks = [...element.querySelectorAll('.standard-markdown')].filter(block=>
        shown(block)&&!element.contains(block.parentElement?.closest('.standard-markdown')));
      const contents = role==='assistant'&&blocks.length?blocks:[element];
      const limit = Math.min(budget,80_000);
      const plain = contents.map(text).filter(Boolean).join('\n\n');
      if (!plain) continue;
      const formatted = role==='assistant'&&plain.length<=limit?contents.map(block=>markdown(block).trim()).filter(Boolean).join('\n\n'):'';
      const rich = Boolean(formatted && formatted.length<=limit);
      const body = rich?formatted:plain.slice(-limit);
      messages.push({id:String(index),role,text:body,...(rich?{format:'markdown'}:{})});
      budget -= body.length;
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
