import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {appendFile, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {removeTestTemp} from '../scripts/test-temp.js';
import {
  detectDefaultActorName,
  runSessionCli,
  startInProcessSessionDaemon,
} from '../src/cli/session-cli.js';
import {AntigravityBridge, toAntigravityFileUri} from '../src/connector/antigravity.js';
import {ClaudeCodeBridge, type ClaudeSessions} from '../src/connector/claude-code.js';
import {ClaudeRuntime, type QueryFn} from '../src/connector/claude-runtime.js';
import {Control} from '../src/connector/control.js';
import {Ledger, actorOf, requestActor} from '../src/connector/ledger.js';
import {LocalControlServer, SESSION_DAEMON_FILE, globalControlDir, readLocalControl} from '../src/connector/local-control.js';
import {
  AntigravitySessionDriver,
  ClaudeSessionDriver,
  CodexSessionDriver,
  SessionHub,
  resolveAlignedProjectCwd,
} from '../src/connector/session-hub.js';
import {BridgeError, type Json} from '../src/shared/types.js';

const stepLine = (step: object) => JSON.stringify(step) + '\n';

test('SessionHub delegates Claude -> Antigravity with auto project setup, turbo autonomy, approval wakeup, and multi-turn wait', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-session-ag-'));
  const home = join(root, 'home');
  const agDir = join(home, '.gemini', 'antigravity');
  const projectsDir = join(home, '.gemini', 'config', 'projects');
  const projectDir = join(home, 'Projects', 'demo-app');
  await mkdir(agDir, {recursive: true});
  await mkdir(projectsDir, {recursive: true});
  await mkdir(projectDir, {recursive: true});

  const ledger = new Ledger(':memory:');
  const db = new DatabaseSync(join(agDir, 'conversation_summaries.db'));
  t.after(async () => {
    db.close();
    ledger.close();
    await removeTestTemp(root);
  });

  db.exec(`CREATE TABLE conversation_summaries(
    conversation_id TEXT,
    title TEXT,
    status TEXT,
    last_modified_time TEXT,
    step_count INTEGER,
    last_user_input_step_index INTEGER,
    last_user_input_time TEXT,
    not_fully_idle INTEGER,
    workspace_uris TEXT
  )`);
  const insertRow = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)');
  const updateRow = db.prepare('UPDATE conversation_summaries SET status=?, last_modified_time=?, step_count=?, last_user_input_step_index=?, last_user_input_time=?, not_fully_idle=? WHERE conversation_id=?');

  const cascadeId = randomUUID();
  const hubCalls: {method: string; body: Json}[] = [];
  let waitingSteps: Json[] = [];

  const bridge = new AntigravityBridge(
    agDir,
    ledger,
    async (_dir, method, body) => {
      hubCalls.push({method, body});
      if (method === 'ResolveFolder') {
        return {resourceType: 'FOLDER_TYPE_GIT_FOLDER', vcsType: 'VCS_TYPE_GIT'};
      }
      if (method === 'CreateProject') {
        const proj = body.project;
        await writeFile(join(projectsDir, `${proj.id}.json`), JSON.stringify(proj));
        return {};
      }
      if (method === 'GetCascadeModelConfigData') {
        return {
          clientModelConfigs: [{label: 'Gemini Pro', modelOrAlias: {model: 'MODEL_PRO'}, supportsImages: true}],
          defaultOverrideModelConfig: {modelOrAlias: {model: 'MODEL_PRO'}},
        };
      }
      if (method === 'GetPermissionSettings') {
        return {globalPreset: 'AGENT_PERMISSION_PRESET_DEFAULT'};
      }
      if (method === 'GetAllCascadeTrajectories') {
        return {trajectorySummaries: {[cascadeId]: {trajectoryId: cascadeId}}};
      }
      if (method === 'StartCascade') {
        return {cascadeId};
      }
      if (method === 'UpdateConversationAnnotations') {
        return {};
      }
      if (method === 'GetTrajectoryTurns') {
        return {
          turns: [{
            startStepIndex: 1,
            firstStep: {userInput: {userConfig: {plannerConfig: {planModel: 'MODEL_PRO'}}}},
          }],
        };
      }
      if (method === 'GetCascadeTrajectorySteps') {
        return {steps: waitingSteps};
      }
      if (method === 'SendUserCascadeMessage') {
        return {};
      }
      if (method === 'HandleCascadeUserInteraction') {
        waitingSteps = [];
        return {};
      }
      if (method === 'CancelCascadeInvocation') {
        return {};
      }
      return {};
    },
    projectsDir,
    {queueIntervalMs: 60_000},
  );
  t.after(() => bridge.close());

  const safety = {home, dataDir: join(root, 'data')};
  const hub = new SessionHub([new AntigravitySessionDriver(bridge, safety)], {
    dispatchGraceMs: 3_000,
    waitPollMs: 40,
  });

  // 1. Start task from Claude Code actor: auto-registers Antigravity project and defaults to TURBO.
  const started = await requestActor.run(actorOf({userId: 'agent:claude-code', name: 'Claude Code'}), () =>
    hub.handle('agent.session.start', {
      service: 'antigravity',
      cwd: projectDir,
      prompt: '请重构登录页组件并补测试',
    }),
  );

  assert.equal(started.service, 'antigravity');
  assert.equal(started.sessionId, cascadeId);
  assert.equal(started.autonomy, 'turbo');
  assert.equal(started.projectCreated, true);
  assert.equal(started.session.phase, 'running');

  const createProjectCall = hubCalls.find(c => c.method === 'CreateProject');
  assert.ok(createProjectCall, 'expected Antigravity project auto-registration');
  assert.equal(createProjectCall.body.project.name, 'demo-app');
  const createdProjectId = createProjectCall.body.project.id;

  const startCascadeCall = hubCalls.find(c => c.method === 'StartCascade');
  assert.equal(startCascadeCall?.body.projectEnvConfig?.projectId, createdProjectId);
  assert.deepEqual(startCascadeCall?.body.workspaceUris, [toAntigravityFileUri(projectDir)]);

  const firstSendCall = hubCalls.find(c => c.method === 'SendUserCascadeMessage');
  assert.equal(
    firstSendCall?.body.cascadeConfig?.plannerConfig?.toolConfig?.runCommand?.autoCommandConfig?.autoExecutionPolicy,
    'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER',
  );

  // 2. Simulate SQLite flushing an initial IDLE row before RUNNING, then hitting an `ask_question` interaction.
  const logsDir = join(agDir, 'brain', cascadeId, '.system_generated', 'logs');
  await mkdir(logsDir, {recursive: true});
  const transcriptPath = join(logsDir, 'transcript_full.jsonl');
  const uri = toAntigravityFileUri(projectDir);
  insertRow.run(cascadeId, '重构登录页', 'CASCADE_RUN_STATUS_IDLE', '2026-11-27T06:00:00.000Z', 0, null, null, 0, JSON.stringify([uri]));

  const wait1Promise = hub.handle('agent.session.wait', {
    service: 'antigravity',
    sessionId: cascadeId,
    timeoutMs: 5_000,
  });

  setTimeout(async () => {
    await writeFile(transcriptPath, stepLine({
      type: 'USER_INPUT',
      step_index: 1,
      content: '<USER_REQUEST>请重构登录页组件并补测试</USER_REQUEST>',
    }));
    waitingSteps = [{
      stepIndex: 2,
      status: 'CORTEX_STEP_STATUS_WAITING',
      requestedInteraction: {
        askQuestion: {
          questions: [{
            question: '登录表单使用哪种布局？',
            isMultiSelect: false,
            options: [{id: 'card', text: '居中卡片'}, {id: 'split', text: '左右分栏'}],
          }],
        },
      },
    }];
    updateRow.run('CASCADE_RUN_STATUS_RUNNING', '2026-11-27T06:00:01.000Z', 3, 1, 't1', 1, cascadeId);
  }, 60);

  const wait1 = await wait1Promise;
  assert.equal(wait1.stopReason, 'approval_needed');
  assert.equal(wait1.session.phase, 'waiting_approval');
  assert.equal(wait1.session.requests.length, 1);
  assert.equal(wait1.session.requests[0].questions?.[0].question, '登录表单使用哪种布局？');

  // Verify sender attribution was recorded as "Claude Code"
  const agRead = await bridge.handle('antigravity.read', {conversationId: cascadeId});
  assert.equal(agRead.messages[0]?.sender?.name, 'Claude Code');

  // 3. Respond to the question and wait until turn 1 finishes.
  await hub.handle('agent.session.respond', {
    service: 'antigravity',
    sessionId: cascadeId,
    requestId: '2',
    decision: 'allow',
    answers: {'登录表单使用哪种布局？': '居中卡片'},
  });
  const handleInteractionCall = hubCalls.find(c => c.method === 'HandleCascadeUserInteraction');
  assert.deepEqual(handleInteractionCall?.body.interaction.askQuestion.responses[0].selectedOptionIds, ['card']);

  const waitAfterRespond = hub.handle('agent.session.wait', {
    service: 'antigravity',
    sessionId: cascadeId,
    timeoutMs: 5_000,
  });
  setTimeout(async () => {
    await appendFile(transcriptPath, stepLine({
      type: 'PLANNER_RESPONSE',
      step_index: 3,
      content: '已完成居中卡片版登录页重构，测试全部通过。',
    }));
    updateRow.run('CASCADE_RUN_STATUS_IDLE', '2026-11-27T06:00:02.000Z', 4, 1, 't1', 0, cascadeId);
  }, 60);

  const done1 = await waitAfterRespond;
  assert.equal(done1.stopReason, 'completed');
  assert.equal(done1.session.phase, 'idle');
  assert.equal(done1.session.lastAssistantReply, '已完成居中卡片版登录页重构，测试全部通过。');

  // 4. Multi-turn follow-up (`agent.session.send` with `wait: true`): must wait for turn 2's reply, not return turn 1's reply!
  const turn2Promise = hub.handle('agent.session.send', {
    service: 'antigravity',
    sessionId: cascadeId,
    prompt: '再补一个暗色模式切换按钮',
    wait: true,
    timeoutMs: 5_000,
  });
  setTimeout(async () => {
    updateRow.run('CASCADE_RUN_STATUS_RUNNING', '2026-11-27T06:00:03.000Z', 5, 4, 't2', 1, cascadeId);
    await appendFile(transcriptPath, stepLine({
      type: 'USER_INPUT',
      step_index: 4,
      content: '<USER_REQUEST>再补一个暗色模式切换按钮</USER_REQUEST>',
    }) + stepLine({
      type: 'PLANNER_RESPONSE',
      step_index: 5,
      content: '暗色模式按钮已添加并完成校验。',
    }));
    updateRow.run('CASCADE_RUN_STATUS_IDLE', '2026-11-27T06:00:04.000Z', 6, 4, 't2', 0, cascadeId);
  }, 80);

  const done2 = await turn2Promise;
  assert.equal(done2.waitResult?.stopReason, 'completed');
  assert.equal(done2.session.lastAssistantReply, '暗色模式按钮已添加并完成校验。');
});

