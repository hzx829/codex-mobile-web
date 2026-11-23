import {useRef,useState,type Ref} from 'react';
import {Icon} from './icons';
import {Popover,type MenuPoint} from './popover';

/** One permission level a runtime offers; `elevated` levels skip approvals and show in orange. */
export type PermissionOption={id:string;label:string;description:string;elevated?:boolean};
/** What the session uses now: an option id when known, and its name. */
export type CurrentPermission={id:string;label:string};

const active=(options:PermissionOption[],value:string,current:CurrentPermission)=>options.find(option=>option.id===(value||current.id));

/** The toolbar's shield: the level the next message uses. */
export function PermissionButton({options,value,current,expanded,disabled,open,ref}:{options:PermissionOption[];value:string;current:CurrentPermission;expanded:boolean;disabled:boolean;open:(point:MenuPoint)=>void;ref?:Ref<HTMLButtonElement>}){
  const label=value?active(options,value,current)?.label||value:current.label;
  return <button type="button" ref={ref} className={`composer-permission${active(options,value,current)?.elevated?' unrestricted':''}`} aria-haspopup="dialog" aria-expanded={expanded}
    aria-label={`许可：${label}`} title={`许可：${label}`} disabled={disabled} onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();open({x:rect.left,y:rect.top});}}>
    <Icon name="shield" size={17}/><span>{label}</span></button>;
}

/**
 * The runtime's levels, each with what it means, the one in use checked, as Claude Code's own mode menu lists them.
 * Choosing the level the session already uses clears the choice. A current level that is not one of the options
 * (Codex left to the computer's configuration) is listed first so it can be chosen again.
 */
export function PermissionPicker({point,anchor,options,value,current,title='模式',disabled=false,onChange,close}:{point:MenuPoint;anchor?:HTMLElement|null;options:PermissionOption[];value:string;current:CurrentPermission;title?:string;disabled?:boolean;onChange:(id:string)=>void;close:()=>void}){
  const pick=(id:string)=>{onChange(id===current.id?'':id);close();};
  const chosen=value||current.id;
  const rows=options.some(option=>option.id===current.id)?options:[{id:current.id,label:current.label,description:current.id?'会话现在的设置':'使用电脑上的配置'},...options];
  return <Popover point={point} anchor={anchor} side="above" title={title} label={title} close={close} className="model-picker permission-picker" focusSelector="button[aria-pressed=true]" showHeader={false}>
    <p className="permission-picker-title">{title}</p>
    <div className="model-picker-options plain" role="group" aria-label={title}>
      {rows.map(option=><button type="button" key={option.id} className={option.elevated?'elevated':''} aria-pressed={chosen===option.id} disabled={disabled} onClick={()=>pick(option.id)}>
        <span>{option.label}<small>{option.description}</small></span>{chosen===option.id&&<Icon name="check" size={16}/>}</button>)}
    </div>
  </Popover>;
}

/** Button and picker together, for panels that keep the open state themselves. */
export function PermissionMenu(props:{options:PermissionOption[];value:string;current:CurrentPermission;disabled:boolean;onChange:(id:string)=>void}){
  const [point,setPoint]=useState<MenuPoint|null>(null),button=useRef<HTMLButtonElement>(null);
  return <>
    <PermissionButton ref={button} options={props.options} value={props.value} current={props.current} expanded={Boolean(point)} disabled={props.disabled} open={setPoint}/>
    {point&&<PermissionPicker {...props} point={point} anchor={button.current} close={()=>setPoint(null)}/>}
  </>;
}
