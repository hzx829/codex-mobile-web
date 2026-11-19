import {useEffect,useRef,useState} from 'react';
import {operationId} from './client';
import type {Json,RequestAction} from '../src/shared/types';

type Props={folder:string;connected:boolean;call:(action:RequestAction,payload?:Json)=>Promise<any>;done:()=>void};
type Settings={claudeMd:string;instructions:string|null;mcpFile:string;mcpServers:string;memoryDir:string;memoryIndex:string;memoryFiles:string[];revision:string};

export function GuestProjectForm({connected, call, select}: {
  connected: boolean;
  call: Props['call'];
  select: (path: string) => void;
}) {
  const [name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(true),pending=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function create(){
    if(pending.current||!connected||!name.trim())return;
    pending.current=true;setBusy(true);setError('');
    try {
      const result=await call('project.create',{name,opId:operationId()});
      if(!alive.current)return;
      if(result.state!=='accepted'||typeof result.path!=='string')throw Error(result.error?.message||'结果待核实，请刷新项目列表。');
      setName('');select(result.path);
    }catch(failure){if(alive.current)setError((failure as Error).message||'无法新建项目');}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  return <form onSubmit={event=>{event.preventDefault();void create();}}>
    <label>项目名称<input value={name} onChange={event=>setName(event.target.value)} maxLength={80} required disabled={busy}/></label>
    {error&&<p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={!connected||busy||!name.trim()}>{busy?'正在创建…':'新建项目'}</button>
  </form>;
}

/**
 * A Claude Code project is a folder; its settings are Claude Code's own files there,
 * so the terminal and the desktop app use the same instructions and MCP servers.
 */
export function ClaudeProjectEditor({folder,connected,call,done}:Props){
  const [settings,setSettings]=useState<Settings|null>(null),[instructions,setInstructions]=useState(''),[mcp,setMcp]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),request=useRef(call);request.current=call;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!folder||!connected)return;
    request.current('claude.project.get',{folder}).then(({project}:{project:Settings})=>{
      if(!alive.current)return;
      setSettings(project);setInstructions(project.instructions??'');setMcp(project.mcpServers);
    }).catch((e:any)=>{if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用项目设置。':e?.message||'读取项目设置失败');});
  },[folder,connected]);
  async function save(){
    if(busy||!connected||!settings)return;
    setBusy(true);setError('');
    try{
      const result=await request.current('claude.project.save',{folder,revision:settings.revision,opId:operationId(),
        instructions:settings.instructions===null?null:instructions,
        // Only a changed MCP text is sent, so a broken .mcp.json does not block editing CLAUDE.md.
        mcpServers:mcp===settings.mcpServers?null:mcp});
      if(!alive.current)return;
      if(result.state==='accepted')done();
      else setError(result.error?.message||'结果待核实，请重新打开项目设置查看。');
    }catch(e:any){if(alive.current)setError(e?.code==='unsupported'?'请更新这台电脑上的连接器以使用项目设置。':e?.message||'保存失败');}
    finally{if(alive.current)setBusy(false);}
  }
  if(!settings)return error?<p className="error" role="alert">{error}</p>:<div className="list-skeleton" role="status" aria-label="正在读取项目设置"><div/><div/></div>;
  return <form className="claude-project-form" onSubmit={e=>{e.preventDefault();void save();}}>
    <p className="muted claude-project-path">{folder}</p>
    {settings.instructions===null?<p className="muted">CLAUDE.md 太长，请在电脑上编辑：{settings.claudeMd}</p>:
      <label>项目说明（CLAUDE.md）<textarea rows={8} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="每个会话都会读取的说明，例如代码规范、回答语言"/></label>}
    <details open={Boolean(mcp)}><summary>MCP 服务器（.mcp.json）</summary>
      <textarea rows={6} spellCheck={false} aria-label="MCP 服务器配置" value={mcp} onChange={e=>setMcp(e.target.value)} placeholder={'{"files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\\\docs"]}}'}/>
      <p className="muted">新加的服务器会同时在 .claude/settings.local.json 里启用。</p></details>
    <details><summary>记忆{settings.memoryFiles.length?`（${settings.memoryFiles.length} 条）`:''}</summary>
      {settings.memoryIndex?<pre className="claude-memory">{settings.memoryIndex}</pre>:<p className="muted">还没有记忆。Claude Code 会在会话中自动记下值得长期保留的内容。</p>}
      {settings.memoryDir&&<p className="muted">记忆目录：{settings.memoryDir}</p>}</details>
    <p className="muted">修改会在会话下次启动时生效，终端和桌面 App 里的 Claude Code 也会用到。</p>
    {error&&<p className="error" role="alert">{error}</p>}
    <button className="primary" disabled={busy||!connected}>{busy?'正在保存…':'保存'}</button>
  </form>;
}
