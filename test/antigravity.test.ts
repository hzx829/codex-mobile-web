import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AntigravityErrorNotice,AntigravityMessages,antigravityIssueText,groupAntigravityMessages} from '../web/antigravity-messages.js';
import type {AntigravityIssue,AntigravityMessage} from '../src/shared/types.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, appendFile, rm, writeFile, readFile} from 'node:fs/promises';
import {uploadAttachments} from '../web/file-upload.js';
import {fileReference} from '../web/preview-target.js';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {AntigravityBridge,parseAntigravityModels,extractAntigravityRequests,extractAntigravityBackgroundTasks,extractAntigravityIssue} from '../src/connector/antigravity.js';
import {BackgroundTasksBar,BackgroundTasksPanel} from '../web/antigravity.js';
import {QueuedMessages} from '../web/queued-messages.js';
import {antigravityModelSupportsImages,antigravityPickerModels,concreteAntigravityModel,splitAntigravityModel} from '../web/antigravity-model-picker.js';
import {Ledger} from '../src/connector/ledger.js';
import {BridgeError} from '../src/shared/types.js';
import {home, parseLocation} from '../web/route-state.js';
import {serviceOf, switchRoute} from '../web/service-switch.js';

test('app switches restore each machine and app independently, and retired apps return to Codex', () => {
  const memory = new Map<string,string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: {
    setItem: (k:string,v:string) => memory.set(k,v), getItem: (k:string) => memory.get(k) ?? null,
  }});
  try {
    const id = randomUUID(), codex = {...home, thread:'native-thread', project:'D:/work'};
    const ag = {...home, project:'file:///D:/work', antigravity:id}, other = {...home, project:'D:/work', claude:id};
    assert.deepEqual(switchRoute('pc', codex, 'antigravity'), {...home, antigravity:''});
    assert.deepEqual(switchRoute('pc', ag, 'claude'), {...home, claude:''});
    assert.deepEqual(switchRoute('pc', other, 'antigravity'), ag);
    assert.deepEqual(switchRoute('pc', ag, 'codex'), codex);
    assert.deepEqual(switchRoute('other', home, 'antigravity'), {...home, antigravity:''});
    for (const route of [ag, other, codex]) assert.deepEqual(parseLocation({cmwRoute:route,cmwMachine:'pc'})?.route,route);
    assert.equal(serviceOf(other),'claude');
    assert.deepEqual(parseLocation({cmwRoute:{...home,chat:id},cmwMachine:'pc'}),{route:home,machine:'pc'});
    const claude = {...home, claude:id, project:'D:/work'};
    assert.deepEqual(parseLocation({cmwRoute:claude,cmwMachine:'pc'}),{route:claude,machine:'pc'}, 'Claude Code is back and keeps its project');
    assert.equal(parseLocation({cmwRoute:{...other,antigravity:id},cmwMachine:'pc'}),null);
    assert.equal(parseLocation({cmwRoute:{...home,antigravity:'../bad'},cmwMachine:'pc'}),null);
  } finally {
    if (original) Object.defineProperty(globalThis,'sessionStorage',original);
    else Reflect.deleteProperty(globalThis,'sessionStorage');
  }
});

test('consecutive Antigravity tools share a Codex activity group without swallowing replies or crossing user turns', () => {
  const messages: AntigravityMessage[] = [
    {id:'1',role:'tool',text:'read_file、run_command'}, {id:'2',role:'tool',text:'read_file'},
    {id:'3',role:'assistant',text:'**完成**'}, {id:'4',role:'tool',text:'edit_file'},
    {id:'5',role:'user',text:'继续'}, {id:'6',role:'tool',text:'search'},
  ];
  const groups=groupAntigravityMessages(messages);
  assert.deepEqual(groups.map(group=>group.length),[3,1,1,1,1]);
  assert.deepEqual(groups[0].map(item=>item.text),['read_file','run_command','read_file']);
  const html=renderToStaticMarkup(createElement(AntigravityMessages,{messages,running:true,openFile:()=>{},openPreview:()=>{},onFollowup:()=>{}}));
  assert.equal(html.match(/class="activity-group"/g)?.length,3);
  assert.match(html,/运行记录 · 3 项/);assert.match(html,/正在处理 · 1 项/);assert.match(html,/<strong>完成<\/strong>/);
  assert.doesNotMatch(html,/read_file|class="activity-list"/);
});

