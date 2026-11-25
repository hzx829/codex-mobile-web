import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {QUIET_RELOAD_MS,RELOAD_GUARD_MS,UpdateWatch,outdated,pageAssets} from '../web/app-update.js';

test('a page knows which versioned files it was built from',()=>{
  const {document}=parseHTML(`<html><head>
    <link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg">
    <script type="module" crossorigin src="/assets/index-Bsef8ArP.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-hePW80VL.js">
    <link rel="stylesheet" crossorigin href="https://47.114.78.21/assets/index-30siKIPr.css">
  </head><body><script src="/assets/index-Bsef8ArP.js"></script></body></html>`);
  assert.deepEqual(pageAssets(document),['/assets/index-Bsef8ArP.js','/assets/rolldown-runtime-hePW80VL.js','/assets/index-30siKIPr.css']);
});

test('a page is outdated only when the cached page uses other files',()=>{
  const own=['/assets/index-old.js','/assets/index-old.css'];
  assert.equal(outdated(own,['/assets/index-old.js','/assets/index-old.css','/assets/pdf-lazy.js']),false,'lazy chunks of the same release are not news');
  assert.equal(outdated(own,['/assets/index-new.js','/assets/index-old.css']),true);
  assert.equal(outdated(own,[]),false,'an empty list (nothing cached yet) is not news');
  assert.equal(outdated(own,undefined),false);
  assert.equal(outdated([],['/assets/index-new.js']),false,'a development page has no versioned files');
});

test('an outdated page reloads by itself only right after it is shown and before anyone touches it',()=>{
  let now=1_000_000;const clock=()=>now;
  const old=['/assets/index-old.js'],next=['/assets/index-new.js'];
  const quiet={visible:true,lastReload:0};
  const watch=new UpdateWatch(old,clock);
  assert.equal(watch.decide(old,quiet),'none');
  assert.equal(watch.decide(next,quiet),'reload','just opened, untouched');
  assert.equal(watch.decide(next,{...quiet,visible:false}),'offer','hidden pages wait');
  now+=QUIET_RELOAD_MS;
  assert.equal(watch.decide(next,quiet),'offer','too long after opening: ask first');
  watch.show();
  assert.equal(watch.decide(next,quiet),'reload','brought back to the screen');
  watch.touch();
  assert.equal(watch.decide(next,quiet),'offer','in use: ask first');
  watch.show();
  assert.equal(watch.decide(next,{...quiet,lastReload:now-1000}),'offer','one automatic reload per minute, so it never loops');
  assert.equal(watch.decide(next,{...quiet,lastReload:now-RELOAD_GUARD_MS}),'reload');
});