test('SessionHub unifies Codex, Claude Code, and Antigravity under one cross-app session contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-session-all-'));
  const home = join(root, 'home');
  const projectDir = join(home, 'Projects', 'unified');
  const agDir = join(home, '.gemini', 'antigravity');
  const claudeDir = join(home, '.claude');
  await mkdir(projectDir, {recursive: true});
  await mkdir(agDir, {recursive: true});
  await mkdir(join(claudeDir, 'projects', 'unified'), {recursive: true});

  const ledger = new Ledger(':memory:');
  const agDb = new DatabaseSync(join(agDir, 'conversation_summaries.db'));
  agDb.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const agId = randomUUID();
  agDb.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)').run(
    agId, 'AG 任务', 'CASCADE_RUN_STATUS_IDLE', '2026-11-15T08:00:00.000Z', 2, 1, 'u1', 0, JSON.stringify([toAntigravityFileUri(projectDir)]),
  );

  // Mock Codex Control
  class FakeCodexRuntime extends EventEmitter {
    requests = new Map<string, Json>();
    calls: {method: string; params: Json}[] = [];
    responded: {id: string; result: Json}[] = [];
    async rpc(method: string, params: Json = {}): Promise<Json> {
      this.calls.push({method, params});
      if (method === 'project/list') return {projects: []};
      if (method === 'project/create') {
        return {project: {id: 'codex-proj-1', name: params.name, roots: params.roots}};
      }
      if (method === 'thread/start') {
        return {thread: {id: 'codex-t1', cwd: params.cwd, title: 'Codex 任务', turns: []}, model: 'gpt-6-astra', modelProvider: 'openai', approvalPolicy: params.approvalPolicy};
      }
      if (method === 'turn/start') {
        return {turn: {id: 'turn-1'}};
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'codex-t1',
            title: 'Codex 任务',
            cwd: projectDir,
            model: 'gpt-6-astra',
            modelProvider: 'openai',
            approvalPolicy: 'never',
            turns: [{
              id: 'turn-1',
              status: 'completed',
              items: [
                {id: 'u1', type: 'userMessage', role: 'user', text: '跑单元测试'},
                {id: 'a1', type: 'agentMessage', role: 'assistant', text: 'Codex 测试通过'},
              ],
            }],
          },
        };
      }
      return {};
    }
    async respond(id: string, result: Json) {
      this.responded.push({id, result});
      this.requests.delete(id);
    }
    async unsubscribe() {}
    close() {}
  }
  class FakeDesktop extends EventEmitter {
    clientId = '';
    states = new Map();
    async connect() {}
    async follow() { throw new Error('not desktop'); }
    async refreshThread() {}
    close() {}
  }

  const codexRuntime = new FakeCodexRuntime();
  const control = new Control(
    ledger,
    codexRuntime as any,
    new FakeDesktop() as any,
    async () => [],
    () => null,
    () => ({data: [{id: 'codex-t1', title: 'Codex 任务', cwd: projectDir, model: 'gpt-6-astra', provider: 'openai', updatedAt: 1_795_000_002}], nextCursor: null}),
    async () => false,
  );

  // Mock Claude Code Bridge
  const claudeSessionId = '22222222-3333-4444-8555-666666666666';
  const claudeTranscriptFile = join(claudeDir, 'projects', 'unified', `${claudeSessionId}.jsonl`);
  const claudeStarts: Json[] = [];
  const query: QueryFn = ({prompt, options}) => {
    claudeStarts.push(options as Json);
    async function* run(): AsyncGenerator<any> {
      yield {type: 'system', subtype: 'init', session_id: claudeSessionId};
      for await (const msg of prompt) {
        await writeFile(claudeTranscriptFile, [
          JSON.stringify({type: 'user', uuid: 'cu1', sessionId: claudeSessionId, cwd: projectDir, message: {role: 'user', content: msg.message.content}}),
          JSON.stringify({type: 'assistant', uuid: 'ca1', sessionId: claudeSessionId, cwd: projectDir, message: {id: 'm1', role: 'assistant', content: [{type: 'text', text: 'Claude 已处理完毕'}]}}),
        ].join('\n') + '\n');
        yield {type: 'result', subtype: 'success', session_id: claudeSessionId, errors: []};
      }
    }
    const gen = run() as any;
    gen.close = () => {};
    gen.interrupt = async () => {};
    return gen;
  };
  const claudeSessions: ClaudeSessions = {
    listSessions: async () => [{sessionId: claudeSessionId, summary: 'Claude 任务', cwd: projectDir, lastModified: 1_795_000_003_000}],
    getSessionInfo: async id => id === claudeSessionId ? {sessionId: id, summary: 'Claude 任务', cwd: projectDir, lastModified: 1_795_000_003_000} : undefined,
    getSessionMessages: async () => [
      {type: 'user', uuid: 'cu1', message: {role: 'user', content: '检查架构'}},
      {type: 'assistant', uuid: 'ca1', message: {id: 'm1', role: 'assistant', content: [{type: 'text', text: 'Claude 已处理完毕'}]}},
    ],
    forkSession: async () => ({sessionId: randomUUID()}),
    renameSession: async () => {},
    archiveSession: async () => {},
  };
  const claudeRuntime = new ClaudeRuntime(async () => query, () => undefined, 60_000);
  const claudeBridge = new ClaudeCodeBridge(ledger, claudeDir, async () => claudeSessions, Date.now, claudeRuntime);
  const agBridge = new AntigravityBridge(agDir, ledger, async () => ({}), join(home, '.gemini', 'config', 'projects'), {queueIntervalMs: 60_000});

  t.after(async () => {
    agBridge.close();
    claudeBridge.close();
    control.close();
    agDb.close();
    await removeTestTemp(root);
  });

  const safety = {home, dataDir: join(root, 'data')};
  const hub = new SessionHub([
    new AntigravitySessionDriver(agBridge, safety),
    new CodexSessionDriver(control, safety),
    new ClaudeSessionDriver(claudeBridge, safety),
  ], {waitPollMs: 40});

  // Start Codex session via unified SessionHub -> defaults to `approvalPolicy: 'never'`
  const codexStart = await hub.handle('agent.session.start', {
    service: 'codex',
    cwd: projectDir,
    prompt: '跑单元测试',
  });
  assert.equal(codexStart.sessionId, 'codex-t1');
  assert.equal(codexStart.projectCreated, true);
  assert.equal(codexRuntime.calls.find(c => c.method === 'thread/start')?.params.projectId, 'codex-proj-1');
  assert.equal(codexRuntime.calls.find(c => c.method === 'thread/start')?.params.approvalPolicy, 'never');

  // Start Claude session via unified SessionHub with `wait: true` -> defaults to `bypassPermissions`
  const claudeStart = await hub.handle('agent.session.start', {
    service: 'claude',
    cwd: projectDir,
    prompt: '检查架构',
    wait: true,
    timeoutMs: 5_000,
  });
  assert.equal(claudeStart.sessionId, claudeSessionId);
  assert.equal(claudeStarts[0]?.permissionMode, 'bypassPermissions');
  assert.equal(claudeStart.waitResult?.stopReason, 'completed');
  assert.equal(claudeStart.session.lastAssistantReply, 'Claude 已处理完毕');

  // List across all 3 services merged & ordered by updatedAt desc
  const merged = await hub.handle('agent.session.list', {service: 'all', cwd: projectDir});
  assert.deepEqual(
    merged.sessions.map((s: Json) => s.service),
    ['claude', 'codex', 'antigravity'],
  );
});

