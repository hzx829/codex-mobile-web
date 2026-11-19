import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement as h,Fragment} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {markdownBlocks} from '../web/markdown-blocks.js';

const pad='一段足够长的说明文字，用来让分块生效。Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(5);
const render=(blocks:string[])=>renderToStaticMarkup(h(Fragment,null,...blocks.map((block,index)=>h(Markdown,{key:index,remarkPlugins:[remarkGfm]},block))))
  // Only the newline text between top-level blocks differs; browsers collapse it.
  .replace(/>\n+/g,'>').replace(/\n+</g,'<');

test('rendering a reply block by block matches rendering it whole',()=>{
  const samples=[
    `# 标题\n\n${pad}\n\n## 小节\n\n- 一\n- 二\n\n${pad}\n\n\`\`\`ts\nconst a=1;\n\nconst b=2;\n\`\`\`\n\n结尾 ${pad}`,
    `${pad}\n\n1. 第一步\n\n   继续说明\n\n   \`\`\`bash\n   npm test\n\n   npm run build\n   \`\`\`\n\n2. 第二步\n\n${pad}`,
    `| a | b |\n|---|---|\n| 1 | 2 |\n\n${pad}\n\n> 引用一\n\n> 引用二\n\n---\n\n${pad}`,
    `${pad}\n\n* 项目\n\n* 项目二\n\n  - 嵌套\n\n${pad}\n\n~~~\ncode\n\n~~~\n\nEnd ${pad}`,
    `${pad}\n\n\`\`\`\nunterminated fence\n\nstill code ${pad}`,
    `${pad}\n\n    indented code\n\n    more\n\nafter ${pad}`,
    `Title\n=====\n\n${pad}\n\n<div>html</div>\n\n${pad}`,
    `${pad}\n\n\`\`\`\`md\n\`\`\`js\nx\n\`\`\`\n\nstill inside\n\`\`\`\`\n\noutside ${pad}`,
    `${pad}\n\n\`\`\`inline\` is not a fence\n\nparagraph ${pad}`,
  ];
  for(const text of samples){
    const blocks=markdownBlocks(text);
    assert.ok(blocks.length>1,'The sample is split.');
    assert.equal(blocks.join('\n'),text,'Blocks keep every line.');
    assert.equal(render(blocks),render([text]));
  }
});

test('short replies and documents with link definitions stay whole',()=>{
  assert.deepEqual(markdownBlocks('a\n\nb'),['a\n\nb']);
  const withDefinition=`${pad}\n\nSee [doc][1].\n\n[1]: https://example.com`;
  assert.deepEqual(markdownBlocks(withDefinition),[withDefinition]);
});

test('a growing reply keeps its finished blocks unchanged',()=>{
  const finished=`${pad}\n\n## 小节\n\n${pad}`;
  const before=markdownBlocks(`${finished}\n\n正在写`),after=markdownBlocks(`${finished}\n\n正在写更多内容`);
  assert.deepEqual(before.slice(0,-1),after.slice(0,-1));
});
