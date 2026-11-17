import { readFileSync,readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname,join } from 'node:path';
import { defineConfig,type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function pdfAssets():Plugin{
  const root=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const assets=new Map<string,string>(['cmaps','standard_fonts','wasm','iccs'].flatMap(folder=>readdirSync(join(root,folder)).map(name=>[`pdfjs/${folder}/${name}`,join(root,folder,name)] as const)));
  return {
    name:'pdf-assets',
    generateBundle(){for(const [fileName,path]of assets)this.emitFile({type:'asset',fileName,source:readFileSync(path)});},
    configureServer(server){
      server.middlewares.use((req,res,next)=>{
        const path=assets.get((req.url||'').split('?')[0].slice(1));
        if(!path)return next();
        res.setHeader('Content-Type',path.endsWith('.wasm')?'application/wasm':path.endsWith('.js')?'text/javascript':'application/octet-stream');
        res.end(readFileSync(path));
      });
    },
  };
}

export default defineConfig({ plugins: [react(),pdfAssets()], root: 'web', build: { outDir: '../dist', emptyOutDir: true } });