test('cmw-session CLI routes via published LocalControlServer and falls back in-process on legacy connectors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-session-cli-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'connector-data');
  const agDir = join(home, '.gemini', 'antigravity');
  const projectsDir = join(home, '.gemini', 'config', 'projects');
  const projectDir = join(home, 'Projects', 'cli-app');
  await mkdir(agDir, {recursive: true});
  await mkdir(projectsDir, {recursive: true});
  await mkdir(projectDir, {recursive: true});

  const agDb = new DatabaseSync(join(agDir, 'conversation_summaries.db'));
  agDb.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const fallbackId = randomUUID();
  agDb.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)').run(
    fallbackId, '本地直连会话', 'CASCADE_RUN_STATUS_IDLE', '2026-11-27T09:00:00.000Z', 2, 1, 'u1', 0, JSON.stringify([toAntigravityFileUri(projectDir)]),
  );
  t.after(async () => {
    agDb.close();
    await removeTestTemp(root);
  });

  // 1. Live connector supporting `agent.session.*` via global discovery `~/.codex-mobile-web/local-control.json`
  let receivedActor: Json | undefined;
  const fakeId = randomUUID();
  const server = new LocalControlServer({
    dataDir,
    publishGlobal: true,
    homeDir: home,
    getStatus: async () => ({
      relay: 'ok',
      connector: 'online',
      teamMode: false,
      ownToken: false,
      machineId: 'pc-1',
      machineName: 'PC',
      services: ['antigravity'],
      activeTasks: [],
      pendingUsage: 0,
    }),
    handleRequest: async (action, payload, actor) => {
      receivedActor = actor;
      if (action === 'agent.session.start') {
        return {
          service: payload.service,
          sessionId: fakeId,
          cwd: payload.cwd,
          autonomy: payload.autonomy,
          projectCreated: true,
          submitted: true,
          baseline: {userCount: 0, startedAt: Date.now()},
          session: {
            service: payload.service,
            sessionId: fakeId,
            title: '新对话',
            cwd: payload.cwd,
            phase: 'running',
            running: true,
            canSend: false,
            autonomy: payload.autonomy,
            recentMessages: [{id: '0', role: 'user', text: payload.prompt}],
            requests: [],
            backgroundTasks: [],
            queuedCount: 0,
          },
        };
      }
      throw new BridgeError('unsupported', 'unexpected');
    },
  });
  await server.start();

  const outputs: string[] = [];
  const errors: string[] = [];
  const code1 = await runSessionCli(
    ['start', '--to', 'antigravity', '--cwd', projectDir, '--stdin'],
    {
      homeDir: home,
      env: {},
      stdinText: async () => '用 Antigravity 生成着陆页原型\n包含响应式预览',
      stdout: text => outputs.push(text),
      stderr: text => errors.push(text),
    },
  );
  server.close();

  assert.equal(code1, 0, errors.join('\n'));
  assert.equal(receivedActor?.name, 'Claude Code');
  assert.match(outputs[0], /\[SESSION STARTED\]/);
  assert.match(outputs[0], new RegExp(`session_id: ${fakeId}`));
  assert.match(outputs[0], /autonomy: turbo/);
  assert.match(outputs[0], /next_wait_cmd: cmw-session wait/);

  // 2. Legacy connector returning `unsupported` -> seamlessly falls back to in-process SessionHub
  const legacyServer = new LocalControlServer({
    dataDir: join(root, 'legacy-data'),
    publishGlobal: true,
    homeDir: home,
    getStatus: async () => ({
      relay: 'ok',
      connector: 'online',
      teamMode: false,
      ownToken: false,
      machineId: 'pc-legacy',
      machineName: 'PC',
      services: ['antigravity'],
      activeTasks: [],
      pendingUsage: 0,
    }),
    handleRequest: async () => {
      throw new BridgeError('unsupported', '此操作暂不支持');
    },
  });
  await legacyServer.start();

  const fallbackOutputs: string[] = [];
  const fallbackErrors: string[] = [];
  const code2 = await runSessionCli(
    ['list', '--to', 'antigravity', '--cwd', projectDir, '--json'],
    {
      homeDir: home,
      env: {CMW_ANTIGRAVITY_HOME: agDir},
      stdout: text => fallbackOutputs.push(text),
      stderr: text => fallbackErrors.push(text),
    },
  );
  legacyServer.close();

  assert.equal(code2, 0, fallbackErrors.join('\n'));
  const parsedList = JSON.parse(fallbackOutputs[0]);
  assert.equal(parsedList.sessions.length, 1);
  assert.equal(parsedList.sessions[0].sessionId, fallbackId);
  assert.equal(parsedList.sessions[0].title, '本地直连会话');
});

