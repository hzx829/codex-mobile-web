import {useEffect,useRef,useState} from 'react';
import {operationId} from './client';
import type {Json,RequestAction} from '../src/shared/types';

/** True for a configured Claude Code project id; folder groups use the folder path instead. */
export const isClaudeProject=(id:string)=>/^p_[0-9a-f]{16}$/.test(id);

type Props={projectId:string;connected:boolean;call:(action:RequestAction,payload?:Json)=>Promise<any>;
  /** Called after a save (with the project id) or a delete (with ''). */
  done:(projectId:string)=>void};
type Form={name:string;folders:string;instructions:string;memoryDir:string;mcpServers:string};
const empty:Form={name:'',folders:'',instructions:'',memoryDir:'',mcpServers:''};

/** Creates or edits a Claude Code project: folders, standing instructions, memory folder and MCP servers. */
export function ClaudeProjectEditor({projectId,connected,call,done}:Props){
  const [form,setForm]=useState<Form>(empty),[loaded,setLoaded]=useState(!projectId),[sessions,setSessions]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),request=useRef(call);request.current=call;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!projectId||!connected)return;
    request.current('claude.project.get',{projectId}).then(({project}:Json)=>{
      if(!alive.current)return;
      setForm({name:project.name,folders:project.folders.join('\n'),instructions:project.instructions,memoryDir:project.memoryDir,
        mcpServers:Object.keys(project.mcpServers||{}).length?JSON.stringify(project.mcpServers,null,2):''});
      setSessions(project.sessions||0);setLoaded(true);
    }).catch((e:any)=>{if(alive.current)setError(e?.message||'读取项目失败');});
  },[projectId,connected]);
  const set=(key:keyof Form)=>(e:{target:{value:string}})=>setForm(old=>({...old,[key]:e.target.value}));
  async function run(action:'claude.project.save'|'claude.project.delete',payload:Json){
    if(busy||!connected)return;
    setBusy(true);setError('');
    try{
      const result=await request.current(action,{...payload,opId:operationId()});
      if(!alive.current)return;
      if(result.state==='accepted')done(action==='claude.project.delete'?'':result.projectId);
      else setError(result.error?.message||'结果待核实，请刷新项目列表查看。');
    }catch(e:any){if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用项目。':e?.message||'保存失败');}
    finally{if(alive.current)setBusy(false);}
  }
  function save(){
    const folders=form.folders.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    void run('claude.project.save',{...(projectId?{projectId}:{}),name:form.name,folders,instructions:form.instructions,memoryDir:form.memoryDir,mcpServers:form.mcpServers});
  }
  function remove(){
    if(window.confirm(`删除项目“${form.name}”？会话不会被删除，会回到各自的文件夹分组。`))void run('claude.project.delete',{projectId});
  }
  if(!loaded)return error?<p className="error" role="alert">{error}</p>:<div className="list-skeleton" role="status" aria-label="正在读取项目"><div/><div/></div>;
  return <form className="claude-project-form" onSubmit={e=>{e.preventDefault();save();}}>
    <label>名称<input autoFocus={!projectId} required maxLength={200} value={form.name} onChange={set('name')} placeholder="例如 官网改版"/></label>
    <label>文件夹<textarea required rows={3} value={form.folders} onChange={set('folders')} placeholder={'电脑上的完整路径，每行一个\n第一个是工作目录'}/></label>
    <label>项目说明<textarea rows={5} maxLength={20000} value={form.instructions} onChange={set('instructions')} placeholder="每个会话都会带上的说明，例如代码规范、回答语言"/></label>
    <label>记忆目录<input value={form.memoryDir} onChange={set('memoryDir')} placeholder="可选，例如 D:\notes\site-memory"/></label>
    <p className="muted">会话启动时读取记忆目录里的 MEMORY.md 作为索引，Claude 也可以把新记忆写进去。</p>
    <details open={Boolean(form.mcpServers)}><summary>MCP 服务器（JSON，可选）</summary>
      <textarea rows={6} spellCheck={false} value={form.mcpServers} onChange={set('mcpServers')} placeholder={'{"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\\\docs"]}}'}/></details>
    {projectId&&<p className="muted">已有 {sessions} 个会话。修改会在会话下次启动时生效。</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={busy||!connected}>{busy?'正在保存…':projectId?'保存':'创建项目'}</button>
    {projectId&&<button type="button" className="danger-link" disabled={busy||!connected} onClick={remove}>删除项目</button>}
  </form>;
}
