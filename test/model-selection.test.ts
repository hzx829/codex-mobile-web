import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelDisplayName,reasoningLabel,resolveModelSelection,selectModel} from '../src/shared/models.js';

const models=[
  {model:'gpt-6-astra',displayName:'GPT-6-Astra',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'xhigh'},{reasoningEffort:'ultra'}],serviceTiers:[{id:'priority',name:'Fast'}]},
  {model:'gpt-6-luna',displayName:'GPT-6-Luna',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'xhigh'}],additionalSpeedTiers:['fast']},
  {model:'custom',displayName:'My own model',supportedReasoningEfforts:[{reasoningEffort:'future'}]},
];
const inherited={model:'',effort:'',serviceTier:undefined};

test('model names follow desktop formatting while preserving catalog/provider names',()=>{
  assert.equal(modelDisplayName(models[0]),'GPT-6 Astra');
  assert.equal(modelDisplayName({displayName:'GPT-6.1-Sol'}),'GPT-6.1 Sol');
  assert.equal(modelDisplayName(undefined,'gpt-6-astra'),'GPT-6 Astra');
  assert.equal(modelDisplayName({model:'gpt-6-astra',displayName:'Custom deployment'}),'Custom deployment');
  assert.equal(modelDisplayName({model:'provider/model-v2'}),'provider/model-v2');
  assert.equal(reasoningLabel('xhigh'),'极高');assert.equal(reasoningLabel('low'),'轻度');
  assert.equal(reasoningLabel('max'),'Max');assert.equal(reasoningLabel('ultra'),'Ultra');assert.equal(reasoningLabel('future'),'future');
});

test('untouched and reset selections inherit current settings; null explicitly disables fast',()=>{
  const current={model:'gpt-6-astra',effort:'ultra',serviceTier:'priority'};
  const selected=resolveModelSelection(models,inherited,current);
  assert.equal(selected.effort,'ultra');assert.equal(selected.isFast,true);
  assert.deepEqual(selected.efforts,['medium','xhigh','ultra']);
  assert.equal(resolveModelSelection(models,{...inherited,serviceTier:null},current).isFast,false);
  assert.equal(resolveModelSelection(models,inherited,{model:'gpt-6-astra'}).effort,'medium');
  assert.equal(resolveModelSelection(models,inherited,{model:'unlisted',effort:'high'}).model,undefined);
});

test('changing model replaces unsupported inherited reasoning and maps actual speed tier IDs',()=>{
  const current={model:'gpt-6-astra',effort:'ultra',serviceTier:'priority'};
  const luna=selectModel(models,inherited,current,'gpt-6-luna');
  assert.deepEqual(luna,{model:'gpt-6-luna',effort:'medium',serviceTier:'fast'});
  assert.equal(resolveModelSelection(models,luna,current).effort,'medium');
  assert.deepEqual(selectModel(models,{...inherited,effort:'xhigh'},current,'gpt-6-luna'),{model:'gpt-6-luna',effort:'xhigh',serviceTier:'fast'});
  assert.deepEqual(selectModel(models,inherited,current,'custom'),{model:'custom',effort:'future',serviceTier:null});
  assert.deepEqual(selectModel(models,{...inherited,serviceTier:null},current,'gpt-6-luna'),{model:'gpt-6-luna',effort:'medium',serviceTier:null});
  assert.equal(selectModel(models,inherited,current,'missing'),inherited);
});