test('desktop transcripts, watch updates and write receipts stay with the selected Antigravity conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(),'cmw-antigravity-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir,'conversation_summaries.db'));
  t.after(async()=>{db.close();ledger.close();await rm(dir,{recursive:true,force:true});});
  const id = randomUUID(), logs = join(dir,'brain',id,'.system_generated','logs');
  await mkdir(logs,{recursive:true});
  const transcript = join(logs,'transcript.jsonl');
  const line = (step:object) => JSON.stringify(step)+'\n';
  await writeFile(transcript,line({type:'USER_INPUT',step_index:1,content:'<USER_REQUEST>hello</USER_REQUEST>\n<ADDITIONAL_METADATA>private</ADDITIONAL_METADATA>'})+
    line({type:'PLANNER_RESPONSE',step_index:2,thinking:'private',tool_calls:[{name:'read_file',args:{private:true}}]}));
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const insert=db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)');
  const older='2026-11-17T02:00:00.000Z',project=pathToFileURL(dir).href;
  insert.run(id,'Example','CASCADE_RUN_STATUS_IDLE',older,2,1,'before',0,JSON.stringify([project]));
  const models = [
    {label:'Model High',modelOrAlias:{model:'MODEL_HIGH'}},
    {label:'Retired',modelOrAlias:{model:'MODEL_RETIRED'},disabled:true},
  ];
  let advanceTurn=false;
  const config={plannerConfig:{planModel:'MODEL_PREVIOUS',toolConfig:{custom:true}},executorConfig:{setting:1}};
  const writes:unknown[]=[];
  const bridge = new AntigravityBridge(dir,ledger,async (_dir,method,body)=>{
    if(method==='GetCascadeModelConfigData')return {clientModelConfigs:models};
    if(method==='GetPermissionSettings'||method==='GetAllCascadeTrajectories'||method==='GetCascadeTrajectorySteps')return {};
    if(method==='GetTrajectoryTurns'){
      assert.deepEqual(body,{cascadeId:id,stepIndices:[1]});
      if(advanceTurn)db.exec("UPDATE conversation_summaries SET last_user_input_time='changed'");
      return {turns:[{startStepIndex:1,firstStep:{userInput:{userConfig:config}}}]};
    }
    writes.push({method,body});
    if(method==='CancelCascadeInvocation')throw new BridgeError('uncertain','lost response',true);
    return {};
  });
  const listed=await bridge.handle('antigravity.list',{});
  assert.deepEqual(listed.data,[{id,title:'Example',running:false,updatedAt:Date.parse(older)}]);
  assert.deepEqual(listed.projects,[{id:project,path:dir}]);
  assert.deepEqual((await bridge.handle('antigravity.list',{project:'file:///other',search:'exam'})).data,[]);
  assert.deepEqual((await bridge.handle('antigravity.list',{project,search:'no match'})).data,[]);
  const updated='2026-11-18T02:00:00.000Z';
  for(let i=0;i<50;i++)insert.run(randomUUID(),'Other conversation','CASCADE_RUN_STATUS_RUNNING',updated,2,1,'before',0,JSON.stringify([project]));
  const firstPage=await bridge.handle('antigravity.list',{project});
  assert.equal(firstPage.hasMore,true);
  assert.equal(firstPage.data.length,50);
  assert.ok(firstPage.data.every((item:{id:string;running:boolean;updatedAt:number})=>item.id!==id&&item.running&&item.updatedAt===Date.parse(updated)));
  assert.equal((await bridge.handle('antigravity.list',{project,offset:50})).data[0].id,id);
  assert.equal((await bridge.handle('antigravity.list',{project,search:'exam'})).data[0].id,id);
  await writeFile(join(dir,'示例.pdf'),'%PDF-1.7');
  const pdf=await bridge.handle('antigravity.file.read',{conversationId:id,path:'示例.pdf'});
  assert.equal(pdf.mime,'application/pdf');
  const download={conversationId:id,path:pdf.path,revision:pdf.revision,offset:0};
  const chunk=await bridge.handle('antigravity.file.download',download);
  assert.equal(Buffer.from(chunk.data,'base64').toString(),'%PDF-1.7');
  await assert.rejects(bridge.handle('antigravity.file.read',{conversationId:randomUUID(),path:pdf.path}),/找不到/);
  await assert.rejects(bridge.handle('antigravity.file.read',{conversationId:id,path:'//server/share'}),/本机文件/);
  await writeFile(pdf.path,'updated');
  await assert.rejects(bridge.handle('antigravity.file.download',download),/文件已变化/);
  const view = await bridge.handle('antigravity.read',{conversationId:id});
  assert.equal(view.cwd,dir);
  assert.deepEqual(view.messages,[{id:'1',role:'user',text:'hello'},{id:'2-tools',role:'tool',text:'read_file'}]);
  await appendFile(transcript,line({type:'PLANNER_RESPONSE',step_index:3,content:'done'}));
  const delta = await bridge.handle('antigravity.watch',{conversationId:id,revision:view.revision});
  assert.equal(delta.base,view.revision);
  assert.equal(delta.keep,2);
  assert.deepEqual(delta.messages,[{id:'3',role:'assistant',text:'done'}]);
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING'");
  await appendFile(transcript,line({type:'ERROR_MESSAGE',step_index:4,error:'API error (attempt 2): request failed: unexpected EOF',content:'private endpoint'}));
  const retry = await bridge.handle('antigravity.watch',{conversationId:id,revision:delta.revision});
  assert.equal(retry.base,delta.revision);
  assert.equal(retry.keep,3);
  assert.deepEqual(retry.messages,[]);
  assert.deepEqual(retry.issue,{kind:'retry',attempt:2,connection:true} as const);
  assert.match(antigravityIssueText(retry.issue,retry.canSend),/正在重连（第 2 次请求失败）/);
  assert.doesNotMatch(JSON.stringify(retry),/private endpoint|unexpected EOF/);
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE'");
  const ended = await bridge.handle('antigravity.watch',{conversationId:id,revision:retry.revision});
  assert.match(antigravityIssueText(ended.issue,ended.canSend),/本轮已结束/);
  await appendFile(transcript,line({type:'ERROR_MESSAGE',step_index:5,error:'The stream was interrupted. Please continue the task you were working on.'}));
  const failed = await bridge.handle('antigravity.watch',{conversationId:id,revision:ended.revision});
  assert.deepEqual(failed.issue,{kind:'interrupted'});
  await appendFile(transcript,line({type:'USER_INPUT',step_index:1,content:'hello'}));
  const resumed = await bridge.handle('antigravity.watch',{conversationId:id,revision:failed.revision});
  assert.equal(resumed.issue,null);
  assert.deepEqual(resumed.messages,[]);
  const makeOp = () => `${Date.now()}:${randomUUID()}`;
  const payload = {opId:makeOp(),conversationId:id,text:'next',turn:view.turn};
  const results = await Promise.all([bridge.handle('antigravity.send',payload),bridge.handle('antigravity.send',payload)]);
  assert.ok(results.every(r=>r.state==='accepted'));
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0],{method:'SendUserCascadeMessage',body:{cascadeId:id,items:[{text:'next'}],clientMessageId:payload.opId.split(':')[1],cascadeConfig:config}});
  assert.deepEqual(await bridge.handle('antigravity.models',{conversationId:id}),{models:[{id:'MODEL_HIGH',label:'Model High'}],current:'MODEL_PREVIOUS',supportsImages:true});
  const selected={...payload,model:'MODEL_HIGH',opId:makeOp()};
  assert.equal((await bridge.handle('antigravity.send',selected)).state,'accepted');
  assert.equal((await bridge.handle('antigravity.send',selected)).state,'accepted');
  assert.deepEqual(writes[1],{method:'SendUserCascadeMessage',body:{cascadeId:id,items:[{text:'next'}],clientMessageId:selected.opId.split(':')[1],
    cascadeConfig:{...config,plannerConfig:{...config.plannerConfig,planModel:'MODEL_HIGH'}}}});
  // Phone images travel as the desktop's inline `media` items.
  const png='data:image/png;base64,iVBORw0KGgo=',jpeg='data:image/jpeg;base64,/9j/4AA=';
  const pictured={...payload,opId:makeOp(),images:[png,jpeg]};
  assert.equal((await bridge.handle('antigravity.send',pictured)).state,'accepted');
  assert.deepEqual(writes[2],{method:'SendUserCascadeMessage',body:{cascadeId:id,items:[{text:'next'}],
    media:[{mimeType:'image/png',inlineData:'iVBORw0KGgo='},{mimeType:'image/jpeg',inlineData:'/9j/4AA='}],clientMessageId:pictured.opId.split(':')[1],cascadeConfig:config}});
  await assert.rejects(bridge.handle('antigravity.send',{...pictured,images:[jpeg]}),(error:BridgeError)=>error.code==='conflict');
  await assert.rejects(bridge.handle('antigravity.send',{...payload,opId:makeOp(),images:['data:image/gif;base64,R0lGOD==']}),(error:BridgeError)=>error.code==='invalid');
  await assert.rejects(bridge.handle('antigravity.send',{...selected,model:'MODEL_RETIRED'}),(error:BridgeError)=>error.code==='conflict');
  for(const model of ['MODEL_RETIRED','MODEL_UNKNOWN'])assert.equal((await bridge.handle('antigravity.send',{...payload,opId:makeOp(),model})).state,'failed');
  advanceTurn=true;
  assert.equal((await bridge.handle('antigravity.send',{...selected,opId:makeOp()})).state,'failed');
  assert.equal(writes.length,3);
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING',last_user_input_step_index=4");
  assert.equal((await bridge.handle('antigravity.stop',{...payload,opId:makeOp()})).state,'failed');
  const stop = {...payload,turn:(await bridge.handle('antigravity.read',{conversationId:id})).turn,opId:makeOp()};
  assert.equal((await bridge.handle('antigravity.stop',stop)).state,'uncertain');
  assert.equal((await bridge.handle('antigravity.stop',stop)).state,'uncertain');
  assert.equal((await bridge.handle('antigravity.operation',stop)).state,'uncertain');
  assert.equal(writes.length,4);
  await assert.rejects(bridge.handle('antigravity.read',{conversationId:'../outside'}),/ID 无效/);
});

