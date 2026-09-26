import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localPreviewUrl} from '../src/connector/browser-preview.js';

test('browser preview starts only at a local HTTP page',()=>{
  assert.equal(localPreviewUrl('http://127.0.0.1:5173/agents'),'http://127.0.0.1:5173/agents');
  assert.equal(localPreviewUrl('http://localhost:3000/'),'http://localhost:3000/');
  for(const url of ['https://example.com','file:///C:/secret','http://user:pass@localhost:5173','http://192.168.1.2:5173'])assert.throws(()=>localPreviewUrl(url));
});
