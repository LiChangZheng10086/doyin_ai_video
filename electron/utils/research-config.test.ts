import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeResearchSettings } from './research-config.js';
test('research defaults to disabled and partial settings preserve unrelated switches',()=>{
  assert.deepEqual(mergeResearchSettings(),{jinaEnabled:false,exaEnabled:false});
  assert.deepEqual(mergeResearchSettings({jinaEnabled:true,exaEnabled:true},{jinaEnabled:false}),{jinaEnabled:false,exaEnabled:true});
  assert.throws(()=>mergeResearchSettings(undefined,{exaEnabled:'yes'} as any),/布尔/);
  assert.throws(()=>mergeResearchSettings(undefined,{endpoint:'https://evil.example'} as any),/字段/);
});
