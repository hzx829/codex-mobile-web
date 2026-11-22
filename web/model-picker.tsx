import {useEffect,useId,useRef,useState,type CSSProperties,type ReactNode,type Ref} from 'react';
import type {Json} from '../src/shared/types';
import {modelDisplayName,reasoningLabel,resolveModelSelection,selectModel,type ModelDefaults,type ModelSelection} from '../src/shared/models';
import {Icon} from './icons';
import {Popover,type MenuPoint} from './popover';

type PickerProps={
  /** Codex-shaped entries: `model`, `displayName`, and optionally `description`, reasoning efforts and service tiers. */
  models:Json[];value:ModelSelection;current:ModelDefaults;disabled?:boolean;onChange:(selection:ModelSelection)=>void;
  /** Reasoning effort and the fast tier; off for runtimes that only choose a model. */
  tuning?:boolean;
  /** The fast tier button; off for runtimes that tune effort only. */
  speed?:boolean;
  /** The button that drops the choice and keeps the chat's own settings; off where every choice is concrete. */
  resettable?:boolean;
  /** Without tuning: what "keep the current model" shows, and the dialog's name. */
  currentLabel?:string;label?:string;
  /** Loading, error or empty-list line under the models. */
  status?:ReactNode;
};

export function ModelPicker({point,anchor,close,...props}:PickerProps&{point:MenuPoint;anchor?:HTMLElement|null;close:()=>void}){
  return props.tuning===false?<ModelList {...props} point={point} anchor={anchor} close={close}/>:<TunedModelPicker {...props} point={point} anchor={anchor} close={close}/>;
}

function TunedModelPicker({point,anchor,models,value,current,disabled=false,onChange,close,status,speed=true,resettable=true}:PickerProps&{point:MenuPoint;anchor?:HTMLElement|null;close:()=>void}){
  const [expanded,setExpanded]=useState(false),modelButton=useRef<HTMLButtonElement>(null),listId=useId();
  const selected=resolveModelSelection(models,value,current),index=selected.efforts.indexOf(selected.effort);
  const effortText=reasoningLabel(selected.effort),recommended=Boolean(selected.effort)&&selected.effort===selected.model?.defaultReasoningEffort;
  const overridden=Boolean(value.model||value.effort||value.serviceTier!==undefined);
  const progress=selected.efforts.length>1?Math.max(0,index)/(selected.efforts.length-1)*100:0;
  function choose(id:string){onChange(selectModel(models,value,current,id));setExpanded(false);modelButton.current?.focus({preventScroll:true});}
  return <Popover point={point} anchor={anchor} side="above" title="模型与思考程度" label="模型与思考程度" close={close} className="model-picker" focusSelector=".model-picker-model" showHeader={false}>
    <div className="model-picker-controls">
      {!speed?<span aria-hidden="true"/>:<button className={`model-picker-speed${selected.isFast?' active':''}`} type="button" aria-label="极速，用量更多" aria-pressed={selected.isFast} disabled={disabled||!selected.fast} title={selected.fast?'极速 · 用量更多':'当前模型未提供极速档位'} onClick={()=>onChange({...value,serviceTier:selected.isFast?null:selected.fast})}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/></svg>
      </button>}
      <div className="model-picker-current">
        <strong aria-live="polite">{effortText||'思考程度'}{recommended&&<small>推荐</small>}</strong>
        <button type="button" className="model-picker-model" ref={modelButton} disabled={disabled||!models.length} aria-expanded={expanded} aria-controls={listId} onClick={()=>setExpanded(!expanded)}><span>{modelDisplayName(selected.model,selected.id)||'选择模型'}</span><Icon name="chevron" size={13}/></button>
      </div>
      {!resettable?<span aria-hidden="true"/>:<button className="model-picker-reset" type="button" aria-label="沿用当前聊天设置" title="沿用当前聊天设置" disabled={disabled||!overridden} onClick={()=>{onChange({model:'',effort:'',serviceTier:undefined});setExpanded(false);}}><Icon name="undo" size={18}/></button>}
    </div>
    {selected.efforts.length>0&&<div className="model-picker-effort" style={{'--effort-progress':`${progress}%`} as CSSProperties}>
      <div className="model-picker-track" aria-hidden="true">{selected.efforts.map((effort,position)=><i key={effort} className={position<=index?'filled':''}/>)}</div>
      <input className="model-picker-slider" type="range" aria-label="思考程度" aria-valuetext={effortText?`${effortText}${recommended?'（推荐）':''}`:'未选择'} min={0} max={Math.max(0,selected.efforts.length-1)} step={1} value={Math.max(0,index)} disabled={disabled||selected.efforts.length<2}
        onClick={()=>{if(index<0&&selected.efforts.length)onChange({...value,effort:selected.efforts[0]});}} onChange={event=>onChange({...value,effort:selected.efforts[Number(event.target.value)]})}/>
    </div>}
    {expanded&&<div className="model-picker-options" id={listId} role="group" aria-label="模型">
      {models.map(model=><button type="button" key={model.model} aria-pressed={model.model===selected.id} disabled={disabled} title={model.description||undefined} onClick={()=>choose(model.model)}><span>{modelDisplayName(model)}</span>{model.model===selected.id&&<Icon name="check" size={16}/>}</button>)}
    </div>}
    {status}
  </Popover>;
}

