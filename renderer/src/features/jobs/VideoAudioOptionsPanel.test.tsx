import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoAudioOptionsPanel } from './VideoAudioOptionsPanel.js';

test('saved narration can be turned off even when local speech capability is unavailable or loading',()=>{
  const render=(voiceover:boolean)=>renderToStaticMarkup(<VideoAudioOptionsPanel value={{voiceover}} onChange={()=>{}} disabled={false} canRegenerate={false} onRegenerate={()=>{}}/>).match(/<input[^>]+type="checkbox"[^>]*>/)?.[0]??'';
  assert.doesNotMatch(render(true),/disabled/);
  assert.match(render(false),/disabled/);
});
