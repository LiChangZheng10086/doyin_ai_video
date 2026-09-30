import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAudioTracks, parseAudioMedia, validateAudioUrl, publicAudioAddress } from './online-audio-sources.js';

test('official NetEase and QQ chart/search shapes retain source IDs, duration and rank', () => {
  const song = { id: 123, name: 'Test', artists: [{ name: 'Artist' }], duration: 120000 };
  assert.equal(parseAudioTracks('netease', { code: 200, result: { tracks: [song] } }, true)[0].rank, 1);
  assert.equal(parseAudioTracks('netease', { code: 200, result: { songs: [song] } }, false)[0].durationMs, 120000);
  const qqSong = { id: 456, mid: 'abc123', title: 'Test QQ', singer: [{ name: 'Artist' }], interval: 90 };
  assert.equal(parseAudioTracks('qq', { code: 0, req: { code: 0, data: { songInfoList: [qqSong] } } }, true)[0].key, 'qq:abc123');
  assert.equal(parseAudioTracks('qq', { code: 0, req: { code: 0, data: { body: { song: { list: [qqSong] } } } } }, false)[0].rank, undefined);
  assert.throws(() => parseAudioTracks('qq', { code: 0, req: { code: 0, data: {} } }, false), /格式/);
  assert.deepEqual(parseAudioTracks('netease', { code: 200, result: { songs: [] } }, false), []);
});

test('player metadata distinguishes trials, unavailable tracks, and source-bound HTTPS URLs', () => {
  const media = parseAudioMedia('netease', { code: 200, data: [{ id: 123, url: 'http://m701.music.126.net/audio.mp3', type: 'mp3', freeTrialInfo: { start: 10, end: 30 } }] }, '123');
  assert.equal(media.previewOnly, true);
  assert.equal(new URL(media.url).protocol, 'https:');
  assert.throws(() => parseAudioMedia('netease', { code: 200, data: [{ id: 123, url: null }] }, '123'), /会员|暂不可用/);
  assert.throws(() => parseAudioMedia('netease', { code: 200, data: [{ id: 124, url: 'https://m701.music.126.net/a.mp3', type: 'mp3' }] }, '123'), /暂不可用/);
  const qq = parseAudioMedia('qq', { req: { code: 0, data: { sip: ['http://ws.stream.qqmusic.qq.com/'], midurlinfo: [{ songmid: 'abc123', purl: 'M500abc123.mp3' }] } } }, 'abc123');
  assert.equal(qq.extension, 'mp3');
  assert.equal(qq.previewOnly, false);
  const cdn = parseAudioMedia('qq', { req: { code: 0, data: { sip: ['http://aqqmusic.tc.qq.com/'], midurlinfo: [{ songmid: 'abc123', purl: 'C400abc123.m4a' }] } } }, 'abc123');
  assert.equal(new URL(cdn.url).hostname, 'aqqmusic.tc.qq.com');
  assert.equal(cdn.extension, 'm4a');
});

test('remote boundary rejects local addresses, unexpected hosts, credentials and ports', () => {
  for (const url of ['http://music.163.com/api/test', 'https://music.163.com.evil.test/a', 'https://user@music.163.com/a', 'https://music.163.com:8443/a', 'https://127.0.0.1/a']) {
    assert.throws(() => validateAudioUrl(url, 'netease', 'metadata'));
  }
  assert.throws(() => validateAudioUrl('https://u.y.qq.com/a', 'netease', 'metadata'));
  validateAudioUrl('https://m701.music.126.net/a.mp3', 'netease', 'media');
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.1.2', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) assert.equal(publicAudioAddress(ip), false, ip);
  assert.equal(publicAudioAddress('8.8.8.8'), true);
  assert.equal(publicAudioAddress('2606:4700:4700::1111'), true);
});
