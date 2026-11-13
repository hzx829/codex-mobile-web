import {useId,useRef,useState,type CSSProperties} from 'react';
import type {Json} from '../src/shared/types';
import {modelDisplayName,reasoningLabel,resolveModelSelection,selectModel,type ModelDefaults,type ModelSelection} from '../src/shared/models';
import {Icon} from './icons';
import {Popover,type MenuPoint} from './popover';
import './model-picker.css';

export function ModelPicker({point,anchor,models,value,current,disabled=false,onChange,close}:{
  point:MenuPoint;anchor?:HTMLElement|null;models:Json[];value:ModelSelection;current:ModelDefaults;disabled?:boolean;onChange:(selection:ModelSelection)=>void;close:()=>void;
}){
  const [expanded,setExpanded]=useState(false),modelButton=useRef<HTMLButtonElement>(null),listId=useId();
  const selected=resolveModelSelection(models,value,current),index=selected.efforts.indexOf(selected.effort);
  const overridden=Boolean(value.model||value.effort||value.serviceTier!==undefined);
  const progress=selected.efforts.length>1?Math.max(0,index)/(selected.efforts.length-1)*100:0;
  function choose(id:string){onChange(selectModel(models,value,current,id));setExpanded(false);modelButton.current?.focus({preventScroll:true});}
  return <Popover point={point} anchor={anchor} side="above" title="模型与思考程度" label="模型与思考程度" close={close} className="model-picker" focusSelector=".model-picker-model" showHeader={false}>
    <div className="model-picker-controls">
      <button className={`model-picker-speed${selected.isFast?' active':''}`} type="button" aria-label="极速，用量更多" aria-pressed={selected.isFast} disabled={disabled||!selected.fast} title={selected.fast?'极速 · 用量更多':'当前模型未提供极速档位'} onClick={()=>onChange({...value,serviceTier:selected.isFast?null:selected.fast})}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/></svg>
      </button>
      <div className="model-picker-current">
        <strong aria-live="polite">{reasoningLabel(selected.effort)||'默认思考程度'}</strong>
        <button type="button" className="model-picker-model" ref={modelButton} disabled={disabled||!models.length} aria-expanded={expanded} aria-controls={listId} onClick={()=>setExpanded(!expanded)}><span>{modelDisplayName(selected.model,selected.id)||'选择模型'}</span><Icon name="chevron" size={13}/></button>
      </div>
      <button className="model-picker-reset" type="button" aria-label="沿用当前聊天设置" title="沿用当前聊天设置" disabled={disabled||!overridden} onClick={()=>{onChange({model:'',effort:'',serviceTier:undefined});setExpanded(false);}}><Icon name="undo" size={18}/></button>
    </div>
    {selected.efforts.length>0&&<div className="model-picker-effort" style={{'--effort-progress':`${progress}%`} as CSSProperties}>
      <div className="model-picker-track" aria-hidden="true">{selected.efforts.map((effort,position)=><i key={effort} className={position<=index?'filled':''}/>)}</div>
      <input className="model-picker-slider" type="range" aria-label="思考程度" aria-valuetext={reasoningLabel(selected.effort)||'默认思考程度'} min={0} max={Math.max(0,selected.efforts.length-1)} step={1} value={Math.max(0,index)} disabled={disabled||selected.efforts.length<2} onChange={event=>onChange({...value,effort:selected.efforts[Number(event.target.value)]})}/>
    </div>}
    {expanded&&<div className="model-picker-options" id={listId} role="group" aria-label="模型">
      {models.map(model=><button type="button" key={model.model} aria-pressed={model.model===selected.id} disabled={disabled} onClick={()=>choose(model.model)}><span>{modelDisplayName(model)}</span>{model.model===selected.id&&<Icon name="check" size={16}/>}</button>)}
    </div>}
  </Popover>;
}
