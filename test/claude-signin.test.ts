import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';
import {createServer} from 'node:http';
import {ArtifactViewer, findBrowser, profileFolder} from '../src/connector/claude-artifacts.js';
import {relayStatus} from '../scripts/setup-status.js';
import {removeTestTemp} from '../scripts/test-temp.js';

test('the claude.ai sign-in is answered from what was last seen, without starting a browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-signin-'));
  try {
    const chrome = 'C:\\x\\chrome.exe', viewer = new ArtifactViewer(dir, () => chrome);
    const check = async (from = viewer) => (await from.signIn({op: 'check'})).signedIn;
    assert.equal(await check(), 'no', 'a computer that never opened the browser is not signed in');
    await mkdir(join(dir, profileFolder(chrome)));
    assert.equal(await check(), 'unknown', 'a profile from before sign-ins were recorded may be signed in');
    await writeFile(join(dir, 'claude-signin.json'), JSON.stringify({profile: profileFolder(chrome), signedIn: true}));
    assert.equal(await check(), 'yes');
    // The record belongs to the browser that made it.
    assert.equal(await check(new ArtifactViewer(dir, () => 'C:\\x\\msedge.exe')), 'no');
    assert.deepEqual(await new ArtifactViewer(dir, () => undefined).signIn({op: 'check'}), {desktop: true, available: false, signedIn: 'no'});
  } finally {await removeTestTemp(dir);}
});

