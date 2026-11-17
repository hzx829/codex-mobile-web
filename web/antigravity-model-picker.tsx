import {useEffect, useRef, useState} from 'react';
import type {AntigravityModel} from '../src/shared/types';
import {Icon} from './icons';
import {Popover, type MenuPoint} from './popover';
import './model-picker.css';

type Catalog = {models: AntigravityModel[]; current: string | null};
type Props = {
  read: ()=>Promise<Catalog>; turn: string; value: string; disabled: boolean; onChange: (id:string)=>void;
};
export function AntigravityModelPicker({read,turn,value,disabled,onChange}: Props) {
  const [catalog,setCatalog] = useState<Catalog | null>(null), [error,setError] = useState('');
  const [refresh,setRefresh] = useState(0), [point,setPoint] = useState<MenuPoint | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    setError('');
    read().then(result => {if (active) setCatalog(result);}).catch(failure => {
      if (active) {setCatalog(null);setError(failure?.message || '模型列表读取失败');}
    });
    return () => {active=false;};
  }, [read,turn,refresh]);
  const find = (id:string | null) => catalog?.models.find(model => model.id === id)?.label;
  const current = find(catalog?.current ?? null);
  const label = value ? find(value) || (catalog ? '所选模型已不可用' : '已选模型') : current ? `上轮 · ${current}` : '选择模型';
  const options = [{id:'', label: current ? `沿用对话设置（上轮：${current}）` : '沿用对话设置'}, ...(catalog?.models ?? [])];
  return <>
    <button type="button" className="composer-model" ref={button} aria-haspopup="dialog" aria-expanded={Boolean(point)}
      aria-label={`选择模型，${label}`} disabled={disabled} onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPoint({x:rect.right,y:rect.top,align:'end'});
        setRefresh(n => n+1);
      }}><span>{label}</span><Icon name="chevron" size={13}/></button>
    {point && <Popover point={point} anchor={button.current} side="above" title="选择模型" label="选择 Antigravity 模型" close={()=>setPoint(null)} className="model-picker" focusSelector="button[aria-pressed=true]">
      <div className="model-picker-options">{options.map(option =>
        <button type="button" key={option.id} aria-pressed={value===option.id} disabled={disabled} onClick={() => {onChange(option.id);setPoint(null);}}>
          <span>{option.label}</span>{value===option.id && <Icon name="check" size={16}/>}
        </button>
      )}</div>
      {error ? <p role="alert">{error} <button type="button" onClick={()=>setRefresh(n=>n+1)}>重试</button></p>
        : !catalog ? <p role="status">正在读取桌面模型…</p> : !catalog.models.length && <p role="status">桌面暂无可选模型</p>}
    </Popover>}
  </>;
}
