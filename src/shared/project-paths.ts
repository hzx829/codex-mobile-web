export function windowsProjectPath(path:string):string {
  return path.replaceAll('/','\\').replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i,'');
}

/** The path belongs to the connector, so a phone's own platform does not determine how to compare it. */
export function projectPathKey(path:string):string {
  return /^(?:[a-z]:[\\/]|\\\\|\/\/\?\/)/i.test(path)
    ?`win:${windowsProjectPath(path).replace(/\\+$/,'').toLowerCase()}`
    :path;
}

/** Keeps the first spelling, so catalog roots can take precedence over paths found in sessions. */
export function mergeProjectPaths(paths:readonly string[]):string[] {
  const seen=new Set<string>();
  return paths.filter(path=>{
    if(!path)return false;
    const key=projectPathKey(path);
    if(seen.has(key))return false;
    seen.add(key);return true;
  });
}