test('Antigravity -> Claude Code keeps ClaudeRuntime alive via session-daemon across separate start and wait CLI calls', async t => {
  assert.equal(detectDefaultActorName({ANTIGRAVITY_CONVERSATION_ID: '0d47a0ee'}), 'Antigravity');
  assert.equal(detectDefaultActorName({CLAUDECODE: '1'}), 'Claude Code');
  assert.equal(detectDefaultActorName({CODEX_THREAD_ID: 't1'}), 'Codex');

  const root = await mkdtemp(join(tmpdir(), 'cmw-ag-to-claude-'));
  const home = join(root, 'home');
  const projectDir = join(home, 'Projects', 'backend-service');
  const claudeDir = join(home, '.claude');
  await mkdir(projectDir, {recursive: true});
  await mkdir(join(claudeDir, 'projects', 'backend-service'), {recursive: true});

  const claudeSessionId = '33333333-4444-4555-8666-777777777777';
  const transcriptPath = join(claudeDir, 'projects', 'backend-service', `${claudeSessionId}.jsonl`);
  const prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  let finishTurn!: () => void;
  const turnGate = new Promise<void>(resolveGate => { finishTurn = resolveGate; });

  const query: QueryFn = ({prompt, options}) => {
    assert.equal(options?.permissionMode, 'bypassPermissions');
    async function* run(): AsyncGenerator<any> {
      yield {type: 'system', subtype: 'init', session_id: claudeSessionId};
      for await (const msg of prompt) {
        const promptText = Array.isArray(msg.message.content)
          ? msg.message.content.map((c: any) => c.text || '').join('')
          : String(msg.message.content || '');
        const baseEntry = {
          sessionId: claudeSessionId,
          cwd: projectDir,
          version: '2.1.0',
          gitBranch: 'main',
          userType: 'external',
          isSidechain: false,
        };
        await writeFile(transcriptPath, JSON.stringify({
          ...baseEntry,
          type: 'user',
          uuid: '00000000-0000-4000-8000-000000000001',
          parentUuid: null,
          timestamp: '2026-11-27T07:00:00.000Z',
          message: {role: 'user', content: promptText},
        }) + '\n');
        await turnGate;
        await appendFile(transcriptPath, JSON.stringify({
          ...baseEntry,
          type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000002',
          parentUuid: '00000000-0000-4000-8000-000000000001',
          timestamp: '2026-11-27T07:00:01.000Z',
          message: {id: 'msg-ag-1', role: 'assistant', content: [{type: 'text', text: 'Claude Code 已完成接口实现与回归测试。'}]},
        }) + '\n');
        yield {type: 'result', subtype: 'success', session_id: claudeSessionId, errors: []};
      }
    }
    const gen = run() as any;
    gen.close = () => {};
    gen.interrupt = async () => {};
    return gen;
  };

  const env = {
    ANTIGRAVITY_CONVERSATION_ID: '0d47a0ee-0975-44b0-be86-ca32c1fb724a',
    CLAUDE_CONFIG_DIR: claudeDir,
    CMW_ANTIGRAVITY_HOME: join(home, '.gemini', 'antigravity'),
  };
  const daemon = await startInProcessSessionDaemon({
    homeDir: home,
    env,
    idleTimeoutMs: 60_000,
    queryLoader: async () => query,
  });
  t.after(async () => {
    daemon.close();
    if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig;
    await removeTestTemp(root);
  });

  // Step 1: Antigravity runs foreground `cmw-session start --to claude` -> returns immediately while turn is still running!
  const startOut: string[] = [];
  const startErr: string[] = [];
  const startCode = await runSessionCli(
    ['start', '--to', 'claude', '--cwd', projectDir, '--stdin'],
    {
      homeDir: home,
      env,
      spawnDaemon: false,
      stdinText: async () => '实现 /api/health 接口并补齐单元测试',
      stdout: text => startOut.push(text),
      stderr: text => startErr.push(text),
    },
  );
  assert.equal(startCode, 0, startErr.join('\n'));
  assert.match(startOut[0], /\[SESSION STARTED\]/);
  assert.match(startOut[0], /service: claude/);
  assert.match(startOut[0], new RegExp(`session_id: ${claudeSessionId}`));
  assert.match(startOut[0], /phase: running/);
  assert.match(startOut[0], /autonomy: turbo/);

  // Step 2: Antigravity runs background `cmw-session wait <id> --to claude --after-send` -> wakes up when Claude completes!
  const waitOut: string[] = [];
  const waitErr: string[] = [];
  const waitPromise = runSessionCli(
    ['wait', claudeSessionId, '--to', 'claude', '--after-send', '--timeout', '10'],
    {
      homeDir: home,
      env,
      spawnDaemon: false,
      stdout: text => waitOut.push(text),
      stderr: text => waitErr.push(text),
    },
  );

  setTimeout(() => finishTurn(), 80);
  const waitCode = await waitPromise;
  assert.equal(waitCode, 0, waitErr.join('\n'));
  assert.match(waitOut[0], /\[SESSION WAIT: COMPLETED\]/);
  assert.match(waitOut[0], /Claude Code 已完成接口实现与回归测试。/);

  // Step 3: Verify sender was recorded as "Antigravity", then stop daemon cleanly.
  const stopCode = await runSessionCli(['daemon-stop'], {homeDir: home, env});
  assert.equal(stopCode, 0);
  await new Promise(resolveWait => setTimeout(resolveWait, 30));
  assert.equal(await readLocalControl(globalControlDir(home), SESSION_DAEMON_FILE), null);

  const checkLedger = new Ledger(join(globalControlDir(home), 'cli-operations.sqlite'));
  try {
    const senders = checkLedger.senders('claude', claudeSessionId);
    assert.equal(senders[0]?.sender.name, 'Antigravity');
  } finally {
    checkLedger.close();
  }
});

