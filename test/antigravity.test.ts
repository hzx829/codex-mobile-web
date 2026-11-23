import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AntigravityMessages,antigravityIssueText,groupAntigravityMessages} from '../web/antigravity-messages.js';
import type {AntigravityMessage} from '../src/shared/types.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, mkdir, appendFile, rm, writeFile, readFile} from 'node:fs/promises';
import {uploadAttachments} from '../web/file-upload.js';
import {fileReference} from '../web/preview-target.js';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {AntigravityBridge,parseAntigravityModels,extractAntigravityRequests} from '../src/connector/antigravity.js';
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
  assert.deepEqual(writes[0],{method:'SendUserCascadeMessage',body:{cascadeId:id,items:[{text:'next'}],clientMessageId:payload.opId.split(':')[1]}});
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
    media:[{mimeType:'image/png',inlineData:'iVBORw0KGgo='},{mimeType:'image/jpeg',inlineData:'/9j/4AA='}],clientMessageId:pictured.opId.split(':')[1]}});
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
