import assert from 'node:assert/strict';
import {test} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';

test('ordinary browser explains desktop-only browsing and does not imply a working embedded player',async()=>{
  const page=await import('./YoutubePage.js').catch(()=>null);assert.ok(page,'油管页面尚未实现');
  (globalThis as any).React=React;
  const html=renderToStaticMarkup(<MemoryRouter><page.YoutubePage/></MemoryRouter>);
  assert.match(html,/请在桌面版打开油管浏览页/);assert.match(html,/采集当前视频/);assert.match(html,/不会自动下载或转录/);
  assert.doesNotMatch(html,/<iframe|<webview/);
});
