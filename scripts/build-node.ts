import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
await build({entryPoints:{relay:'src/server/main.ts',connector:'src/connector/main.ts',setup:'scripts/setup.ts','session-cli':'src/cli/session-cli.ts'},outdir:'build',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',target:'node22',format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},external:['bufferutil','utf-8-validate'],legalComments:'linked',logLevel:'info'});
// Desktop window of the Windows tray app: a static page loaded from build/desktop by WebView2.
await build({entryPoints:['desktop/main.ts'],outfile:'build/desktop/app.js',bundle:true,platform:'browser',target:'chrome120',format:'iife',minify:true,legalComments:'linked',logLevel:'info'});
for(const name of ['index.html','style.css'])await copyFile(`desktop/${name}`,`build/desktop/${name}`);
