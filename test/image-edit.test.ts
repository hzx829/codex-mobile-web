import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NO_EDITS,addEdit,appliedEdits,cropHandleAt,cropOf,dragCrop,fitScale,redoEdit,roundRect,sameRect,strokesOf,undoEdit,type EditOp} from '../web/image-edit.js';

const stroke=(color:string):EditOp=>({kind:'stroke',stroke:{color,width:4,points:[{x:1,y:1},{x:5,y:5}]}});
const crop=(x:number,y:number,width:number,height:number):EditOp=>({kind:'crop',rect:{x,y,width,height}});

test('marks and crops undo and redo in order; something new drops what was undone',()=>{
  let history=addEdit(addEdit(addEdit(NO_EDITS,stroke('red')),crop(10,20,300,200)),stroke('blue'));
  assert.deepEqual(strokesOf(appliedEdits(history)).map(s=>s.color),['red','blue']);
  assert.deepEqual(cropOf(appliedEdits(history),1000,800),{x:10,y:20,width:300,height:200});
  history=undoEdit(undoEdit(history));
  assert.equal(history.at,1);
  assert.deepEqual(cropOf(appliedEdits(history),1000,800),{x:0,y:0,width:1000,height:800},'undoing the crop shows the whole photo again');
  history=redoEdit(history);
  assert.deepEqual(cropOf(appliedEdits(history),1000,800),{x:10,y:20,width:300,height:200});
  history=addEdit(history,stroke('green'));
  assert.deepEqual([history.at,history.ops.length],[3,3]);
  assert.equal(redoEdit(history),history,'nothing left to redo');
  assert.deepEqual(strokesOf(appliedEdits(history)).map(s=>s.color),['red','green'],'the undone blue stroke is gone');
  assert.equal(undoEdit(NO_EDITS),NO_EDITS);
  // The latest crop wins; an earlier one is replaced, not intersected.
  assert.deepEqual(cropOf([crop(0,0,100,100),crop(50,50,400,400)],1000,800),{x:50,y:50,width:400,height:400});
});

test('the crop box grabs corners, edges and its middle, and stays inside the photo',()=>{
  const box={x:100,y:100,width:200,height:150};
  assert.equal(cropHandleAt(box,{x:102,y:98}),'nw');
  assert.equal(cropHandleAt(box,{x:310,y:255}),'se');
  assert.equal(cropHandleAt(box,{x:200,y:100}),'n');
  assert.equal(cropHandleAt(box,{x:95,y:170}),'w');
  assert.equal(cropHandleAt(box,{x:200,y:170}),'move');
  assert.equal(cropHandleAt(box,{x:20,y:20}),null);
  // A small box keeps a middle to move it by.
  assert.equal(cropHandleAt({x:0,y:0,width:30,height:30},{x:15,y:15}),'move');

  const bounds={width:1000,height:800},start={x:100,y:100,width:400,height:300};
  assert.deepEqual(dragCrop(start,'move',-500,900,bounds,48),{x:0,y:500,width:400,height:300},'moving stops at the edges');
  assert.deepEqual(dragCrop(start,'se',50,20,bounds,48),{x:100,y:100,width:450,height:320});
  assert.deepEqual(dragCrop(start,'se',900,900,bounds,48),{x:100,y:100,width:900,height:700},'growing stops at the photo');
  assert.deepEqual(dragCrop(start,'nw',-500,-500,bounds,48),{x:0,y:0,width:500,height:400});
  assert.deepEqual(dragCrop(start,'w',1000,0,bounds,48),{x:452,y:100,width:48,height:300},'shrinking stops at the minimum size');
  assert.deepEqual(dragCrop(start,'n',0,-30,bounds,48),{x:100,y:70,width:400,height:330},'an edge moves one side only');
  assert.deepEqual(dragCrop({x:0,y:0,width:20,height:20},'e',-10,0,{width:20,height:20},48),{x:0,y:0,width:20,height:20},'a photo smaller than the minimum keeps its size');
});

test('fitting and rounding',()=>{
  assert.equal(fitScale({width:2000,height:1000},{width:400,height:800}),.2);
  assert.equal(fitScale({width:100,height:50},{width:4000,height:4000}),4,'small photos are enlarged at most four times');
  assert.equal(fitScale({width:0,height:0},{width:400,height:400}),0);
  assert.deepEqual(roundRect({x:10.4,y:.6,width:99.7,height:50.2}),{x:10,y:1,width:100,height:50});
  assert.ok(sameRect({x:10.2,y:5,width:100.4,height:30},{x:10,y:5,width:100,height:30}));
  assert.ok(!sameRect({x:10,y:5,width:100,height:30},{x:10,y:5,width:101,height:30}));
});
