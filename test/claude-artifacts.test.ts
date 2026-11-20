import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ArtifactViewer, artifactSlug, findBrowser} from '../src/connector/claude-artifacts.js';
import {removeTestTemp} from '../scripts/test-temp.js';

// A 1x1 PNG.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('artifact links are limited to claude.ai Artifacts', () => {
  assert.equal(artifactSlug('https://claude.ai/artifact/FR2QT5upk4yhRE2SLNe2oM'), 'FR2QT5upk4yhRE2SLNe2oM');
  assert.equal(artifactSlug('https://claude.ai/code/artifact/7ea8be27-0000-4000-8000-000000000000?x=1'), '7ea8be27-0000-4000-8000-000000000000');
  for (const bad of ['https://evil.ai/artifact/FR2QT5upk4yhRE2SLNe2oM', 'http://claude.ai/artifact/FR2QT5upk4yhRE2SLNe2oM', 'https://claude.ai/artifact/../x', 'https://claude.ai/chat/abc12345', 42])
    assert.throws(() => artifactSlug(bad), /只能打开/);
});

test('a rendered Artifact frame becomes a static page without scripts', {skip: !findBrowser() && 'no Edge or Chrome on this computer', timeout: 120_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-artifact-'));
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://x').pathname;
    const send = (type: string, body: string | Buffer) => {response.writeHead(200, {'content-type': type.startsWith('text/') ? type + '; charset=utf-8' : type});response.end(body);};
    if (path === '/artifact/FR2QT5upk4yhRE2SLNe2oM') return send('text/html', `<title>持仓决策看板 – Claude</title><h1>shell</h1><iframe src="http://127.0.0.1:${port}/frame" style="width:100%;height:600px"></iframe>`);
    if (path === '/frame') return send('text/html', `<!doctype html><html data-theme="x"><head><link rel="stylesheet" href="/style.css"><style>.dyn{color:rgb(1,2,3)}</style></head>
      <body><div id="root">loading</div><canvas id="c" width="20" height="10"></canvas><input id="q"><my-card></my-card><img src="/dot.png" alt="dot">
      <iframe srcdoc="<p id=inner>nested frame</p>" style="height:40px"></iframe>
      <a href="/elsewhere" onclick="alert(1)">link</a>
      <script>
        setTimeout(() => {
          document.getElementById('root').innerHTML = '<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg><p class="dyn">卖出泡泡玛特</p>';
          const c = document.getElementById('c').getContext('2d'); c.fillStyle = 'blue'; c.fillRect(0, 0, 20, 10);
          document.getElementById('q').value = '已输入';
          customElements.define('my-card', class extends HTMLElement { constructor() { super(); this.attachShadow({mode: 'open'}).innerHTML = '<b>shadow text</b>'; } });
        }, 300);
      </script></body></html>`);
    if (path === '/style.css') return send('text/css', 'body{background:url(dot.png) repeat}#root{font-weight:700}');
    if (path === '/dot.png') return send('image/png', png);
    response.writeHead(404);response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  const viewer = new ArtifactViewer(root, undefined, /^127\.0\.0\.1$/, 60_000);
  try {
    // The fixture stands in for claude.ai: rewrite the Artifact URL to the local page.
    (viewer as any).capture = ((original) => function (this: ArtifactViewer, url: string, ...rest: unknown[]) {
      return original.call(this, url.replace('https://claude.ai', `http://localhost:${port}`), ...rest);
    })((viewer as any).capture);
    let result = await viewer.snapshot({url: 'https://claude.ai/artifact/FR2QT5upk4yhRE2SLNe2oM', width: 400}, 100_000);
    assert.equal(result.state, 'ready', JSON.stringify(result));
    if (result.state !== 'ready') return;
    assert.equal(result.title, '持仓决策看板');
    const chunk = await viewer.download({slug: result.slug, name: result.file.name, revision: result.file.revision, offset: 0});
    const html = Buffer.from(chunk.data, 'base64').toString('utf8');
    assert.equal(Buffer.byteLength(html), result.file.size);
    assert.match(html, /卖出泡泡玛特/);
    assert.match(html, /<svg/);
    assert.match(html, /shadowrootmode="open"><b>shadow text<\/b>/);
    assert.match(html, /value="已输入"/);
    assert.match(html, /<img src="data:image\/png;base64,[^"]+"[^>]*style="[^"]*width:20px/);
    assert.match(html, /<img src="data:image\/png;base64,iVBOR[^"]*" alt="dot">/);
    assert.match(html, /background:\s*url\("data:image\/png;base64,iVBOR/);
    assert.match(html, /font-weight:\s*700/);
    assert.match(html, /\.dyn\s*\{\s*color: rgb\(1, 2, 3\)/);
    assert.match(html, /srcdoc="[^"]*nested frame/);
    assert.match(html, /href="http:\/\/127\.0\.0\.1:\d+\/elsewhere" target="_blank"/);
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /<script|onclick|shell/i);
    // A second request reuses the saved copy.
    const again = await viewer.snapshot({url: 'https://claude.ai/artifact/FR2QT5upk4yhRE2SLNe2oM', width: 400}, 100);
    assert.equal(again.state, 'ready');
    await assert.rejects(viewer.download({slug: result.slug, name: '../x.html', revision: '', offset: 0}), /无效/);
  } finally {
    await viewer.close();server.close();
    await removeTestTemp(root);
  }
});

test('saved snapshots name pages the transcript leaves unnamed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-artifact-titles-'));
  try {
    const saved = join(dir, 'claude-artifacts', 'FR2QT5upk4yhRE2SLNe2oM');
    await mkdir(saved, {recursive: true});
    await writeFile(join(saved, '400-light.json'), JSON.stringify({title: '持仓决策看板', at: 1}));
    await mkdir(join(dir, 'claude-artifacts', 'PLsEyfjXbDUM1iasW7rjLR'), {recursive: true});
    await writeFile(join(dir, 'claude-artifacts', 'PLsEyfjXbDUM1iasW7rjLR', '400-light.json'), JSON.stringify({title: 'claude.ai 页面', at: 1}));
    const titles = await new ArtifactViewer(dir, () => undefined).savedTitles([
      'https://claude.ai/artifact/FR2QT5upk4yhRE2SLNe2oM', 'https://claude.ai/artifact/PLsEyfjXbDUM1iasW7rjLR', 'https://claude.ai/artifact/S4skLPbN9WeoFmuiTfaEFy', 'not a link']);
    assert.deepEqual([...titles], [['https://claude.ai/artifact/FR2QT5upk4yhRE2SLNe2oM', '持仓决策看板']]);
  } finally {await removeTestTemp(dir);}
});
