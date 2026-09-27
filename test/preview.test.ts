import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {fileReference,localDocumentLink,fileViewer} from '../web/preview-target.js';
import {parseTaskDiff,diffCounts,diffTokens} from '../web/diff.js';
import {DiffFileView} from '../web/diff-viewer.js';
import {CodeViewer} from '../web/code-viewer.js';
import {MarkdownViewer} from '../web/markdown-viewer.js';

test('file references preserve Windows paths, encoded spaces and source line locations',()=>{
  assert.deepEqual(fileReference('C:/work/My%20File.ts:12:3'),{path:'C:/work/My File.ts',line:12});
  assert.deepEqual(fileReference('src/main.ts#L25-L29'),{path:'src/main.ts',line:25});
  assert.deepEqual(fileReference(String.raw`D:\work\src\file.ts`),{path:String.raw`D:\work\src\file.ts`});
  assert.deepEqual(fileReference('/C:/Users/NINGMEI/Documents/delegate/codex-mobile-web/.local/config.json'),{path:'C:/Users/NINGMEI/Documents/delegate/codex-mobile-web/.local/config.json'});
  assert.deepEqual(fileReference('/D:/lingan/lyz-editor-backend/docs/features/organization/WORKSPACE_REVIEW_2026-09-26.md'),{path:'D:/lingan/lyz-editor-backend/docs/features/organization/WORKSPACE_REVIEW_2026-09-26.md'});
  assert.deepEqual(fileReference('/C:%5Cwork%5Cconfig.json#L3'),{path:String.raw`C:\work\config.json`,line:3});
  assert.equal(localDocumentLink('../src/app.ts:7','C:\\work\\docs\\README.md'),'C:/work/docs/../src/app.ts:7');
  assert.equal(localDocumentLink('images/a%20b.png','/work/docs/README.md'),'/work/docs/images/a b.png');
  assert.equal(localDocumentLink('D:/other/deck.pptx','C:/work/README.md'),'D:/other/deck.pptx');
  for(const url of ['https://example.com/a.png','//example.com/a.png','%2F%2Fexample.com/a.png','javascript:alert(1)','data:text/html,x','file:///C:/x','#section'])assert.equal(localDocumentLink(url,'C:/work/README.md'),null);
});

test('library diff preserves files and line numbers, highlights word edits and supports both layouts',()=>{
  const files=parseTaskDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -8,2 +8,2 @@\n // context\n-const count = 1;\n+const count = 2;\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n\\ No newline at end of file');
  assert.equal(files.length,2);assert.equal(files[0].newPath,'a.ts');assert.equal(files[1].oldPath,'old.txt');
  const context=files[0].hunks[0].changes[0];assert.equal(context.type,'normal');if(context.type==='normal')assert.equal(context.oldLineNumber,8);
  assert.deepEqual(diffCounts(files[0]),{added:1,removed:1});assert.equal(diffCounts(files[1]).removed,1);
  for(const split of [false,true]){
    const html=renderToStaticMarkup(createElement(DiffFileView,{file:files[0],split}));
    assert.match(html,split?/diff-split/:/diff-unified/);assert.match(html,/diff-code-edit/);assert.match(html,/token keyword/);assert.match(html,/>9<\/td>/);
  }
  assert.deepEqual(parseTaskDiff('Binary files differ'),[]);
  const huge={...files[0],hunks:[{...files[0].hunks[0],oldStart:1_000_000}]};assert.equal(diffTokens(huge),undefined);
});

test('binary files, rename-only changes and Git-quoted Chinese paths remain distinguishable',()=>{
  const binary=parseTaskDiff('diff --git a/photo.png b/photo.png\nindex abc..def 100644\nBinary files a/photo.png and b/photo.png differ\n');assert.equal(binary[0].isBinary,true);
  const renamed=parseTaskDiff('diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n');assert.equal(renamed[0].type,'rename');assert.equal(renamed[0].newPath,'new.ts');
  const quoted=parseTaskDiff('diff --git "a/hello world.ts" "b/hello world.ts"\n--- "a/hello world.ts"\n+++ "b/hello world.ts"\n@@ -1 +1 @@\n-a\n+b\n');assert.equal(quoted[0].newPath,'hello world.ts');
  const chinese=parseTaskDiff(String.raw`diff --git "a/\344\270\255.ts" "b/\344\270\255.ts"`+'\n'+String.raw`--- "a/\344\270\255.ts"`+'\n'+String.raw`+++ "b/\344\270\255.ts"`+'\n@@ -1 +1 @@\n-a\n+b\n');assert.equal(chinese[0].newPath,'中.ts');
});

test('file markdown renders GFM without executing HTML or interpreting chat directives',()=>{
  const file={path:'C:/work/docs/README.md',name:'README.md',mime:'text/plain',revision:'x',size:1,text:'# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[Code](../app.ts:9)\n\n![Remote](https://example.com/image.png)\n\n<script>evil()</script>\n\n::follow-up{prompt="send"}'};
  const html=renderToStaticMarkup(createElement(MarkdownViewer,{file,openFile:()=>{}}));
  assert.match(html,/<h1>Heading<\/h1>/);assert.match(html,/<table>/);assert.match(html,/class="inline-link"/);
  assert.doesNotMatch(html,/<script|<img|class="followup"/);assert.match(html,/follow-up/);
  assert.equal(fileViewer(file),'markdown');assert.equal(fileViewer({...file,name:'slides.pptx',text:undefined}),'unsupported');assert.equal(fileViewer({...file,name:'report.pdf',text:undefined}),'unsupported');
  const code=renderToStaticMarkup(createElement(CodeViewer,{text:'const html = "<script>alert(1)</script>";',name:'example.ts',line:1}));
  assert.match(code,/token keyword/);assert.doesNotMatch(code,/<script>/);assert.match(code,/selected-line/);
});