test('subdirectory invocations align to parent project or Git root without leaking across nested Git repos', {timeout: 8000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cmw-align-'));
  const home = join(root, 'home');
  const safety = {home, dataDir: join(root, 'data')};

  // 1. Subfolder inside an unregistered Git repo snaps to the Git root
  const gitRepo = join(home, 'Projects', 'mono-repo');
  const subPkg = join(gitRepo, 'packages', 'web', 'src');
  await mkdir(join(gitRepo, '.git'), {recursive: true});
  await mkdir(subPkg, {recursive: true});

  const gitAligned = await resolveAlignedProjectCwd(subPkg, {safety});
  assert.equal(gitAligned.cwd.toLowerCase(), gitRepo.toLowerCase());
  assert.equal(gitAligned.alignedFrom?.toLowerCase(), subPkg.toLowerCase());

  // `--exact-cwd` keeps the exact subfolder
  const exact = await resolveAlignedProjectCwd(subPkg, {exactCwd: true, safety});
  assert.equal(exact.cwd.toLowerCase(), subPkg.toLowerCase());
  assert.equal(exact.alignedFrom, undefined);

  // 2. Nested independent Git repo inside a registered catch-all parent NEVER leaks out to the catch-all parent
  const outerWorkspace = join(home, 'Projects', 'workspace');
  const nestedRepo = join(outerWorkspace, 'service-a');
  const nestedSub = join(nestedRepo, 'cmd');
  await mkdir(join(nestedRepo, '.git'), {recursive: true});
  await mkdir(nestedSub, {recursive: true});

  const nestedAligned = await resolveAlignedProjectCwd(nestedSub, {
    safety,
    targetProjectPaths: [outerWorkspace],
    callerProjectRoots: [outerWorkspace],
  });
  assert.equal(nestedAligned.cwd.toLowerCase(), nestedRepo.toLowerCase());

  // 3. End-to-end: Antigravity parent project (non-git) delegates from `plain-app/frontend` -> Claude Code & Antigravity both land in `plain-app`
  const agDir = join(home, '.gemini', 'antigravity');
  const projectsDir = join(home, '.gemini', 'config', 'projects');
  const plainApp = join(home, 'Projects', 'plain-app');
  const plainSub = join(plainApp, 'frontend');
  await mkdir(agDir, {recursive: true});
  await mkdir(projectsDir, {recursive: true});
  await mkdir(plainSub, {recursive: true});

  const parentAgProjectId = '6785bd6f-b28e-41b4-b49e-406a67f3bac6';
  await writeFile(join(projectsDir, `${parentAgProjectId}.json`), JSON.stringify({
    id: parentAgProjectId,
    name: 'plain-app',
    projectResources: {resources: [{folderUri: toAntigravityFileUri(plainApp)}]},
  }));

  const agDb = new DatabaseSync(join(agDir, 'conversation_summaries.db'));
  agDb.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const existingAgConv = randomUUID();
  agDb.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)').run(
    existingAgConv, '父项目对话', 'CASCADE_RUN_STATUS_IDLE', '2026-11-27T08:00:00.000Z', 2, 1, 'u1', 0, JSON.stringify([toAntigravityFileUri(plainApp)]),
  );

  const ledger = new Ledger(':memory:');
  const startCascadePayloads: Json[] = [];
  const agBridge = new AntigravityBridge(
    agDir,
    ledger,
    async (_dir, method, body) => {
      if (method === 'StartCascade') {
        startCascadePayloads.push(body);
        return {cascadeId: randomUUID()};
      }
      if (method === 'GetCascadeModelConfigData') {
        return {clientModelConfigs: [{label: 'Pro', modelOrAlias: {model: 'M'}}], defaultOverrideModelConfig: {modelOrAlias: {model: 'M'}}};
      }
      return {};
    },
    projectsDir,
    {queueIntervalMs: 60_000},
  );
  t.after(async () => {
    agBridge.close();
    agDb.close();
    ledger.close();
    await removeTestTemp(root);
  });

  const hub = new SessionHub([new AntigravitySessionDriver(agBridge, safety)]);

  // Starting from subfolder `plain-app/frontend` aligns to `plain-app` and reuses `parentAgProjectId`!
  const startedFromSub = await hub.handle('agent.session.start', {
    service: 'antigravity',
    cwd: plainSub,
    callerProjectId: parentAgProjectId,
    prompt: '在前端子目录发起但归属父项目',
  });
  assert.equal(startedFromSub.cwd.toLowerCase(), plainApp.toLowerCase());
  assert.equal(startedFromSub.alignedFrom?.toLowerCase(), plainSub.toLowerCase());
  assert.equal(startedFromSub.projectCreated, undefined);
  assert.equal(startCascadePayloads[0]?.projectEnvConfig?.projectId, parentAgProjectId);

  // Listing from subfolder `plain-app/frontend` also finds parent `plain-app` conversations!
  const listedFromSub = await hub.handle('agent.session.list', {
    service: 'antigravity',
    cwd: plainSub,
  });
  assert.ok(listedFromSub.sessions.some((s: Json) => s.sessionId === existingAgConv));
});