test('Antigravity reads the untruncated transcript and starts new conversations under their desktop project', async t => {
  const dir = await mkdtemp(join(tmpdir(),'cmw-antigravity-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir,'conversation_summaries.db'));
  t.after(async()=>{db.close();ledger.close();await rm(dir,{recursive:true,force:true});});
  const id = randomUUID(), logs = join(dir,'brain',id,'.system_generated','logs'), projects = join(dir,'projects');
  await mkdir(logs,{recursive:true});await mkdir(projects);
  const line = (step:object) => JSON.stringify(step)+'\n', long = '长'.repeat(5000);
  await writeFile(join(logs,'transcript.jsonl'),line({type:'PLANNER_RESPONSE',step_index:1,content:'cut <truncated 10482 bytes>',truncated_fields:['content']}));
  await writeFile(join(logs,'transcript_full.jsonl'),line({type:'PLANNER_RESPONSE',step_index:1,content:long}));
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const project = pathToFileURL(dir).href, insert = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)');
  const other = randomUUID();
  insert.run(other,'Elsewhere','CASCADE_RUN_STATUS_IDLE','2026-11-19T00:00:00.000Z',2,0,'t',0,JSON.stringify(['file:///elsewhere']));
  insert.run(id,'Here','CASCADE_RUN_STATUS_IDLE','2026-11-18T00:00:00.000Z',2,-1,'t',0,JSON.stringify([project]));
  await writeFile(join(projects,'p.json'),JSON.stringify({id:'project-1',name:'工作区',projectResources:{resources:[{gitFolder:{folderUri:project+'/'}}]}}));
  const config = {plannerConfig:{planModel:'MODEL_A',modelName:'old',tools:['read_file']}};
  const created = randomUUID(), writes:{method:string;body:any}[] = [];
  let failSend:BridgeError|null = null;
  const bridge = new AntigravityBridge(dir,ledger,async (_dir,method,body)=>{
    if(method==='GetCascadeModelConfigData')return {clientModelConfigs:[{label:'B',modelOrAlias:{model:'MODEL_B'}}]};
    if(method==='GetPermissionSettings'||method==='GetAllCascadeTrajectories'||method==='GetCascadeTrajectorySteps')return {};
    if(method==='GetTrajectoryTurns'){
      // The conversation in the same project is preferred, and its user step of -1 is read as the first step.
      assert.deepEqual(body,{cascadeId:id,stepIndices:[0]});
      return {turns:[{firstStep:{userInput:{userConfig:config}}}]};
    }
    writes.push({method,body});
    if(method==='StartCascade')return {cascadeId:created};
    if(method==='SendUserCascadeMessage'&&failSend)throw failSend;
    return {};
  },projects);
  const view = await bridge.handle('antigravity.read',{conversationId:id});
  assert.deepEqual(view.messages,[{id:'1',role:'assistant',text:long}]);
  assert.deepEqual((await bridge.handle('antigravity.list',{})).projects.find((item:{id:string})=>item.id===project),{id:project,path:dir,name:'工作区'});
  assert.deepEqual(await bridge.handle('antigravity.models',{project}),{models:[{id:'MODEL_B',label:'B'}],current:'MODEL_A',supportsImages:true});
  const makeOp = () => `${Date.now()}:${randomUUID()}`, op = makeOp();
  const result = await bridge.handle('antigravity.create',{project,text:'开始',opId:op,model:'MODEL_B'});
  assert.deepEqual(result,{state:'accepted',conversationId:created,submitted:true});
  assert.deepEqual(writes,[
    {method:'StartCascade',body:{workspaceUris:[project],source:'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',trajectoryType:'CORTEX_TRAJECTORY_TYPE_CASCADE',projectEnvConfig:{projectId:'project-1'}}},
    {method:'SendUserCascadeMessage',body:{cascadeId:created,items:[{text:'开始'}],clientMessageId:op.split(':')[1],cascadeConfig:{plannerConfig:{planModel:'MODEL_B',tools:['read_file']}}}},
  ]);
  assert.equal((await bridge.handle('antigravity.create',{project,text:'开始',opId:op,model:'MODEL_B'})).conversationId,created);
  assert.equal(writes.length,2,'a repeated operation is not sent again');
  failSend = new BridgeError('unavailable','down');
  assert.equal((await bridge.handle('antigravity.create',{project,text:'again',opId:makeOp()})).state,'failed');
  assert.deepEqual(writes.at(-1),{method:'DeleteCascadeTrajectory',body:{cascadeId:created}},'an empty conversation is removed when its message certainly failed');
  failSend = new BridgeError('uncertain','lost',true);
  assert.deepEqual(await bridge.handle('antigravity.create',{project,text:'again',opId:makeOp()}),{state:'accepted',conversationId:created,submitted:false,uncertain:true});
  assert.notEqual(writes.at(-1)!.method,'DeleteCascadeTrajectory');
  await assert.rejects(bridge.handle('antigravity.create',{project:'https://example.com/x',text:'x',opId:makeOp()}),/这台电脑上的项目/);
  // Documents are uploaded into the project first and the message links to them, so typed text may be empty.
  failSend = null;
  const call = (action:any,payload:any) => bridge.handle(action,payload);
  const doc = () => ({id:randomUUID(),name:'需求.docx',size:4,file:new File([Buffer.from('word')],'需求.docx')});
  const lastText = ():string => (writes[writes.length-1] as {body:any}).body.items[0].text;
  const linked = (text:string) => [...text.matchAll(/\]\(<([^>]+)>\)/g)].map(match=>fileReference(match[1]).path);
  const newFiles = await uploadAttachments(call,{prefix:'antigravity.',scope:{project}},[doc()]);
  assert.equal((await bridge.handle('antigravity.create',{project,text:'',files:newFiles,opId:makeOp()})).state,'accepted');
  const firstLinks = linked(lastText());
  const turn = view.turn!;
  assert.equal(firstLinks.length,1);
  assert.equal(await readFile(firstLinks[0],'utf8'),'word');
  await assert.rejects(bridge.handle('antigravity.create',{project,text:'',opId:makeOp()}),/消息无效/,'without files the message is still required');
  // Files belong to the conversation (or new project) they were uploaded for.
  const elsewhere = await bridge.handle('antigravity.send',{conversationId:id,turn,text:'x',files:newFiles,opId:makeOp()});
  assert.equal(elsewhere.state,'failed');
  assert.match(elsewhere.error!.message,/当前会话/);
  const own = await uploadAttachments(call,{prefix:'antigravity.',scope:{conversationId:id}},[doc()]);
  assert.equal((await bridge.handle('antigravity.send',{conversationId:id,turn,text:'看附件',files:own,opId:makeOp()})).state,'accepted');
  const sent = lastText();
  assert.match(sent,/^看附件\n\n附件/);
  assert.equal(await readFile(linked(sent)[0],'utf8'),'word');
});

