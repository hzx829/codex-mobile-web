import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {preflight, returnLogins} from '../src/connector/guest.js';
import {mergeCodexConfig, SYNC_END, SYNC_START} from '../src/connector/guest-settings.js';
import {checkClaude, checkCodex, explainClaude, explainCodex} from '../src/connector/guest-checks.js';
import {removeTestTemp} from '../scripts/test-temp.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cmw-guest-settings-'));
  const guestRoot = join(root, 'guest');
  const paths = {root: guestRoot, codexHome: join(guestRoot, 'codex-home'), claudeConfig: join(guestRoot, 'claude-config'), workspace: join(guestRoot, 'workspace')};
  const owner = {codex: join(root, 'owner', '.codex'), claude: join(root, 'owner', '.claude'), claudeJson: join(root, 'owner', '.claude.json')};
  await mkdir(owner.codex, {recursive: true});await mkdir(owner.claude, {recursive: true});
  return {root, paths, owner};
}
/** Both apps count as installed; the binaries themselves are never started here. */
async function withBinaries<T>(run: () => Promise<T>) {
  const saved = {codex: process.env.CODEX_BIN, claude: process.env.CLAUDE_CODE_BIN};
  process.env.CODEX_BIN = process.execPath;process.env.CLAUDE_CODE_BIN = process.execPath;
  try {return await run();} finally {
    for (const [key, value] of [['CODEX_BIN', saved.codex], ['CLAUDE_CODE_BIN', saved.claude]] as const)
      if (value === undefined) delete process.env[key];else process.env[key] = value;
  }
}

test('a login the guest refreshed goes back to the owner unless the owner signed in again', async () => {
  const {root, paths, owner} = await fixture();
  const ownerFile = join(owner.claude, '.credentials.json'), guestFile = join(paths.claudeConfig, '.credentials.json');
  const login = (token: string) => JSON.stringify({claudeAiOauth: {accessToken: token, refreshToken: token + '-refresh'}});
  try {
    await writeFile(ownerFile, login('first'));
    await withBinaries(() => preflight(paths, owner, {}));
    assert.equal(await readFile(guestFile, 'utf8'), login('first'));
    assert.deepEqual((await returnLogins(paths, owner)).messages, []);

    await writeFile(guestFile, login('guest-refreshed'));
    const returned = await returnLogins(paths, owner);
    assert.equal(returned.failed, false);
    assert.match(returned.messages.join(), /Claude Code：已把借用期间更新的登录写回/);
    assert.equal(await readFile(ownerFile, 'utf8'), login('guest-refreshed'));

    // The owner signs in again while the guest also refreshes: the owner's own login stays.
    await writeFile(ownerFile, login('owner-new'));
    await writeFile(guestFile, login('guest-again'));
    assert.match((await returnLogins(paths, owner)).messages.join(), /重新登录过，保留它自己的登录/);
    assert.equal(await readFile(ownerFile, 'utf8'), login('owner-new'));
    assert.deepEqual((await returnLogins(paths, owner)).messages, []);
    assert.equal(await readFile(ownerFile, 'utf8'), login('owner-new'));
  } finally {await removeTestTemp(root);}
});

test('the owner\'s proxy, endpoint and provider settings reach the guest folders', async () => {
  const {root, paths, owner} = await fixture();
  try {
    await writeFile(join(owner.claude, 'settings.json'), '\uFEFF' + JSON.stringify({
      env: {HTTPS_PROXY: 'http://127.0.0.1:7890', ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: 'fixture'},
      model: 'fixture-model', permissions: {allow: ['Bash']}, hooks: {Stop: []},
    }));
    await writeFile(owner.claudeJson, JSON.stringify({primaryApiKey: 'fixture-key', projects: {'C:/owner': {}}}));
    await writeFile(join(owner.codex, 'config.toml'), [
      'model = "fixture-model"', 'model_provider = "relay"', 'approval_policy = "never"', '',
      '[model_providers.relay]', 'name = "Relay"', 'base_url = "https://relay.example/v1"', 'env_key = "RELAY_KEY"', '',
      '[mcp_servers.owner]', 'command = "owner-tool"',
    ].join('\r\n'));
    await mkdir(paths.claudeConfig, {recursive: true});
    await writeFile(join(paths.claudeConfig, 'settings.json'), JSON.stringify({env: {OLD: '1'}, theme: 'dark'}));
    const result = await withBinaries(() => preflight(paths, owner, {}));
    // Neither app has a login file: the endpoint and provider settings are how these owners sign in.
    assert.deepEqual(result.services, ['codex', 'claude']);

    const claude = JSON.parse(await readFile(join(paths.claudeConfig, 'settings.json'), 'utf8'));
    assert.deepEqual(claude, {env: {HTTPS_PROXY: 'http://127.0.0.1:7890', ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: 'fixture'}, theme: 'dark', model: 'fixture-model'});
    assert.deepEqual(JSON.parse(await readFile(join(paths.claudeConfig, '.claude.json'), 'utf8')), {primaryApiKey: 'fixture-key'});
    const codex = await readFile(join(paths.codexHome, 'config.toml'), 'utf8');
    assert.match(codex, /model_provider = "relay"/);
    assert.match(codex, /\[model_providers\.relay\]\nname = "Relay"/);
    assert.doesNotMatch(codex, /approval_policy|mcp_servers/);

    // The owner removes the proxy: the guest copy follows on the next start.
    await writeFile(join(owner.claude, 'settings.json'), JSON.stringify({}));
    await withBinaries(() => preflight(paths, owner, {}));
    assert.deepEqual(JSON.parse(await readFile(join(paths.claudeConfig, 'settings.json'), 'utf8')), {theme: 'dark'});
  } finally {await removeTestTemp(root);}
});

