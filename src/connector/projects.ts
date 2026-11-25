import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,normalize} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {projectPathKey,windowsProjectPath} from '../shared/project-paths.js';
import {BridgeError,type Json} from '../shared/types.js';

export interface Project {id?:string;path:string;name:string;roots?:string[];recencyAt?:number|null}
export function projectCatalog(state:Json,config:Json):Project[] {
  const projects:Project[]=[],seen=new Set<string>();
  function add(path:unknown,label?:unknown) {
    if(typeof path!=='string'||!isAbsolute(path))return;
    const key=process.platform==='win32'?projectPathKey(normalize(path)):normalize(path);
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
export async function runtimeProjects(rpc:(method:string,params?:Json,timeoutMs?:number)=>Promise<Json>):Promise<Project[]> {
  const projects:Project[]=[],seen=new Set<string>();
  let cursor:string|null=null;
  for(let page=0;page<20;page++){
    const res=await rpc('project/list',{limit:100,sortKey:'position',...(cursor?{cursor}:{})},8000);
    const data:Json[]=Array.isArray(res?.data)?res.data:[];
    for(const item of data){
      if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id))continue;
      const roots=(Array.isArray(item.roots)?item.roots:[])
        .map((r:Json)=>typeof r?.path==='string'?r.path:'')
        .filter((p:string)=>Boolean(p)&&isAbsolute(p));
      if(!roots.length)continue;
      seen.add(item.id);
      const path=roots[0];
      const name=typeof item.name==='string'&&item.name.trim()?item.name.trim():path.split(/[\\/]/).filter(Boolean).at(-1)||path;
      projects.push({
        id:item.id,
        path,
        name,
        ...(roots.length>1?{roots}:{}),
        ...(item.recencyAt===null||typeof item.recencyAt==='number'?{recencyAt:item.recencyAt}:{}),
      });
    }
    cursor=typeof res?.nextCursor==='string'&&res.nextCursor?res.nextCursor:null;
    if(!cursor)break;
  }
  return projects;
}
export async function nativeProjects(config:Json,home=process.env.CODEX_HOME||join(homedir(),'.codex')) {
  let state:Json={};
  try{state=JSON.parse(await readFile(join(home,'.codex-global-state.json'),'utf8'));}
  catch(e:any){if(e.code!=='ENOENT')throw new BridgeError('project_index','Codex 项目列表暂时无法读取，请稍后刷新');}
  return projectCatalog(state,config);
}

export function indexedProjectPaths(home=process.env.CODEX_HOME||join(homedir(),'.codex')): string[] {
  const db=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
  try {return db.prepare('SELECT DISTINCT cwd FROM threads WHERE cwd IS NOT NULL ORDER BY cwd').all().map(row=>String(row.cwd));}
  finally {db.close();}
}

function cwdAliases(path:string):string[] {
  const cwd=normalize(process.platform==='win32'?windowsProjectPath(path):path);
  let other=cwd;
  if(process.platform==='win32'){
    if(/^[a-z]:\\/i.test(cwd))other='\\\\?\\'+cwd;
    else if(/^\\\\[^?.]/.test(cwd))other='\\\\?\\UNC\\'+cwd.slice(2);
  }
  return other===cwd?[cwd]:[cwd,other];
}

export function indexedSessions(options:{cwd?:string;roots?:string[];projectId?:string;archived:boolean;search?:string;cursor?:string},home=process.env.CODEX_HOME||join(homedir(),'.codex')) {
  const offset=options.cursor?Number(/^db:(\d+)$/.exec(options.cursor)?.[1]):0;
  if(!Number.isSafeInteger(offset)||offset<0)throw new BridgeError('invalid','会话分页标识无效');
  const db=new DatabaseSync(join(home,'state_5.sqlite'),{readOnly:true});
  try {
    const where=["archived = ?","COALESCE(NULLIF(name,''),NULLIF(title,''),NULLIF(preview,'')) IS NOT NULL"],args:any[]=[options.archived?1:0];
    const hasProjectIdCol=options.projectId?db.prepare('PRAGMA table_info(threads)').all().some(col=>col.name==='project_id'):false;
    const filterPaths=[...(options.roots||[]),...(options.cwd?[options.cwd]:[])].filter(Boolean);
    const uniqueAliases=[...new Set(filterPaths.flatMap(cwdAliases))];
    if(hasProjectIdCol&&options.projectId&&uniqueAliases.length){
      const cwdMatch=uniqueAliases.map(()=>'cwd = ? COLLATE NOCASE').join(' OR ');
      where.push(`(project_id = ? OR (project_id IS NULL AND (${cwdMatch})))`);
      args.push(options.projectId,...uniqueAliases);
    }else if(hasProjectIdCol&&options.projectId){
      where.push('project_id = ?');args.push(options.projectId);
    }else if(uniqueAliases.length){
      const cwdMatch=uniqueAliases.map(()=>'cwd = ? COLLATE NOCASE').join(' OR ');
      where.push(`(${cwdMatch})`);args.push(...uniqueAliases);
    }
    if(options.search){where.push("instr(COALESCE(NULLIF(name,''),NULLIF(title,''),preview,''), ?) > 0");args.push(options.search);}
    const rows=db.prepare(`SELECT id,COALESCE(NULLIF(name,''),NULLIF(title,''),preview,'') AS title,cwd,model,model_provider AS provider,updated_at AS updatedAt
      FROM threads WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT 31 OFFSET ?`).all(...args,offset) as Json[];
    return {data:rows.slice(0,30).map(row=>({id:row.id,title:String(row.title||'新会话').slice(0,100),cwd:row.cwd||'',model:row.model||'',provider:row.provider,updatedAt:row.updatedAt})),nextCursor:rows.length>30?`db:${offset+30}`:null};
  } finally {db.close();}
}
