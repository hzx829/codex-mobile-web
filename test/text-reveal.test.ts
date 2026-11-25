import {test} from 'node:test';
import assert from 'node:assert/strict';
import {advance,retarget,revealStep,safeCut,visibleText,REVEAL_FRAME_MS} from '../web/text-reveal.js';

test('a reveal step drains a share of the backlog, at least one character, and all of it after a stall', () => {
  assert.equal(revealStep(0,REVEAL_FRAME_MS),0);
  assert.equal(revealStep(3,REVEAL_FRAME_MS),1,'the tail always finishes');
  assert.equal(revealStep(90,REVEAL_FRAME_MS),10,'a larger backlog catches up faster');
  assert.equal(revealStep(90,150),90);
  assert.equal(revealStep(90,10_000),90,'a hidden tab shows everything when it comes back');
  assert.equal(revealStep(90,0),0);
});

test('text seen first is shown whole; growth is paced; replaced text is shown whole', () => {
  let state=retarget(undefined,'你好');
  assert.equal(visibleText(state),'你好','opening a session paints the reply as it is');
  state=retarget(state,'你好，这是一段正在写的回复');
  assert.equal(visibleText(state),'你好','new text waits for the next frame');
  state=advance(state,REVEAL_FRAME_MS);
  assert.ok(visibleText(state).length>2&&visibleText(state).length<state.target.length);
  for(let i=0;i<30;i++)state=advance(state,REVEAL_FRAME_MS);
  assert.equal(visibleText(state),'你好，这是一段正在写的回复');
  assert.equal(retarget(state,state.target),state);
  assert.equal(visibleText(retarget(state,'完全不同的内容')),'完全不同的内容');
});

test('a cut never splits an emoji or a surrogate pair', () => {
  const text='好👍🏽了';
  assert.equal(safeCut(text,2),1,'inside the thumbs-up');
  assert.equal(safeCut(text,4),1,'inside its skin tone');
  assert.equal(safeCut(text,5),5);
  assert.equal(visibleText({target:text,shown:3}),'好');
  const flags='🇨🇳🇯🇵';
  assert.equal(safeCut(flags,2),0,'a flag is one character');
  assert.equal(safeCut('x'.repeat(100)+flags,102),100,'only the text around the cut is segmented');
});
