import React, { useEffect, useState } from 'react';
import { apiClient, parseApiError } from '../services/api';
import { Button } from './ui/Button';

export function WechatSettingsPanel() {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [author, setAuthor] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [report, setReport] = useState<Awaited<ReturnType<typeof apiClient.verifyWechatAccount>> | null>(null);
  const canSave = typeof window.electron?.saveConfig === 'function';
  useEffect(() => {
    let active = true;
    void window.electron.getConfig().then(config => {
      if (!active) return;
      setAppId(config.wechatMp?.appId ?? '');
      setAuthor(config.wechatMp?.author ?? '');
      setHasSecret(config.wechatMp?.hasSecret === true);
    }).catch(() => { if (active) setMessage('读取配置失败，请重试'); });
    return () => { active = false; };
  }, []);
  const changed = () => { setDirty(true); setReport(null); setMessage(''); };
  const save = async () => {
    setBusy(true); setMessage(''); setReport(null);
    try {
      await window.electron.saveConfig!({ wechatMp: { appId, appSecret, author } });
      setHasSecret(Boolean(appSecret.trim()) || hasSecret);
      setAppSecret(''); setDirty(false);
      setMessage('配置已加密保存，立即生效；请校验连接。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setMessage(''); setReport(null);
    try { setReport(await apiClient.verifyWechatAccount()); }
    catch (error) { setMessage(parseApiError(error).message); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-xl border border-line bg-panel p-6">
    <h2 className="text-lg font-semibold text-ink">微信公众号 · 仅保存草稿</h2>
    <p className="text-sm text-ink-muted">不自动正式发布或群发。草稿完成后，由你在公众号后台检查并发布。</p>
    {canSave ? <>
      <label className="block text-sm text-ink">AppID<input value={appId} disabled={busy} onChange={event => { setAppId(event.target.value); changed(); }} className="mt-1 w-full rounded border border-line bg-well p-2" autoComplete="off" /></label>
      <label className="block text-sm text-ink">AppSecret<input type="password" value={appSecret} disabled={busy} onChange={event => { setAppSecret(event.target.value); changed(); }} placeholder={hasSecret ? '已保存；留空保留原密钥' : '填写公众号开发密钥'} className="mt-1 w-full rounded border border-line bg-well p-2" autoComplete="new-password" /></label>
      <label className="block text-sm text-ink">默认作者（可选）<input value={author} disabled={busy} onChange={event => { setAuthor(event.target.value); changed(); }} className="mt-1 w-full rounded border border-line bg-well p-2" /></label>
      <Button onClick={() => void save()} disabled={busy || !appId.trim() || (!hasSecret && !appSecret.trim())}>保存配置</Button>
    </> : <p className="text-sm text-ink-muted">独立后端请配置 WECHAT_MP_APP_ID / WECHAT_MP_APP_SECRET / WECHAT_MP_AUTHOR 并重启后端。本页面不在浏览器中保存密钥。</p>}
    <Button variant="outline" onClick={() => void verify()} disabled={busy || dirty}>校验连接（不上传内容）</Button>
    {dirty ? <p className="text-sm text-warning">先保存修改后的配置，再校验连接。</p> : null}
    <p className="text-sm text-ink-muted">微信开发者平台 → 我的业务 → 公众号 → 开发密钥 → API IP 白名单。换网络后可能需更新白名单；首次调用可能要求管理员确认。</p>
    {message ? <p role="status" className="text-sm text-ink">{message}</p> : null}
    {report ? <div role="status" className="space-y-2 text-sm">
      {([['凭据', report.credentials], ['IP 白名单', report.ipWhitelist], ['草稿数量查询', report.draftPermission]] as const).map(([label, item]) => <p key={label} className={item.ok ? 'text-success' : 'text-danger'}>{label}：{item.message}</p>)}
      <p className="text-ink-muted">连接通过不代表写入权限已验证；以首次真实草稿及后台检查结果为准。</p>
    </div> : null}
  </section>;
}
