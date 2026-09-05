import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBatches } from '../lib/query.js';
test('GO parsing respects strings, escaped identifiers, nested comments and repeats',()=>{
  const script="SELECT N'a\nGO\nb';\nGO\n/* outer\n/* nested */\nGO\n*/\nSELECT [a]]b]; -- GO\nGO 2 -- repeat\nSELECT 3;";
  const parts=splitBatches(script);
  assert.equal(parts.length,4);assert.match(parts[0].text,/GO/);assert.equal(parts[1].text,parts[2].text);assert.equal(parts[3].text,'SELECT 3;');
  assert.throws(()=>splitBatches('SELECT 1\nGO 101'));
});
