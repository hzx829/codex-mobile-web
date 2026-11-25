import {useState,type ReactNode} from 'react';
import {Icon} from './icons';
import {MenuItem,SheetPanel} from './sheet';
import {workspaceName} from './chat-layout';

export type PickerProject={id:string;path:string;name?:string};

/**
 * The new-chat project choice: one centered "📁 name ⌄" button that opens a bottom sheet listing projects with their
 * paths, plus a way to add one. Replaces the native select, which Android renders as a clipped system dialog.
 * `footer` receives `close` so an inline form in the sheet can dismiss it after choosing.
 */
export function ProjectPicker({projects,value,label,empty,disabled=false,onSelect,onCreate,createDisabled=false,footer}:{
  projects:PickerProject[]|null;
  value:string;
  /** Text on the button: the chosen project's name, or a prompt when none is chosen. */
  label:string;
  /** Shown in the sheet when there is no project to list. */
  empty:string;
  disabled?:boolean;
  onSelect:(id:string)=>void;
  onCreate?:()=>void;
  createDisabled?:boolean;
  footer?:(close:()=>void)=>ReactNode;
}){
  const [open,setOpen]=useState(false);
  const close=()=>setOpen(false);
  return <>
    <button type="button" className="center-project" aria-haspopup="dialog" aria-expanded={open} aria-label={`项目：${label}，更换项目`} disabled={disabled} onClick={()=>setOpen(true)}>
      <Icon name="folder"/><span>{label}</span><Icon name="chevron" size={17}/>
    </button>
    {open&&<SheetPanel title="选择项目" close={close}>
      <div className="project-choices">
        {projects?.length?projects.map(item=><MenuItem icon="folder" key={item.id} onClick={()=>{close();onSelect(item.id);}}>
          <span>{item.name||workspaceName(item.path)}<small>{item.path}</small></span>{item.id===value&&<Icon name="check" size={18}/>}
        </MenuItem>):<p className="muted project-choices-empty">{empty}</p>}
      </div>
      {onCreate&&<MenuItem icon="plus" disabled={createDisabled} onClick={()=>{close();onCreate();}}>新建或关联项目</MenuItem>}
      {footer?.(close)}
    </SheetPanel>}
  </>;
}
