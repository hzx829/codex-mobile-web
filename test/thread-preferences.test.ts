import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupThreads,visibleThreads,rememberThreads,saveThread,type ThreadPreferences} from '../web/thread-preferences.js';

const one={id:'1',title:'第一个项目',cwd:'C:/one',updatedAt:1},two={id:'2',title:'Review changes',cwd:'C:/two',updatedAt:2},three={id:'3',title:'Recent',cwd:'C:/one',updatedAt:3};
test('pinned and section threads survive pagination and respect project, archive and search filters',()=>{
  const prefs:ThreadPreferences=JSON.parse(JSON.stringify({'1':{pinned:true,section:'待办',thread:saveThread(one,false)},'2':{section:'Review',thread:saveThread(two,true)}}));
  assert.deepEqual(visibleThreads([three],prefs,'',false,'').map(t=>t.id),['3','1']);
  assert.deepEqual(visibleThreads([],prefs,'C:/two',false,''),[]);
  assert.deepEqual(visibleThreads([],prefs,'',true,'review').map(t=>t.id),['2']);
  assert.deepEqual(visibleThreads([],prefs,'',true,'no match'),[]);
  assert.deepEqual(visibleThreads([one],prefs,'',false,''),[one]);
  assert.deepEqual(groupThreads([three,two,one],prefs,'最近').map(g=>[g.label,g.threads.map(t=>t.id)]),[['置顶',['1']],['Review',['2']],['最近',['3']]]);
  prefs['1'].pinned=false;
  assert.equal(groupThreads([one],prefs,'最近')[0].label,'待办');
});

test('native list metadata refreshes local shortcuts without changing pin, section or unread state',()=>{
  const prefs:ThreadPreferences={'1':{pinned:true,unread:true,thread:saveThread(one,false)},'2':{section:'Review',thread:saveThread(two,true)}};
  assert.equal(rememberThreads(prefs,[one],false),prefs);
  const updated=rememberThreads(prefs,[{...one,title:'Renamed'},three],true);
  assert.equal(updated['1'].thread?.title,'Renamed');assert.equal(updated['1'].thread?.archived,true);
  assert.equal(updated['1'].pinned,true);assert.equal(updated['1'].unread,true);
  assert.equal(updated['2'],prefs['2']);assert.equal(updated['3'],undefined);
  assert.equal(prefs['1'].thread?.title,one.title);
  assert.deepEqual(visibleThreads([],updated,'',false,''),[]);
});
