import {test} from 'node:test';
import assert from 'node:assert/strict';
import {groupItems} from '../web/activity.js';

test('consecutive tool items collapse without changing conversation order',()=>{
  const item=(id:string,role:string)=>({id,role,type:role,text:id});
  const groups=groupItems([item('user','user'),item('command','activity'),item('file','activity'),item('reply','assistant'),item('search','activity')]);
  assert.deepEqual(groups.map(group=>group.map(entry=>entry.id)),[['user'],['command','file'],['reply'],['search']]);
});
