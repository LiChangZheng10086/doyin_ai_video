import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeWechatSettings, publicWechatSettings, encryptWechatSettings, decryptWechatSettings } from './wechat-config';

test('公众号配置保留空白密钥编辑，换账号须显式给新密钥，公开配置不泄露密钥', () => {
  const existing = { appId: 'test-app-id', appSecret: 'fake-secret', author: '作者' };
  const next = mergeWechatSettings(existing, { appId: 'test-app-id', appSecret: '', author: '新作者' });
  assert.equal(next.appSecret, 'fake-secret');
  assert.deepEqual(publicWechatSettings(next), { appId: 'test-app-id', author: '新作者', hasSecret: true });
  assert.throws(() => mergeWechatSettings(existing, { appId: 'other-app-id' }), /密钥/);
  assert.throws(() => mergeWechatSettings(existing, { author: '人'.repeat(17) }), /16/);
});

test('公众号密钥必须加密，系统不可加密时拒绝保存而不降级明文', () => {
  const settings = { appId: 'test-app-id', appSecret: 'fake-secret' };
  assert.throws(() => encryptWechatSettings(settings, false, value => value), /加密/);
  const disk = encryptWechatSettings(settings, true, () => 'encrypted-test-value');
  assert.equal(disk.appSecret, 'safe:encrypted-test-value');
  assert.doesNotMatch(JSON.stringify(disk), /fake-secret/);
});

test('无法解密公众号配置时必须报错，不得返回空密钥供后续保存覆盖', () => {
  const disk = { appId: 'test-app-id', appSecret: 'safe:encrypted-test-value' };
  assert.equal(decryptWechatSettings(disk, true, () => 'fake-secret').appSecret, 'fake-secret');
  assert.throws(() => decryptWechatSettings(disk, false, () => 'fake-secret'), /解密/);
  assert.throws(() => decryptWechatSettings(disk, true, () => { throw new Error('sensitive internals'); }), /无法解密公众号密钥/);
  assert.throws(() => decryptWechatSettings({ appSecret: 'plaintext' }, true, value => value), /解密/);
  assert.equal(disk.appSecret, 'safe:encrypted-test-value');
});