/** Only a model to choose: "keep the current one" first, then the runtime's list. Choosing closes it. */
function ModelList({point,anchor,models,value,disabled=false,onChange,close,currentLabel,label='选择模型',status}:PickerProps&{point:MenuPoint;anchor?:HTMLElement|null;close:()=>void}){
  const pick=(model:string)=>{onChange({model,effort:'',serviceTier:undefined});close();};
  return <Popover point={point} anchor={anchor} side="above" title={label} label={label} close={close} className="model-picker" focusSelector="button[aria-pressed=true]" showHeader={false}>
    <div className="model-picker-options plain" role="group" aria-label="模型">
      <button type="button" aria-pressed={!value.model} disabled={disabled} onClick={()=>pick('')}><span>{currentLabel?`沿用当前 · ${currentLabel}`:'沿用当前'}</span>{!value.model&&<Icon name="check" size={16}/>}</button>
      {models.map(model=><button type="button" key={model.model} aria-pressed={model.model===value.model} disabled={disabled} title={model.description||undefined} onClick={()=>pick(model.model)}><span>{modelDisplayName(model)}</span>{model.model===value.model&&<Icon name="check" size={16}/>}</button>)}
    </div>
    {status}
  </Popover>;
}

/** The toolbar's model button: the model, then details such as effort and the fast tier. */
export function ModelButton({label,details=[],expanded,disabled,open,ref}:{label:string;details?:string[];expanded:boolean;disabled:boolean;open:(point:MenuPoint)=>void;ref?:Ref<HTMLButtonElement>}){
  const text=[label,...details].join(' · ');
  return <button className="composer-model" ref={ref} type="button" aria-haspopup="dialog" aria-expanded={expanded} aria-label={`模型：${text}`} title={text} disabled={disabled}
    onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();open({x:rect.right,y:rect.top,align:'end'});}}>
    <span>{label}</span>{details.map(detail=><small key={detail}>{detail}</small>)}<Icon name="chevron" size={13}/></button>;
}

/** Button and picker together, for panels that keep the open state themselves. `unavailable` disables the button and closes the picker. */
export function ModelMenu({label:buttonLabel,details,unavailable=false,opened,title,...picker}:Omit<PickerProps,'label'>&{label:string;details?:string[];title?:string;unavailable?:boolean;opened?:()=>void}){
  const [point,setPoint]=useState<MenuPoint|null>(null),button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(unavailable)setPoint(null);},[unavailable]);
  return <>
    <ModelButton ref={button} label={buttonLabel} details={details} expanded={Boolean(point)} disabled={Boolean(picker.disabled)||unavailable} open={next=>{setPoint(next);opened?.();}}/>
    {point&&<ModelPicker {...picker} label={title} point={point} anchor={button.current} close={()=>setPoint(null)}/>}
  </>;
}