test('Antigravity groups models by thinking effort and maps concrete IDs and image support', () => {
  const parsed = parseAntigravityModels({
    defaultOverrideModelConfig: {modelOrAlias: {model: 'MODEL_NEON_HIGH'}},
    clientModelSorts: [{name: 'Recommended', groups: [{modelLabels: [
      'Gemini 4 Neon (High)', 'Gemini 4 Neon (Medium)', 'Gemini 4 Neon (Low)',
      'Orchestrator (Neon)', 'GPT-OSS 120B (Medium)', 'Gemini 4 Carbon',
    ]}]}],
    groupedModels: {
      'gemini-4-neon': {
        displayName: 'Gemini 4 Neon',
        supportedThinkingLevels: [
          {thinkingSuffix: 'low', thinkingDisplayName: 'Low'},
          {thinkingSuffix: 'medium', thinkingDisplayName: 'Medium'},
          {thinkingSuffix: 'high', thinkingDisplayName: 'High'},
          {thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra High'},
        ],
      },
    },
    clientModelConfigs: [
      {label: 'GPT-OSS 120B (Medium)', modelOrAlias: {model: 'MODEL_GPT_OSS'}, modelId: 'gpt-oss-120b-medium', tagDescription: 'Notice'},
      {label: 'Gemini 4 Neon (Low)', modelOrAlias: {model: 'MODEL_NEON_LOW'}, modelId: 'gemini-4-neon-low', supportsImages: true},
      {label: 'Gemini 4 Neon (High)', modelOrAlias: {model: 'MODEL_NEON_HIGH'}, modelId: 'gemini-4-neon-high', supportsImages: true, tagDescription: 'Deep reasoning'},
      {label: 'Gemini 4 Neon (Medium)', modelOrAlias: {model: 'MODEL_NEON_MED'}, modelId: 'gemini-4-neon-medium', supportsImages: true},
      {label: 'Orchestrator (Neon)', modelOrAlias: {model: 'MODEL_ORCH'}, modelId: 'gemini-pro-orchestrator-neon', supportsImages: true},
      {label: 'Gemini 4 Carbon', modelOrAlias: {model: 'MODEL_CARBON'}, modelId: 'gemini-4-carbon', disabled: true, supportsImages: true},
    ],
  });
  assert.equal(parsed.defaultModel, 'MODEL_NEON_HIGH');
  assert.deepEqual(parsed.groups?.map(g => g.id), ['gemini-4-neon', 'MODEL_ORCH', 'MODEL_GPT_OSS']);
  assert.deepEqual(parsed.groups?.[0], {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    description: 'Deep reasoning',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    variants: {low: 'MODEL_NEON_LOW', medium: 'MODEL_NEON_MED', high: 'MODEL_NEON_HIGH'},
    supportsImages: true,
  });
  const catalog = {...parsed, current: 'MODEL_NEON_MED', supportsImages: true};
  assert.equal(antigravityPickerModels(catalog).length, 3);
  assert.deepEqual(splitAntigravityModel(catalog, 'MODEL_NEON_HIGH'), {model: 'gemini-4-neon', effort: 'high'});
  assert.deepEqual(splitAntigravityModel(catalog, 'MODEL_ORCH'), {model: 'MODEL_ORCH', effort: ''});
  assert.equal(concreteAntigravityModel(catalog, {model: 'gemini-4-neon', effort: 'low'}), 'MODEL_NEON_LOW');
  assert.equal(concreteAntigravityModel(catalog, {model: 'MODEL_ORCH', effort: 'high'}), 'MODEL_ORCH');
  assert.equal(antigravityModelSupportsImages(catalog, 'MODEL_NEON_HIGH'), true);
  assert.equal(antigravityModelSupportsImages(catalog, 'MODEL_GPT_OSS'), false);
});

test('Antigravity syncs permission presets and responds to waiting approval and question steps', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-antigravity-perm-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  t.after(async () => { db.close(); ledger.close(); await rm(dir, {recursive: true, force: true}); });
  const id = randomUUID(), trajectoryId = randomUUID(), created = randomUUID();
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const project = pathToFileURL(dir).href;
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'Perm Test', 'CASCADE_RUN_STATUS_IDLE', '2026-11-23T00:00:00.000Z', 5, 0, 't0', 0, JSON.stringify([project]));
  const writes: {method: string; body: any}[] = [];
  let waitingSteps: any[] = [];
  const config = {plannerConfig: {planModel: 'MODEL_A', toolConfig: {runCommand: {autoCommandConfig: {autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER'}}}}};
  const bridge = new AntigravityBridge(dir, ledger, async (_dir, method, body) => {
    if (method === 'GetPermissionSettings') return {globalPreset: 'AGENT_PERMISSION_PRESET_TURBO'};
    if (method === 'GetAllCascadeTrajectories') return {trajectorySummaries: {[id]: {trajectoryId, annotations: {permissionPreset: 'AGENT_PERMISSION_PRESET_AUTO'}}}};
    if (method === 'GetCascadeTrajectorySteps') return {steps: waitingSteps};
    if (method === 'GetCascadeModelConfigData') return {clientModelConfigs: [{label: 'A', modelOrAlias: {model: 'MODEL_A'}}]};
    if (method === 'GetTrajectoryTurns') return {turns: [{startStepIndex: 0, firstStep: {userInput: {userConfig: config}}}]};
    writes.push({method, body});
    if (method === 'StartCascade') return {cascadeId: created};
    return {};
  });
  const list = await bridge.handle('antigravity.list', {});
  assert.equal(list.defaultPermissionMode, 'AGENT_PERMISSION_PRESET_TURBO');
  const read = await bridge.handle('antigravity.read', {conversationId: id});
  assert.equal(read.permissionMode, 'AGENT_PERMISSION_PRESET_AUTO');
  assert.equal(read.defaultPermissionMode, 'AGENT_PERMISSION_PRESET_TURBO');
  // Switching to DEFAULT clears stale EAGER autoExecutionPolicy and updates conversation annotations.
  const makeOp = () => `${Date.now()}:${randomUUID()}`;
  assert.equal((await bridge.handle('antigravity.send', {conversationId: id, turn: read.turn, text: 'hi', permissionMode: 'AGENT_PERMISSION_PRESET_DEFAULT', opId: makeOp()})).state, 'accepted');
  assert.deepEqual(writes[0], {method: 'UpdateConversationAnnotations', body: {cascadeId: id, annotations: {permissionPreset: 'AGENT_PERMISSION_PRESET_DEFAULT'}, mergeAnnotations: true}});
  assert.equal(writes[1].method, 'SendUserCascadeMessage');
  assert.equal(writes[1].body.cascadeConfig.plannerConfig.toolConfig.runCommand.autoCommandConfig.autoExecutionPolicy, undefined);
  // Creating a conversation with REQUEST_REVIEW sets both annotation and OFF policy.
  assert.equal((await bridge.handle('antigravity.create', {project, text: 'start', permissionMode: 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW', opId: makeOp()})).state, 'accepted');
  assert.equal(writes[3].method, 'UpdateConversationAnnotations');
  assert.equal(writes[3].body.annotations.permissionPreset, 'AGENT_PERMISSION_PRESET_REQUEST_REVIEW');
  assert.equal(writes[4].body.cascadeConfig.plannerConfig.toolConfig.runCommand.autoCommandConfig.autoExecutionPolicy, 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF');
  await assert.rejects(bridge.handle('antigravity.send', {conversationId: id, turn: read.turn, text: 'bad', permissionMode: 'INVALID', opId: makeOp()}), /权限模式无效/);

  // Waiting steps appear as unified ApprovalRequest cards and map cleanly to HandleCascadeUserInteraction.
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING', not_fully_idle=1");
  waitingSteps = [
    {stepIndex: 3, status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction: {permission: {actionDescription: '运行测试命令', resource: {action: 'run_command', target: 'npm test'}, approvalScopeFilter: 'PERMISSION_SCOPE_WORKSPACE'}}},
    {stepIndex: 4, status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction: {askQuestion: {questions: [{question: '选择方案', isMultiSelect: false, options: [{id: 'opt1', text: '方案 A'}, {id: 'opt2', text: '方案 B'}]}]}}},
  ];
  const runningView = await bridge.handle('antigravity.read', {conversationId: id});
  assert.equal(runningView.requests.length, 2);
  assert.deepEqual(runningView.requests[0], {id: '3', kind: 'permission', tool: 'run_command', title: '运行测试命令', detail: 'npm test', canRemember: true, rememberScope: 'project'});
  assert.equal(runningView.requests[1].kind, 'question');
  assert.equal((await bridge.handle('antigravity.respond', {conversationId: id, requestId: '3', decision: 'allowSession', opId: makeOp()})).state, 'accepted');
  assert.deepEqual(writes.at(-1), {method: 'HandleCascadeUserInteraction', body: {cascadeId: id, interaction: {trajectoryId, stepIndex: 3, permission: {allow: true, scope: 'PERMISSION_SCOPE_WORKSPACE'}}}});
  assert.equal((await bridge.handle('antigravity.respond', {conversationId: id, requestId: '4', decision: 'allow', answers: {'选择方案': '方案 B'}, opId: makeOp()})).state, 'accepted');
  assert.equal(writes.at(-1)!.body.interaction.askQuestion.responses[0].selectedOptionIds[0], 'opt2');
  // An already-resolved step cannot be responded to again.
  waitingSteps = [{stepIndex: 3, status: 'CORTEX_STEP_STATUS_DONE', requestedInteraction: {}}];
  const stale = await bridge.handle('antigravity.respond', {conversationId: id, requestId: '3', decision: 'allow', opId: makeOp()});
  assert.equal(stale.state, 'failed');
  assert.match(stale.error!.message, /已处理|已过期/);
  // Unknown interaction branches render as a safe desktop-only notice card.
  const notices = extractAntigravityRequests([{stepIndex: 9, status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction: {futureCustom: {}}}], 0);
  assert.equal(notices[0].kind, 'notice');
});

test('Antigravity stays sendable and surfaces stoppable background tasks when idle with not_fully_idle=1', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-antigravity-bgtask-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  t.after(async () => { db.close(); ledger.close(); await rm(dir, {recursive: true, force: true}); });
  const id = randomUUID();
  const tasksDir = join(dir, 'brain', id, '.system_generated', 'tasks');
  const logsDir = join(dir, 'brain', id, '.system_generated', 'logs');
  await mkdir(tasksDir, {recursive: true});
  await mkdir(logsDir, {recursive: true});
  const taskLogPath = join(tasksDir, 'task-120.log');
  await writeFile(taskLogPath, 'line 1\nvenv: command not found\n');
  await writeFile(join(logsDir, 'transcript.jsonl'), JSON.stringify({type: 'PLANNER_RESPONSE', step_index: 284, content: '阶段一完成'}) + '\n');
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const project = pathToFileURL(dir).href;
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'Stuck Bg Task', 'CASCADE_RUN_STATUS_IDLE', '2026-11-23T11:55:13.000Z', 285, 83, 't83', 1, JSON.stringify([project]));

  const stepOffsets: number[] = [];
  const writes: {method: string; body: any}[] = [];
  const bgStep = {
    type: 'CORTEX_STEP_TYPE_GENERIC',
    status: 'CORTEX_STEP_STATUS_RUNNING',
    metadata: {startedAt: '2026-11-23T11:36:29.202Z', sourceTrajectoryStepInfo: {stepIndex: 120}},
    taskDetails: {
      id: `${id}/task-120`,
      logUri: pathToFileURL(taskLogPath).href,
      progress: 'line 1\n',
      description: 'wsl.exe bash -lc grep',
      title: 'Locate capture-service WSL virtualenv',
      movedToBackgroundAt: '2026-11-23T11:36:35.904Z',
    },
    generic: {
      result: {
        stepRenderInfo: {
          contentBlocks: [{terminal: {command: 'wsl.exe bash -lc grep', cwd: 'd:\\lingan', output: 'line 1\n'}}],
        },
      },
    },
  };
  let taskStillRunning = true;
  const bridge = new AntigravityBridge(dir, ledger, async (_dir, method, body) => {
    if (method === 'GetPermissionSettings' || method === 'GetAllCascadeTrajectories' || method === 'GetTrajectoryTurns' || method === 'GetCascadeModelConfigData') return {};
    if (method === 'GetCascadeTrajectorySteps') {
      stepOffsets.push(body.stepOffset);
      if (body.stepOffset <= 120 && taskStillRunning) return {steps: [bgStep]};
      return {steps: [{stepIndex: 284, status: 'CORTEX_STEP_STATUS_DONE'}]};
    }
    writes.push({method, body});
    return {};
  });

  // Reading an idle conversation with not_fully_idle=1 must stay sendable and discover the older background task at step 120.
  const view = await bridge.handle('antigravity.read', {conversationId: id});
  assert.equal(view.running, false);
  assert.equal(view.canSend, true);
  assert.equal(view.notIdle, true);
  assert.deepEqual(stepOffsets, [260, 120]);
  assert.equal(view.backgroundTasks.length, 1);
  assert.deepEqual(view.backgroundTasks[0], {
    id: `${id}/task-120`,
    stepIndex: 120,
    title: 'Locate capture-service WSL virtualenv',
    command: 'wsl.exe bash -lc grep',
    cwd: 'd:\\lingan',
    output: 'line 1\nvenv: command not found\n',
    startedAt: '2026-11-23T11:36:35.904Z',
  });

  // User is NOT deadlocked: sending a follow-up message succeeds even while background task runs.
  const makeOp = () => `${Date.now()}:${randomUUID()}`;
  assert.equal((await bridge.handle('antigravity.send', {conversationId: id, turn: view.turn, text: '继续', opId: makeOp()})).state, 'accepted');
  assert.equal(writes[0].method, 'SendUserCascadeMessage');

  // Normal stop (without killBackgroundTasks) refuses when the turn itself is idle, whereas killBackgroundTasks=true succeeds.
  assert.equal((await bridge.handle('antigravity.stop', {conversationId: id, turn: view.turn, opId: makeOp()})).state, 'failed');
  assert.equal((await bridge.handle('antigravity.stop', {conversationId: id, turn: view.turn, killBackgroundTasks: true, opId: makeOp()})).state, 'accepted');
  assert.deepEqual(writes[1], {method: 'CancelCascadeInvocation', body: {cascadeId: id, killBackgroundTasks: true}});

  // When the task ends and not_fully_idle clears, watch returns cleared backgroundTasks and notIdle=false.
  taskStillRunning = false;
  db.exec('UPDATE conversation_summaries SET not_fully_idle=0');
  const cleared = await bridge.handle('antigravity.watch', {conversationId: id, revision: view.revision});
  assert.equal(cleared.notIdle, false);
  assert.deepEqual(cleared.backgroundTasks, []);

  // Pure extractor ignores foreground synchronous steps while the conversation is running, but keeps background tasks.
  const foregroundStep = {stepIndex: 5, status: 'CORTEX_STEP_STATUS_RUNNING', metadata: {toolCall: {name: 'read_file'}}};
  assert.equal(extractAntigravityBackgroundTasks([foregroundStep, bgStep], 0, true).length, 1);
  assert.equal(extractAntigravityBackgroundTasks([foregroundStep], 0, false).length, 1);

  // Web bar & panel SSR render task count, command, output, and stop action.
  const barHtml = renderToStaticMarkup(createElement(BackgroundTasksBar, {tasks: view.backgroundTasks, onOpen: () => {}}));
  assert.match(barHtml, /1 个后台任务运行中/);
  assert.match(barHtml, /Locate capture-service WSL virtualenv/);
  const panelHtml = renderToStaticMarkup(createElement(BackgroundTasksPanel, {
    tasks: view.backgroundTasks, hasTasks: true, turnRunning: false, canOperate: true, busy: false, connected: true,
    onRefresh: () => {}, onStop: () => {}, onCopy: () => {},
  }));
  assert.match(panelHtml, /wsl\.exe bash -lc grep/);
  assert.match(panelHtml, /venv: command not found/);
  assert.match(panelHtml, /结束后台任务/);
});

test('Antigravity queues messages behind a running turn, drains one per turn, and supports steer, send-now, withdraw and cancel', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-antigravity-queue-'));
  const ledgerPath = join(dir, 'ops.sqlite');
  let ledger = new Ledger(ledgerPath);
  const db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  let bridge: AntigravityBridge | undefined;
  t.after(async () => { bridge?.close(); db.close(); ledger.close(); await rm(dir, {recursive: true, force: true}); });
  const id = randomUUID();
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const project = pathToFileURL(dir).href;
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'Queue Test', 'CASCADE_RUN_STATUS_RUNNING', '2026-11-24T00:00:00.000Z', 5, 0, 't0', 0, JSON.stringify([project]));

  const config = {plannerConfig: {planModel: 'MODEL_A', toolConfig: {runCommand: {autoCommandConfig: {}}}}};
  let waitingSteps: any[] = [];
  let cancelAutoIdle = true;
  let sendFailure: BridgeError | null = null;
  const writes: {method: string; body: any}[] = [];

  const createBridge = () => new AntigravityBridge(dir, ledger, async (_dir, method, body) => {
    if (method === 'GetPermissionSettings' || method === 'GetAllCascadeTrajectories') return {};
    if (method === 'GetCascadeTrajectorySteps') return {steps: waitingSteps};
    if (method === 'GetCascadeModelConfigData') {
      return {clientModelConfigs: [{label: 'A', modelOrAlias: {model: 'MODEL_A'}}, {label: 'B', modelOrAlias: {model: 'MODEL_B'}}]};
    }
    if (method === 'GetTrajectoryTurns') return {turns: [{startStepIndex: 0, firstStep: {userInput: {userConfig: config}}}]};
    writes.push({method, body});
    if (method === 'CancelCascadeInvocation' && cancelAutoIdle) {
      db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_CANCELING'");
      setTimeout(() => {
        try { db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE'"); } catch {}
      }, 25);
    }
    if (method === 'SendUserCascadeMessage' && sendFailure) throw sendFailure;
    return {};
  }, undefined, {cancelTimeoutMs: 250, cancelPollMs: 15, dispatchGraceMs: 60_000, queueIntervalMs: 60_000});

  bridge = createBridge();
  const makeOp = () => `${Date.now()}:${randomUUID()}`;
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  // Invalid model fails upfront even when the turn is running (never enqueued).
  assert.equal((await bridge.handle('antigravity.send', {conversationId: id, text: 'bad model', model: 'MODEL_UNKNOWN', opId: makeOp()})).state, 'failed');

  // Enqueue two messages while running; read surfaces supportsQueue and queuedMessages.
  const q1Op = makeOp(), q2Op = makeOp();
  const q1 = await bridge.handle('antigravity.send', {
    conversationId: id, text: '第一条排队', images: [png], model: 'MODEL_B', permissionMode: 'AGENT_PERMISSION_PRESET_AUTO', opId: q1Op,
  });
  assert.deepEqual(q1, {state: 'accepted', conversationId: id, kind: 'queued'});
  const q2 = await bridge.handle('antigravity.send', {conversationId: id, text: '第二条排队', opId: q2Op});
  assert.deepEqual(q2, {state: 'accepted', conversationId: id, kind: 'queued'});
  assert.equal(writes.length, 0);

  const viewRunning = await bridge.handle('antigravity.read', {conversationId: id});
  assert.equal(viewRunning.supportsQueue, true);
  assert.equal(viewRunning.running, true);
  assert.equal(viewRunning.queuedMessages.length, 2);
  assert.equal(viewRunning.queuedMessages[0].text, '第一条排队');
  assert.equal(viewRunning.queuedMessages[0].imageCount, 1);
  assert.equal(viewRunning.queuedMessages[1].text, '第二条排队');

  // Watch wakes up when queue changes (e.g. a third message is enqueued).
  const watchPromise = bridge.handle('antigravity.watch', {conversationId: id, revision: viewRunning.revision});
  const q3Op = makeOp();
  await bridge.handle('antigravity.send', {conversationId: id, text: '第三条待撤回', model: 'MODEL_B', images: [png], permissionMode: 'AGENT_PERMISSION_PRESET_TURBO', opId: q3Op});
  const watched = await watchPromise;
  assert.equal(watched.queuedMessages.length, 3);

  // Withdraw restores text, images, model and permissionMode with a replayable receipt.
  const withdrawOp = makeOp();
  const withdrawn = await bridge.handle('antigravity.withdrawQueued', {conversationId: id, queuedId: q3Op, opId: withdrawOp});
  assert.deepEqual(withdrawn, {
    state: 'accepted',
    queuedId: q3Op,
    kind: 'queue_withdrawn',
    message: {text: '第三条待撤回', images: [png], model: 'MODEL_B', permissionMode: 'AGENT_PERMISSION_PRESET_TURBO'},
  });
  assert.deepEqual(await bridge.handle('antigravity.withdrawQueued', {conversationId: id, queuedId: q3Op, opId: withdrawOp}), withdrawn);

  // Steer sends a queued message into the running turn with NEXT_INVOCATION and without changing turn settings.
  const steerOp = makeOp();
  const steered = await bridge.handle('antigravity.steerQueued', {conversationId: id, queuedId: q2Op, opId: steerOp});
  assert.deepEqual(steered, {state: 'accepted', queuedId: q2Op, kind: 'steer_accepted'});
  assert.deepEqual(await bridge.handle('antigravity.steerQueued', {conversationId: id, queuedId: q2Op, opId: steerOp}), steered);
  assert.deepEqual(writes.at(-1), {
    method: 'SendUserCascadeMessage',
    body: {cascadeId: id, items: [{text: '第二条排队'}], clientMessageId: q2Op.split(':')[1], deliveryStrategy: 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION', cascadeConfig: config},
  });

  // Direct steer while running also uses NEXT_INVOCATION.
  const directSteer = await bridge.handle('antigravity.send', {conversationId: id, text: '直接追加', mode: 'steer', opId: makeOp()});
  assert.equal(directSteer.state, 'accepted');
  assert.equal(directSteer.kind, 'steer_accepted');
  assert.equal(writes.at(-1)!.body.deliveryStrategy, 'MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION');

  // If cancel fails to settle to idle before timeout, send-now leaves the queued item 'queued' and never sends it.
  cancelAutoIdle = false;
  const timedOutNow = await bridge.handle('antigravity.steerQueued', {conversationId: id, queuedId: q1Op, mode: 'now', opId: makeOp()});
  assert.equal(timedOutNow.state, 'failed');
  assert.equal((await bridge.handle('antigravity.read', {conversationId: id})).queuedMessages[0].state, 'queued');

  // When cancel settles to idle, send-now interrupts (keeping background tasks) and sends with saved model & permissionMode.
  cancelAutoIdle = true;
  const sentNow = await bridge.handle('antigravity.steerQueued', {conversationId: id, queuedId: q1Op, mode: 'now', opId: makeOp()});
  assert.deepEqual(sentNow, {state: 'accepted', queuedId: q1Op, kind: 'sent_now'});
  assert.deepEqual(writes.slice(-3).map(w => w.method), ['CancelCascadeInvocation', 'UpdateConversationAnnotations', 'SendUserCascadeMessage']);
  assert.deepEqual(writes.at(-3)!.body, {cascadeId: id, killBackgroundTasks: false});
  assert.equal(writes.at(-1)!.body.cascadeConfig.plannerConfig.planModel, 'MODEL_B');
  assert.equal(writes.at(-1)!.body.cascadeConfig.plannerConfig.toolConfig.runCommand.autoCommandConfig.autoExecutionPolicy, 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO');
  assert.equal(writes.at(-1)!.body.deliveryStrategy, undefined);

  // Direct mode='now' validates invalid model before canceling.
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING', last_user_input_time='t1'");
  const writesBeforeInvalidNow = writes.length;
  assert.equal((await bridge.handle('antigravity.send', {conversationId: id, text: 'bad now', mode: 'now', model: 'MODEL_UNKNOWN', opId: makeOp()})).state, 'failed');
  assert.equal(writes.length, writesBeforeInvalidNow);
  const directNow = await bridge.handle('antigravity.send', {conversationId: id, text: '直接打断发', mode: 'now', opId: makeOp()});
  assert.equal(directNow.state, 'accepted');
  assert.equal(directNow.kind, 'sent_now');

  // Draining respects waiting approval requests and slow SQLite snapshot updates (one message per turn).
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING', not_fully_idle=1, last_user_input_time='t2'");
  const d1 = makeOp(), d2 = makeOp();
  await bridge.handle('antigravity.send', {conversationId: id, text: '自动发 1', opId: d1});
  await bridge.handle('antigravity.send', {conversationId: id, text: '自动发 2', opId: d2});
  waitingSteps = [{stepIndex: 4, status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction: {runCommand: {}}}];
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE'");
  const writesBeforeWaiting = writes.length;
  await bridge.drainQueue(id);
  assert.equal(writes.length, writesBeforeWaiting, 'must not drain while waiting approval exists');

  // Stale steer when idle fails cleanly and leaves item queued.
  assert.equal((await bridge.handle('antigravity.steerQueued', {conversationId: id, queuedId: d1, opId: makeOp()})).state, 'failed');
  assert.equal(ledger.antigravityQueue.queued(id)[0].state, 'queued');

  // Clearing approval allows draining d1 only; a second drain before SQLite updates turnKey must not send d2.
  waitingSteps = [];
  db.exec('UPDATE conversation_summaries SET not_fully_idle=0');
  await bridge.drainQueue(id);
  assert.equal(writes.length, writesBeforeWaiting + 1);
  assert.equal(writes.at(-1)!.body.items[0].text, '自动发 1');
  await bridge.drainQueue(id);
  assert.equal(writes.length, writesBeforeWaiting + 1, 'slow SQLite summary after dispatch must not start next queued message');

  // Uncertain dispatch pauses the queue; removing the uncertain head via cancelQueued unblocks subsequent entries.
  const d3 = makeOp();
  await bridge.handle('antigravity.send', {conversationId: id, text: '自动发 3', opId: d3});
  db.exec("UPDATE conversation_summaries SET last_user_input_time='t3'");
  sendFailure = new BridgeError('uncertain', 'lost receipt', true);
  await bridge.drainQueue(id);
  assert.equal(ledger.antigravityQueue.queued(id)[0].state, 'uncertain');
  sendFailure = null;
  const writesWhilePaused = writes.length;
  await bridge.drainQueue(id);
  assert.equal(writes.length, writesWhilePaused, 'queue stays paused while uncertain head remains');
  assert.equal((await bridge.handle('antigravity.cancelQueued', {conversationId: id, queuedId: d2, opId: makeOp()})).kind, 'queue_cancelled');
  await bridge.drainQueue(id);
  assert.equal(writes.at(-1)!.body.items[0].text, '自动发 3');

  // In-flight 'sending' entry becomes 'uncertain' across connector restart and never auto-resends.
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING', last_user_input_time='t4'");
  const crashOp = makeOp();
  await bridge.handle('antigravity.send', {conversationId: id, text: '重启前发送中', opId: crashOp});
  ledger.antigravityQueue.sending(crashOp);
  bridge.close();
  ledger.close();
  ledger = new Ledger(ledgerPath);
  bridge = createBridge();
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_IDLE'");
  const afterRestart = await bridge.handle('antigravity.read', {conversationId: id});
  assert.equal(afterRestart.queuedMessages[0].state, 'uncertain');
  const writesAfterRestart = writes.length;
  await bridge.drainQueue(id);
  assert.equal(writes.length, writesAfterRestart);

  // SSR check: QueuedMessages renders immediate-send and steer actions when running.
  const queueHtml = renderToStaticMarkup(createElement(QueuedMessages, {
    messages: [{id: 'q1', text: '下一句', imageCount: 0, state: 'queued'}],
    disabled: false,
    canSteer: true,
    nowLabel: '立即发送（打断当前回复并发送；保留后台任务）',
    attachmentsFull: () => false,
    onNow: () => {},
    onSteer: () => {},
    onWithdraw: () => {},
    onCancel: () => {},
  }));
  assert.match(queueHtml, /立即发送（打断当前回复并发送；保留后台任务）/);
  assert.match(queueHtml, /立即追加到当前任务/);
  assert.match(queueHtml, /下一句/);
});

test('an Antigravity conversation is followed through the subscription hub, its messages pushed as they are written', async t => {
  const dir = await mkdtemp(join(tmpdir(),'cmw-antigravity-sync-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir,'conversation_summaries.db'));
  const id = randomUUID(), logs = join(dir,'brain',id,'.system_generated','logs');
  await mkdir(logs,{recursive:true});
  const transcript = join(logs,'transcript.jsonl');
  const line = (step:object) => JSON.stringify(step)+'\n';
  await writeFile(transcript,line({type:'USER_INPUT',step_index:1,content:'<USER_REQUEST>hello</USER_REQUEST>'})+line({type:'PLANNER_RESPONSE',step_index:2,content:'hi'}));
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)').run(id,'Example','CASCADE_RUN_STATUS_IDLE','2026-11-17T02:00:00.000Z',2,1,'before',0,JSON.stringify([pathToFileURL(dir).href]));
  const bridge = new AntigravityBridge(dir,ledger,async()=>({}),undefined,{queueIntervalMs:60_000});
  const {ThreadHub} = await import('../src/connector/thread-hub.js');
  const frames:any[]=[];
  const hub = new ThreadHub(frame=>{frames.push(frame);});
  hub.register('antigravity',bridge.syncSource);
  t.after(async()=>{hub.close();bridge.close();db.close();ledger.close();await rm(dir,{recursive:true,force:true});});
  const snapshot = await hub.open({service:'antigravity',threadId:id});
  assert.deepEqual(snapshot.entries.map(entry=>entry.body),[{id:'1',role:'user',text:'hello'},{id:'2',role:'assistant',text:'hi'}]);
  assert.equal(snapshot.head.title,'Example');
  assert.equal('revision' in snapshot.head||'path' in snapshot.head||'live' in snapshot.head,false,'Only what the panel shows is in the head.');
  const read = await bridge.handle('antigravity.read',{conversationId:id});
  assert.deepEqual(read.messages.map((message:any)=>message.id),snapshot.order,'The old read and the subscription agree.');
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING',step_count=3,last_modified_time='2026-11-17T02:01:00.000Z'");
  await appendFile(transcript,line({type:'PLANNER_RESPONSE',step_index:3,content:'more'}));
  await new Promise(resolve=>setTimeout(resolve,1000));
  assert.ok(frames.length>=1);
  assert.equal(frames[0].seq,snapshot.seq+1);
  assert.deepEqual(frames.flatMap(frame=>frame.entries||[]).map((entry:any)=>entry.body),[{id:'3',role:'assistant',text:'more'}]);
  assert.equal(frames.find(frame=>frame.head?.running!==undefined)?.head.running,true);
  const again = await hub.open({service:'antigravity',threadId:id,have:Object.fromEntries([...snapshot.entries,...frames.flatMap(frame=>frame.entries||[])].map((entry:any)=>[entry.id,entry.rev]))});
  assert.deepEqual(again.entries,[],'Reopening with what it holds sends no messages.');
});

test('Antigravity surfaces Hub error steps missing from transcript files and clears them on subsequent turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-antigravity-err-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  const id = randomUUID(), logs = join(dir, 'brain', id, '.system_generated', 'logs');
  await mkdir(logs, {recursive: true});
  const transcriptPath = join(logs, 'transcript_full.jsonl');
  const line = (step: object) => JSON.stringify(step) + '\n';
  await writeFile(transcriptPath, line({type: 'PLANNER_RESPONSE', step_index: 1465, content: '等待回归测试完成。'}));
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, 'Agent Remediation', 'CASCADE_RUN_STATUS_IDLE', '2026-11-24T06:56:57.000Z', 1467, 1389, 't0', 0, JSON.stringify([pathToFileURL(dir).href]));

  let hubSteps: any[] = [
    {type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: {sourceTrajectoryStepInfo: {stepIndex: 1465}}},
    {
      type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {sourceTrajectoryStepInfo: {stepIndex: 1466}},
      errorMessage: {
        shouldShowUser: true,
        error: {
          userErrorMessage: 'Agent execution terminated due to error.',
          shortError: 'failed to construct executor: plan model not specified; you must specify a valid model',
          fullError: 'https://internal.example/stack',
          errorCode: 2,
          errorId: '1c9047f2-c2a7-4151-92da-d7ed4e369bed-1466',
        },
      },
    },
  ];
  const bridge = new AntigravityBridge(dir, ledger, async (_dir, method) => {
    if (method === 'GetCascadeTrajectorySteps') return {steps: hubSteps};
    return {};
  }, undefined, {queueIntervalMs: 60_000});
  const {ThreadHub} = await import('../src/connector/thread-hub.js');
  const frames: any[] = [];
  const syncHub = new ThreadHub(frame => { frames.push(frame); });
  syncHub.register('antigravity', bridge.syncSource);
  t.after(async () => { syncHub.close(); bridge.close(); db.close(); ledger.close(); await rm(dir, {recursive: true, force: true}); });

  // Idle conversation whose error step was omitted from transcript_full.jsonl still surfaces the error in both read and sync.
  const view = await bridge.handle('antigravity.read', {conversationId: id});
  assert.deepEqual(view.issue, {
    kind: 'error',
    message: 'Agent execution terminated due to error.',
    detail: 'failed to construct executor: plan model not specified; you must specify a valid model',
    errorId: '1c9047f2-c2a7-4151-92da-d7ed4e369bed-1466',
  });
  assert.doesNotMatch(JSON.stringify(view), /internal\.example/);

  const snap = await syncHub.open({service: 'antigravity', threadId: id});
  assert.deepEqual(snap.head.issue, view.issue);

  // A subsequent USER_INPUT step clears the error and pushes the cleared head over subscription.
  hubSteps = [
    ...hubSteps,
    {type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE', metadata: {sourceTrajectoryStepInfo: {stepIndex: 1467}}},
    {type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: {sourceTrajectoryStepInfo: {stepIndex: 1468}}},
  ];
  db.exec("UPDATE conversation_summaries SET status='CASCADE_RUN_STATUS_RUNNING', step_count=1469, last_modified_time='2026-11-24T07:07:17.000Z'");
  await appendFile(transcriptPath, line({type: 'USER_INPUT', step_index: 1468, content: '<USER_REQUEST>提交git</USER_REQUEST>'}));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(frames.find(frame => frame.head && 'issue' in frame.head)?.head.issue, null);

  // Pure extractor: quota errors avoid duplicate detail; retries and hidden errors never leak internal endpoints.
  const quota = extractAntigravityIssue([{
    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    errorMessage: {
      shouldShowUser: true,
      error: {
        userErrorMessage: 'Individual quota reached. Resets in 1h50m57s.',
        shortError: 'RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h50m57s.',
        errorId: 'err-429',
      },
    },
  }], 10);
  assert.deepEqual(quota.issue, {kind: 'error', message: 'Individual quota reached. Resets in 1h50m57s.', errorId: 'err-429'});

  const hidden = extractAntigravityIssue([{
    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    errorMessage: {
      shouldShowUser: false,
      error: {shortError: 'Post "https://secret.endpoint": read tcp 127.0.0.1:7890'},
    },
  }], 20);
  assert.deepEqual(hidden.issue, {kind: 'error'});

  const retry = extractAntigravityIssue([{
    type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
    errorMessage: {
      error: {shortError: 'API error (attempt 3): request failed: Post "https://secret.endpoint": wsarecv: connection reset'},
    },
  }], 30);
  assert.deepEqual(retry.issue, {kind: 'retry', attempt: 3, connection: true});

  // Web error notice renders the user message, detail, and Error ID as an alert.
  const html = renderToStaticMarkup(createElement(AntigravityErrorNotice, {issue: view.issue as Extract<AntigravityIssue, {kind: 'error'}>}));
  assert.match(html, /role="alert"/);
  assert.match(html, /Agent execution terminated due to error\./);
  assert.match(html, /plan model not specified/);
  assert.match(html, /1c9047f2-c2a7-4151-92da-d7ed4e369bed-1466/);
});

test('Antigravity preserves and self-heals cascadeConfig planModel across follow-up turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-antigravity-cfg-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  t.after(async () => { db.close(); ledger.close(); await rm(dir, {recursive: true, force: true}); });
  const id = randomUUID(), peerId = randomUUID(), freshId = randomUUID();
  const project = pathToFileURL(dir).href;
  const logs = join(dir, 'brain', id, '.system_generated', 'logs');
  await mkdir(logs, {recursive: true});
  const line = (step: object) => JSON.stringify(step) + '\n';
  await writeFile(join(logs, 'transcript.jsonl'),
    line({type: 'USER_INPUT', step_index: 10, content: '<USER_REQUEST>desktop turn</USER_REQUEST>'}) +
    line({type: 'USER_INPUT', step_index: 50, content: '<USER_REQUEST>legacy web turn</USER_REQUEST>'}));

  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)');
  insert.run(id, 'Recover Earlier', 'CASCADE_RUN_STATUS_IDLE', '2026-11-24T06:00:00.000Z', 60, 50, 't50', 0, JSON.stringify([project]));
  insert.run(peerId, 'Project Peer', 'CASCADE_RUN_STATUS_IDLE', '2026-11-24T05:00:00.000Z', 10, 0, 't0', 0, JSON.stringify([project]));
  insert.run(freshId, 'No Config Anywhere', 'CASCADE_RUN_STATUS_IDLE', '2026-11-24T04:00:00.000Z', 5, 0, 't0', 0, JSON.stringify(['file:///isolated']));

  const earlierConfig = {plannerConfig: {planModel: 'MODEL_DESKTOP', toolConfig: {runCommand: {autoCommandConfig: {}}}}, executorConfig: {useCoreDirect: true}};
  const peerConfig = {plannerConfig: {planModel: 'MODEL_PEER'}};
  let allowPeerConfig = true;
  const writes: {method: string; body: any}[] = [];
  const bridge = new AntigravityBridge(dir, ledger, async (_dir, method, body) => {
    if (method === 'GetPermissionSettings' || method === 'GetAllCascadeTrajectories' || method === 'GetCascadeTrajectorySteps') return {};
    if (method === 'GetCascadeModelConfigData') {
      return {
        defaultOverrideModelConfig: {modelOrAlias: {model: 'MODEL_DEFAULT'}},
        clientModelConfigs: [
          {label: 'Default', modelOrAlias: {model: 'MODEL_DEFAULT'}},
          {label: 'Desktop', modelOrAlias: {model: 'MODEL_DESKTOP'}},
        ],
      };
    }
    if (method === 'GetTrajectoryTurns') {
      if (body.cascadeId === id) {
        const turns = (body.stepIndices as number[]).map(stepIndex => ({
          startStepIndex: stepIndex,
          firstStep: {userInput: {userConfig: stepIndex === 10 ? earlierConfig : undefined}},
        }));
        return {turns};
      }
      if (body.cascadeId === peerId && allowPeerConfig) {
        return {turns: [{startStepIndex: 0, firstStep: {userInput: {userConfig: peerConfig}}}]};
      }
      return {turns: [{startStepIndex: 0, firstStep: {userInput: {}}}]};
    }
    writes.push({method, body});
    return {};
  }, undefined, {queueIntervalMs: 60_000});
  t.after(() => bridge.close());

  const makeOp = () => `${Date.now()}:${randomUUID()}`;
  // 1. Latest USER_INPUT (step 50) had empty userConfig -> recovers step 10's earlierConfig for both models() and send().
  const models = await bridge.handle('antigravity.models', {conversationId: id});
  assert.equal(models.current, 'MODEL_DESKTOP');
  assert.equal((await bridge.handle('antigravity.send', {conversationId: id, text: '继续', opId: makeOp()})).state, 'accepted');
  assert.deepEqual(writes.at(-1)!.body.cascadeConfig, earlierConfig);

  // 2. Switching only permissionMode on a session with empty latest userConfig preserves recovered planModel too.
  assert.equal((await bridge.handle('antigravity.send', {conversationId: id, text: '切权限', permissionMode: 'AGENT_PERMISSION_PRESET_AUTO', opId: makeOp()})).state, 'accepted');
  assert.equal(writes.at(-1)!.body.cascadeConfig.plannerConfig.planModel, 'MODEL_DESKTOP');
  assert.equal(writes.at(-1)!.body.cascadeConfig.plannerConfig.toolConfig.runCommand.autoCommandConfig.autoExecutionPolicy, 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO');

  // 3. Conversation with no userConfig in its own turns falls back to another conversation in the project (peerConfig).
  db.exec(`UPDATE conversation_summaries SET workspace_uris='${JSON.stringify([project])}' WHERE conversation_id='${freshId}'`);
  assert.equal((await bridge.handle('antigravity.send', {conversationId: freshId, text: 'from peer', opId: makeOp()})).state, 'accepted');
  assert.deepEqual(writes.at(-1)!.body.cascadeConfig, peerConfig);

  // 4. When no conversation anywhere has userConfig, falls back to modelCatalog defaultModel so planModel is still specified.
  allowPeerConfig = false;
  db.exec(`DELETE FROM conversation_summaries WHERE conversation_id='${id}'`);
  assert.equal((await bridge.handle('antigravity.send', {conversationId: freshId, text: 'from catalog', opId: makeOp()})).state, 'accepted');
  assert.deepEqual(writes.at(-1)!.body.cascadeConfig, {plannerConfig: {planModel: 'MODEL_DEFAULT'}});
});

test('newly created Antigravity conversation is immediately readable and syncable before SQLite or transcript flushes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-antigravity-new-'));
  const ledger = new Ledger(':memory:'), db = new DatabaseSync(join(dir, 'conversation_summaries.db'));
  const project = pathToFileURL(dir).href;
  const existingId = randomUUID(), createdId = randomUUID(), uncertainId = randomUUID(), hubOnlyId = randomUUID();
  db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,status TEXT,last_modified_time TEXT,step_count INTEGER,last_user_input_step_index INTEGER,last_user_input_time TEXT,not_fully_idle INTEGER,workspace_uris TEXT)');
  const insert = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?)');
  insert.run(existingId, 'Existing', 'CASCADE_RUN_STATUS_IDLE', '2026-11-25T01:00:00.000Z', 2, 0, 't0', 0, JSON.stringify([project]));
  await writeFile(join(dir, 'hello.txt'), 'world');

  let nextId = createdId;
  let sendUncertain = false;
  let hubTrajectories: Record<string, any> = {};
  const bridge = new AntigravityBridge(dir, ledger, async (_dir, method, body) => {
    if (method === 'GetCascadeModelConfigData') {
      return {
        defaultOverrideModelConfig: {modelOrAlias: {model: 'MODEL_A'}},
        clientModelConfigs: [
          {label: 'Model A', modelOrAlias: {model: 'MODEL_A'}},
          {label: 'Model B', modelOrAlias: {model: 'MODEL_B'}},
        ],
      };
    }
    if (method === 'GetPermissionSettings' || method === 'GetCascadeTrajectorySteps') return {};
    if (method === 'GetAllCascadeTrajectories') return {trajectorySummaries: hubTrajectories};
    if (method === 'GetTrajectoryTurns') return {turns: []};
    if (method === 'StartCascade') return {cascadeId: nextId};
    if (method === 'SendUserCascadeMessage') {
      if (sendUncertain) throw new BridgeError('uncertain', 'lost receipt', true);
      return {};
    }
    if (method === 'UpdateConversationAnnotations') return {};
    return {body};
  }, undefined, {queueIntervalMs: 60_000});

  const {ThreadHub} = await import('../src/connector/thread-hub.js');
  const frames: any[] = [];
  const hub = new ThreadHub(frame => { frames.push(frame); });
  hub.register('antigravity', bridge.syncSource);
  t.after(async () => { hub.close(); bridge.close(); db.close(); ledger.close(); await rm(dir, {recursive: true, force: true}); });

  const makeOp = () => `${Date.now()}:${randomUUID()}`;
  const created = await bridge.handle('antigravity.create', {
    project, text: '你好 Antigravity', opId: makeOp(), model: 'MODEL_B', permissionMode: 'AGENT_PERMISSION_PRESET_AUTO',
  });
  assert.deepEqual(created, {state: 'accepted', conversationId: createdId, submitted: true});

  // Immediately after create, neither conversation_summaries.db nor transcript.jsonl has the new conversation yet.
  const snap = await hub.open({service: 'antigravity', threadId: createdId});
  assert.equal(snap.head.cwd, dir);
  assert.equal(snap.head.running, true);
  assert.equal(snap.head.permissionMode, 'AGENT_PERMISSION_PRESET_AUTO');
  assert.deepEqual(snap.entries.map(e => e.body), [{id: '0', role: 'user', text: '你好 Antigravity'}]);

  const read = await bridge.handle('antigravity.read', {conversationId: createdId});
  assert.equal(read.cwd, dir);
  assert.equal(read.running, true);
  assert.deepEqual(read.messages, [{id: '0', role: 'user', text: '你好 Antigravity'}]);

  const models = await bridge.handle('antigravity.models', {conversationId: createdId});
  assert.equal(models.current, 'MODEL_B');

  const listed = await bridge.handle('antigravity.list', {project});
  assert.equal(listed.data[0].id, createdId);
  assert.equal(listed.data[0].running, true);

  const file = await bridge.handle('antigravity.file.read', {conversationId: createdId, path: 'hello.txt'});
  assert.equal(file.text, 'world');

  // Sending another message right away queues cleanly instead of failing with missing.
  const queued = await bridge.handle('antigravity.send', {conversationId: createdId, text: '补充一句', opId: makeOp()});
  assert.deepEqual(queued, {state: 'accepted', conversationId: createdId, kind: 'queued'});

  // Once SQLite gets the row (before transcript is written), the submitted user message stays visible without flicker.
  insert.run(createdId, '打招呼', 'CASCADE_RUN_STATUS_RUNNING', '2026-11-25T02:00:00.000Z', 1, 0, 't1', 1, JSON.stringify([project]));
  const afterDb = await bridge.handle('antigravity.read', {conversationId: createdId});
  assert.equal(afterDb.title, '打招呼');
  assert.deepEqual(afterDb.messages, [{id: '0', role: 'user', text: '你好 Antigravity'}]);

  // Once transcript_full.jsonl is written, real transcript messages replace the synthetic entry and push via ThreadHub.
  const logs = join(dir, 'brain', createdId, '.system_generated', 'logs');
  await mkdir(logs, {recursive: true});
  const line = (step: object) => JSON.stringify(step) + '\n';
  await writeFile(join(logs, 'transcript_full.jsonl'),
    line({type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>你好 Antigravity</USER_REQUEST>'}) +
    line({type: 'PLANNER_RESPONSE', step_index: 1, content: '你好！有什么可以帮你的？'}));
  await new Promise(resolve => setTimeout(resolve, 650));
  const afterTranscript = await bridge.handle('antigravity.read', {conversationId: createdId});
  assert.deepEqual(afterTranscript.messages, [
    {id: '0', role: 'user', text: '你好 Antigravity'},
    {id: '1', role: 'assistant', text: '你好！有什么可以帮你的？'},
  ]);
  assert.ok(frames.some(frame => (frame.entries || []).some((entry: any) => entry.body?.text === '你好！有什么可以帮你的？')));

  // Once seen in SQLite, deleting the row from SQLite (with Hub empty) properly reports missing again.
  db.exec(`DELETE FROM conversation_summaries WHERE conversation_id='${createdId}'`);
  await assert.rejects(bridge.handle('antigravity.read', {conversationId: createdId}), (error: BridgeError) => error.code === 'missing');

  // Uncertain create still avoids missing, without fabricating a user message.
  nextId = uncertainId;
  sendUncertain = true;
  const uncertain = await bridge.handle('antigravity.create', {project, text: '待确认', opId: makeOp()});
  assert.deepEqual(uncertain, {state: 'accepted', conversationId: uncertainId, submitted: false, uncertain: true});
  const uncertainRead = await bridge.handle('antigravity.read', {conversationId: uncertainId});
  assert.equal(uncertainRead.running, false);
  assert.deepEqual(uncertainRead.messages, []);

  // Even without pendingCreated (e.g. after connector restart), snapshot falls back to GetAllCascadeTrajectories if SQLite lags.
  hubTrajectories = {
    [hubOnlyId]: {
      trajectoryId: 'traj-hub',
      summary: 'Hub Live',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      stepCount: 1,
      lastModifiedTime: '2026-11-25T02:05:00.000Z',
      workspaces: [{workspaceFolderAbsoluteUri: project}],
      annotations: {permissionPreset: 'AGENT_PERMISSION_PRESET_DEFAULT'},
    },
  };
  const hubRead = await bridge.handle('antigravity.read', {conversationId: hubOnlyId});
  assert.equal(hubRead.title, 'Hub Live');
  assert.equal(hubRead.cwd, dir);
  assert.equal(hubRead.running, true);
  assert.equal(hubRead.permissionMode, 'AGENT_PERMISSION_PRESET_DEFAULT');

  // A genuinely unknown conversation still throws missing.
  await assert.rejects(bridge.handle('antigravity.read', {conversationId: randomUUID()}), (error: BridgeError) => error.code === 'missing');
});
