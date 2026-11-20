import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diffSummary} from '../web/diff-summary.js';

test('the change card counts files and changed lines without header lines',()=>{
  const text='diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n a\n+b\n-c\ndiff --git a/b.ts b/b.ts\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+new\n';
  assert.deepEqual(diffSummary(text),{files:2,added:2,removed:1});
  assert.deepEqual(diffSummary('raw text'),{files:0,added:0,removed:0});
});
