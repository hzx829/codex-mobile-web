import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,normalize} from 'node:path';
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