test('the status check reports the claude.ai sign-in only where Claude Code is there and the connector answers', async () => {
  const server = new WebSocketServer({port: 0, host: '127.0.0.1'});
  let services = ['codex', 'claude'], answer: Record<string, unknown> = {result: {desktop: true, available: true, signedIn: 'no'}}, asked = 0;
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'hello') socket.send(JSON.stringify({type: 'ready', machines: [{id: 'm1', services}]}));
    else if (message.action === 'info') socket.send(JSON.stringify({type: 'response', id: message.id, result: {runtime: {version: '1.0'}}}));
    else if (message.action === 'claude.artifact.login') {asked++;assert.deepEqual(message.payload, {op: 'check'});socket.send(JSON.stringify({type: 'response', id: message.id, ...answer}));}
  }));
  await new Promise(resolve => server.once('listening', resolve));
  const config = {relayUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`, token: 't', machineId: 'm1'};
  try {
    assert.equal((await relayStatus(config)).claudeSignIn, 'no');
    answer = {result: {desktop: true, available: true, signedIn: 'yes'}};
    assert.equal((await relayStatus(config)).claudeSignIn, 'yes');
    // An older connector refuses the question, and a computer without a browser cannot sign in at all.
    answer = {error: {code: 'expired', message: '登录窗口已关闭，请重新开始'}};
    const old = await relayStatus(config);
    assert.equal(old.claudeSignIn, undefined);
    assert.equal(old.codexVersion, '1.0');
    answer = {result: {desktop: true, available: false, signedIn: 'no'}};
    assert.equal((await relayStatus(config)).claudeSignIn, undefined);
    services = ['codex'];
    const before = asked;
    assert.equal((await relayStatus(config)).claudeSignIn, undefined);
    assert.equal(asked, before, 'a computer without Claude Code is not asked');
  } finally {for (const client of server.clients) client.terminate();await new Promise(resolve => server.close(resolve));}
});

/** A stand-in for claude.ai's sign-in page, with the same markup the connector reads: steps, forms and alert slots. */
const FAKE_LOGIN = `<!doctype html><title>Sign in</title>
<style>.si-step{display:none}.si-step[data-active]{display:block}</style>
<div style="position:absolute;width:0;height:0;overflow:hidden"><iframe src="about:blank#hcaptcha" width="300" height="300"></iframe></div>
<div class="si-step" data-step="email" data-active><form data-form="email"><input id="email" type="email"><button type="submit" data-testid="continue">Continue</button></form></div>
<div class="si-step" data-step="sent"><p>Check your email</p><a href="#" data-action="enter-code" data-testid="enter-code">Enter code</a></div>
<div class="si-step" data-step="code"><form data-form="code"><input id="code"><div class="si-alert" role="alert" hidden></div><button type="submit" data-testid="continue">Verify</button></form></div>
<script>
const show = step => document.querySelectorAll('.si-step').forEach(el => el.toggleAttribute('data-active', el.dataset.step === step));
document.querySelector('[data-form=email]').addEventListener('submit', e => {e.preventDefault(); fetch('/sent?to=' + encodeURIComponent(document.querySelector('#email').value)).then(() => setTimeout(() => show('sent'), 1500));});
document.querySelector('[data-action=enter-code]').addEventListener('click', e => {e.preventDefault(); show('code');});
document.querySelector('[data-form=code]').addEventListener('submit', e => {
  e.preventDefault();
  const code = document.querySelector('#code').value, alert = document.querySelector('[data-form=code] [role=alert]');
  if (code === '123456') location.href = '/verify'; else {alert.textContent = '验证码无效'; alert.hidden = false;}
});
</script>`;

test('claude.ai is signed in by email with the code handed back, or with a pasted session cookie', {skip: !findBrowser() && 'no Edge or Chrome on this computer', timeout: 180_000}, async () => {
  const good = 'sk-ant-sid01-' + 'a'.repeat(40);
  let sentTo = '', checking = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x'), cookie = req.headers.cookie || '';
    if (checking) {res.writeHead(403, {'content-type': 'text/html; charset=utf-8'});res.end('<title>请稍候…</title>正在进行安全验证');}
    else if (url.pathname === '/login') {res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});res.end(FAKE_LOGIN);}
    else if (url.pathname === '/sent') {sentTo = url.searchParams.get('to') || '';res.end('ok');}
    else if (url.pathname === '/verify') {res.writeHead(302, {'set-cookie': `sessionKey=${good}; Path=/; HttpOnly`, location: '/new'});res.end();}
    else if (url.pathname === '/api/organizations') {res.writeHead(cookie.includes(`sessionKey=${good}`) ? 200 : 403);res.end('[]');}
    else {res.writeHead(200, {'content-type': 'text/html'});res.end('<title>Claude</title>home');}
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const dirs = [await mkdtemp(join(tmpdir(), 'cmw-email-')), await mkdtemp(join(tmpdir(), 'cmw-cookie-'))];
  const viewers = dirs.map(dir => new ArtifactViewer(dir, () => findBrowser(), undefined, 60_000, Date.now, site));
  try {
    const [email, cookie] = viewers;
    await assert.rejects(email.signIn({op: 'email', email: 'not an address'}), {code: 'invalid'});
    await assert.rejects(email.signIn({op: 'code', code: '123456'}), {code: 'expired'}, 'a code needs an email sign-in under way');
    assert.deepEqual(await email.signIn({op: 'email', email: 'me@example.com'}), {stage: 'sent', email: 'me@example.com'});
    assert.equal(sentTo, 'me@example.com');
    const wrong = await email.signIn({op: 'code', code: '000000'});
    assert.equal(wrong.stage, 'error');
    assert.match(wrong.message, /验证码无效/);
    assert.deepEqual(await email.signIn({op: 'code', code: '123 456'}), {stage: 'done', signedIn: true});
    assert.equal((await email.signIn({op: 'check'})).signedIn, 'yes');
    await assert.rejects(email.signIn({op: 'code', code: 'https://evil.example/login'}), {code: 'invalid'}, 'only sign-in links are opened');

    await assert.rejects(cookie.signIn({op: 'cookie', value: 'hello'}), {code: 'invalid'});
    const refused = await cookie.signIn({op: 'cookie', value: 'sk-ant-sid01-' + 'b'.repeat(40)});
    assert.equal(refused.stage, 'error', 'a key the site refuses is not kept');
    assert.equal((await cookie.signIn({op: 'check'})).signedIn, 'no');
    assert.deepEqual(await cookie.signIn({op: 'cookie', value: ` sessionKey=${good}; `}), {stage: 'done', signedIn: true});
    assert.equal((await cookie.signIn({op: 'check'})).signedIn, 'yes');

    // A Cloudflare check that stays is not a sign-out: it is reported for the window on the computer's screen.
    checking = true;
    assert.equal((await email.signIn({op: 'email', email: 'me@example.com'})).stage, 'challenge');
    assert.equal((await email.signIn({op: 'check'})).signedIn, 'yes', 'the check leaves the sign-in as it was');
  } finally {
    await Promise.all(viewers.map(viewer => viewer.close()));
    await new Promise(resolve => server.close(resolve));
    for (const dir of dirs) await removeTestTemp(dir);
  }
});
