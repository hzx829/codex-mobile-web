import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {contextUsage,accountLimits} from '../src/connector/usage.js';
import {normalizeSession} from '../src/connector/normalize.js';
import {contextSummary,limitLabel,StatusDetails} from '../web/thread-status.js';
import {ThreadMenu} from '../web/thread-menu.js';

test('context is the latest request usage, not cumulative billing or a guessed model capacity',()=>{
  const usage={last:{totalTokens:104000,inputTokens:100000,outputTokens:4000},total:{totalTokens:9000000},modelContextWindow:260000};
  const session=normalizeSession({id:'s',latestTokenUsageInfo:usage,turns:[]},'desktop',[]);
  assert.deepEqual(session.contextUsage,{usedTokens:104000,windowTokens:260000});
  assert.equal(contextSummary(session.contextUsage),'剩余 60%（已用 10.4万 / 26万）');
  assert.equal(contextUsage({total:{totalTokens:9000000},modelContextWindow:260000}),null);
  assert.equal(contextUsage({last:{totalTokens:null}}),null);
  assert.equal(contextUsage({last:{totalTokens:-1}}),null);
  assert.equal(contextUsage({last:{totalTokens:Infinity}}),null);
  assert.equal(contextSummary(contextUsage({last:{totalTokens:0},modelContextWindow:260000})),'剩余 100%（已用 0 / 26万）');
  assert.equal(contextSummary(contextUsage({last:{totalTokens:3},modelContextWindow:0})),'已用 3 tokens（上限暂不可用）');
  assert.equal(contextSummary({usedTokens:300000,windowTokens:260000}),'剩余 0%（已用 30万 / 26万）');
});

test('rate limits prefer separate native buckets and preserve unavailable windows',()=>{
  const week={usedPercent:3,windowDurationMins:10080,resetsAt:1791075340},short={usedPercent:110,windowDurationMins:300,resetsAt:null};
  const limits=accountLimits({rateLimits:{primary:{...week,usedPercent:99}},rateLimitsByLimitId:{codex:{limitId:'codex',primary:week,secondary:null},review:{limitId:'review',limitName:'Review',primary:short,secondary:{usedPercent:null}}}});
  assert.equal(limits.length,2);assert.equal(limits[0].usedPercent,3);
  assert.equal(limitLabel(limits[0]),'7 天限制');assert.equal(limitLabel(limits[1]),'Review · 5 小时限制');
  assert.deepEqual(accountLimits({rateLimitsByLimitId:null,rateLimits:{primary:week}}),[{id:'default:primary',name:null,usedPercent:3,windowMinutes:10080,resetsAt:1791075340}]);
  assert.deepEqual(accountLimits({rateLimits:{primary:null,secondary:{usedPercent:NaN}}}),[]);
  assert.equal(accountLimits({rateLimits:{primary:{usedPercent:0}}})[0].usedPercent,0);
});

test('status renders context, multiple limits and resets; unknown or expired values never imply unused quota',()=>{
  const view=normalizeSession({id:'s',cwd:'C:/project',latestTokenUsageInfo:{last:{totalTokens:104000},modelContextWindow:260000},turns:[]},'desktop',[]);
  const props={view,threadId:'s',cwd:view.cwd,connected:true,loading:false,error:'',copy:()=>{}};
  const status={threadId:'s',limits:accountLimits({rateLimits:{primary:{usedPercent:5,windowDurationMins:10080,resetsAt:Date.now()/1000+86400},secondary:{usedPercent:110,windowDurationMins:300,resetsAt:null}}})};
  const html=renderToStaticMarkup(createElement(StatusDetails,{...props,status}));
  for(const value of ['远程会话已连接','C:/project','剩余 60%','7 天限制','剩余 95%','重置','5 小时限制','剩余 0%'])assert.ok(html.includes(value),value);
  const unavailable=renderToStaticMarkup(createElement(StatusDetails,{...props,view:null,status:{threadId:'s',limits:[],limitsNotice:'额度不可用'}}));
  assert.ok(unavailable.includes('暂未提供上下文'));assert.ok(unavailable.includes('额度不可用'));assert.ok(!unavailable.includes('剩余 100%'));
  const expired=renderToStaticMarkup(createElement(StatusDetails,{...props,status:{threadId:'s',limits:[{...status.limits[0],resetsAt:1}]}}));
  assert.ok(expired.includes('已到重置时间，等待更新'));assert.ok(!expired.includes('剩余 95%'));
});

test('header thread menu contains the four requested actions while the list keeps organization actions',()=>{
  const props={thread:{id:'s',title:'Review'},point:{x:10,y:20},preference:{},sections:[],archived:false,connected:true,close:()=>{},change:()=>{},copy:async()=>{},rename:async()=>{},archive:async()=>{}};
  const header=renderToStaticMarkup(createElement(ThreadMenu,{...props,compact:true}));
  for(const label of ['置顶','复制会话 ID','重命名','归档'])assert.ok(header.includes(label));
  for(const label of ['移至分区','标为未读'])assert.ok(!header.includes(label));
  const sidebar=renderToStaticMarkup(createElement(ThreadMenu,props));
  assert.ok(sidebar.includes('移至分区'));assert.ok(sidebar.includes('标为未读'));
});
