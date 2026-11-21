import {useEffect,useState} from 'react';
import type {AntigravityModel} from '../src/shared/types';
import {ModelMenu} from './model-picker';

type Catalog = {models: AntigravityModel[]; current: string | null};
type Props = {
  read: ()=>Promise<Catalog>; turn: string; value: string; available:boolean; disabled: boolean; onChange: (id:string)=>void;
};
/** The shared model menu, fed from the desktop's model list; the list is read again each time it opens. */
export function AntigravityModelPicker({read,turn,value,available,disabled,onChange}: Props) {
  const [catalog,setCatalog] = useState<Catalog | null>(null), [error,setError] = useState('');
  const [refresh,setRefresh] = useState(0);
  useEffect(() => {
    if(!available)return;
    let active = true;
    setError('');
    read().then(result => {if (active) setCatalog(result);}).catch(failure => {
      if (active) {setCatalog(null);setError(failure?.message || '模型列表读取失败');}
    });
    return () => {active=false;};
  }, [read,turn,refresh,available]);
  const find = (id:string | null) => catalog?.models.find(model => model.id === id)?.label;
  const current = find(catalog?.current ?? null);
  const label = value ? find(value) || (catalog ? '所选模型已不可用' : '已选模型') : current ? `上轮 · ${current}` : '选择模型';
  return <ModelMenu label={label} title="选择 Antigravity 模型" tuning={false} disabled={disabled} unavailable={!available} opened={() => setRefresh(n => n+1)}
    models={(catalog?.models ?? []).map(model => ({model: model.id, displayName: model.label}))} value={{model: value, effort: ''}} current={{model: catalog?.current || undefined}}
    currentLabel={current ? `上轮 ${current}` : undefined} onChange={selection => onChange(selection.model)}
    status={error ? <p role="alert">{error} <button type="button" onClick={() => setRefresh(n => n+1)}>重试</button></p>
      : !catalog ? <p role="status">正在读取桌面模型…</p> : !catalog.models.length && <p role="status">桌面暂无可选模型</p>}/>;
}