test('a guest without the owner\'s login or settings is told to sign in', async () => {
  const {root, paths, owner} = await fixture();
  try {
    const result = await withBinaries(() => preflight(paths, owner, {}));
    assert.deepEqual(result.services, []);
    assert.match(result.messages.join('\n'), /还没有登录 Codex/);
    assert.match(result.messages.join('\n'), /还没有登录 Claude Code/);
  } finally {await removeTestTemp(root);}
});

test('Codex settings merge keeps the guest\'s own lines and updates in place', () => {
  const owner = [
    'model = "top"', 'profile = "work"', 'model_reasoning_effort = "high"', '',
    '[profiles.work]', 'model = "from-profile"', 'model_provider = "relay"', '',
    '[model_providers."relay"]', 'base_url = "https://relay.example"', 'http_headers = { "X-A" = "1" }', '',
    '[model_providers.relay.query_params]', 'v = "1"', '',
    '[model_providers.other]', 'base_url = "https://other.example"',
  ].join('\n');
  const guest = 'model_reasoning_effort = "low"\n\n[model_providers.other]\nbase_url = "https://mine.example"\n';
  const first = mergeCodexConfig(owner, guest);
  assert.equal(first.provider, 'relay');
  assert.equal(first.text, [
    SYNC_START, 'model = "from-profile"', 'model_provider = "relay"', SYNC_END, '',
    'model_reasoning_effort = "low"', '', '[model_providers.other]', 'base_url = "https://mine.example"', '',
    SYNC_START, '[model_providers."relay"]', 'base_url = "https://relay.example"', 'http_headers = { "X-A" = "1" }', '',
    '[model_providers.relay.query_params]', 'v = "1"', SYNC_END, '',
  ].join('\n'));
  assert.equal(mergeCodexConfig(owner, first.text).text, first.text);
  assert.deepEqual(mergeCodexConfig('', first.text), {text: 'model_reasoning_effort = "low"\n\n[model_providers.other]\nbase_url = "https://mine.example"\n', provider: undefined});
});

test('connection test failures name what to fix', () => {
  assert.match(explainCodex({message: 'x', codexErrorInfo: 'unauthorized'}).message, /登录已失效/);
  assert.match(explainCodex({message: 'x', codexErrorInfo: {httpConnectionFailed: {httpStatusCode: null}}}).message, /代理/);
  assert.equal(explainCodex({message: 'x', codexErrorInfo: 'usageLimitExceeded'}).ok, true);
  assert.match(explainClaude('authentication_failed', '').message, /登录已失效/);
  assert.match(explainClaude(undefined, 'API Error: Connection error.').message, /代理/);
  assert.equal(explainClaude('rate_limit', '').ok, true);
  assert.match(explainClaude(undefined, 'Something else').message, /Something else/);
});

test('the Codex test runs one ephemeral read-only turn and reads its outcome', async () => {
  class Runtime extends EventEmitter {
    calls: [string, any][] = [];
    constructor(private outcome: any) {super();}
    async rpc(method: string, params: any) {
      this.calls.push([method, params]);
      if (method === 'thread/start') return {thread: {id: 'probe'}};
      setImmediate(() => {
        this.emit('event', {method: 'turn/completed', params: {threadId: 'other', turn: {status: 'failed'}}});
        this.emit('event', {method: 'turn/completed', params: {threadId: 'probe', turn: this.outcome}});
      });
      return {turn: {id: 'turn'}};
    }
  }
  const ok = new Runtime({status: 'completed'});
  assert.deepEqual(await checkCodex(ok, 'C:/work'), {ok: true, message: ''});
  assert.deepEqual(ok.calls[0], ['thread/start', {cwd: 'C:/work', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only'}]);
  assert.equal(ok.listenerCount('event'), 0);
  const failed = await checkCodex(new Runtime({status: 'failed', error: {message: 'denied', codexErrorInfo: 'unauthorized'}}), 'C:/work');
  assert.equal(failed.ok, false);assert.match(failed.message, /登录已失效/);
  const silent = new Runtime({status: 'completed'});
  silent.rpc = async (method: string) => method === 'thread/start' ? {thread: {id: 'probe'}} : {turn: {id: 'turn'}};
  assert.match((await checkCodex(silent, 'C:/work', 20)).message, /没有回应/);
});

test('the Claude Code test sends one message without tools or a saved session', async () => {
  let options: any, closed = 0;
  const loader = (messages: any[]) => async () => (params: any) => {
    options = params.options;
    return Object.assign((async function* () {yield* messages;})(), {close() {closed++;}});
  };
  assert.deepEqual(await checkClaude(loader([{type: 'assistant'}, {type: 'result', subtype: 'success', is_error: false, result: 'OK'}]), 'C:/work'), {ok: true, message: ''});
  assert.equal(options.persistSession, false);assert.deepEqual(options.tools, []);assert.equal(options.maxTurns, 1);
  assert.ok(closed > 0);
  const offline = await checkClaude(loader([{type: 'result', subtype: 'success', is_error: true, result: 'API Error: Connection error.'}]), 'C:/work');
  assert.equal(offline.ok, false);assert.match(offline.message, /代理/);
  const hanging = async () => () => Object.assign((async function* () {await new Promise(() => {});})(), {close() {}});
  assert.match((await checkClaude(hanging as any, 'C:/work', 20)).message, /没有回应/);
});
