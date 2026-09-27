import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,normalize} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BridgeError,type Json} from '../shared/types.js';

export interface Project {path:string;name:string}
export function projectCatalog(state:Json,config:Json):Project[] {
  const projects:Project[]=[],seen=new Set<string>();
  function add(path:unknown,label?:unknown) {
    if(typeof path!=='string'||!isAbsolute(path))return;
    const key=process.platform==='win32'?normalize(path).toLowerCase():normalize(path);
    if(seen.has(key))return;seen.add(key);
    projects.push({path,name:typeof label==='string'&&label?label:path.split(/[\\/]/).filter(Boolean).at(-1)||path});
  }
  const saved=state['local-projects']||{},ids=[...new Set([...(Array.isArray(state['project-order'])?state['project-order']:[]),...Object.keys(saved)])];
  for(const id of ids){const p=saved[id];if(Array.isArray(p?.rootPaths))for(const path of p.rootPaths)add(path,p.name);}
  // Newer desktops migrate and rename projects; do not resurrect their stale legacy roots.
  if(!projects.length)for(const path of state['electron-saved-workspace-roots']||[])add(path,state['electron-workspace-root-labels']?.[path]);
  for(const path of Object.keys(config.projects||{}))add(path);
  return projects;
}
export async function nativeProjects(config:Json,home=process.env.CODEX_HOME||join(homedir(),'.codex')) {
  let state:Json={};
  try{state=JSON.parse(await readFile(join(home,'.codex-global-state.json'),'utf8'));}
  catch(e:any){if(e.code!=='ENOENT')throw new BridgeError('project_index','Codex 项目列表暂时无法读取，请稍后刷新');}
  return projectCatalog(state,config);
}

export function indexedSessions(options:{cwd?:string;archived:boolean;search?:string;cursor?:string},home=process.env.CODEX_HOME||join(homedir(),'.codex')) {
  const offset=options.cursor?Number(/^db:(\d+)$/.exec(options.cursor)?.[1]):0;
  if(!Number.isSafeInteger(offset)||offset<0)throw new BridgeError('invalid','会话分页标识无效');
  const db=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
  try {
    const where=["archived = ?","COALESCE(NULLIF(name,''),NULLIF(title,''),NULLIF(preview,'')) IS NOT NULL"],args:any[]=[options.archived?1:0];
    if(options.cwd){
      const cwd=normalize(options.cwd),other=process.platform==='win32'?(cwd.startsWith('\\\\?\\')?cwd.slice(4):'\\\\?\\'+cwd):cwd;
      where.push('(cwd = ? COLLATE NOCASE OR cwd = ? COLLATE NOCASE)');args.push(cwd,other);
    }
    if(options.search){where.push("instr(COALESCE(NULLIF(name,''),NULLIF(title,''),preview,''), ?) > 0");args.push(options.search);}
    const rows=db.prepare(`SELECT id,COALESCE(NULLIF(name,''),NULLIF(title,''),preview,'') AS title,cwd,model,model_provider AS provider,updated_at AS updatedAt
      FROM threads WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT 31 OFFSET ?`).all(...args,offset) as Json[];
    return {data:rows.slice(0,30).map(row=>({id:row.id,title:String(row.title||'新会话').slice(0,100),cwd:row.cwd||'',model:row.model||'',provider:row.provider,updatedAt:row.updatedAt})),nextCursor:rows.length>30?`db:${offset+30}`:null};
  } finally {db.close();}
}
