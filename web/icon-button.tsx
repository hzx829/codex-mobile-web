import {Icon,type IconName} from './icons';
export function IconButton({icon,label,onClick,disabled=false,className=''}:{icon:IconName;label:string;onClick:()=>void;disabled?:boolean;className?:string}){return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon name={icon}/></button>;}
