export interface WechatSettings {
  appId?: string;
  appSecret?: string;
  author?: string;
}

export function mergeWechatSettings(existing: WechatSettings = {}, changes: WechatSettings): WechatSettings {
  for (const value of [changes.appId, changes.appSecret, changes.author]) {
    if (value !== undefined && typeof value !== 'string') throw new Error('公众号配置必须为文本');
  }
  const appId = changes.appId?.trim() ?? existing.appId;
  const appSecret = changes.appSecret?.trim() || existing.appSecret;
  const author = changes.author?.trim() ?? existing.author;
  if (appId !== existing.appId && !changes.appSecret?.trim()) throw new Error('切换公众号必须填写对应的新密钥');
  if ([...(author ?? '')].length > 16) throw new Error('默认作者不能超过 16 字');
  return { appId, appSecret, author };
}

export function publicWechatSettings(settings: WechatSettings = {}) {
  return { appId: settings.appId ?? '', author: settings.author ?? '', hasSecret: Boolean(settings.appSecret) };
}

export function encryptWechatSettings(settings: WechatSettings, available: boolean, encrypt: (value: string) => string): WechatSettings {
  if (!settings.appSecret) return { ...settings };
  if (!available) throw new Error('系统安全加密不可用，拒绝以明文保存公众号密钥');
  return { ...settings, appSecret: `safe:${encrypt(settings.appSecret)}` };
}

export function decryptWechatSettings(settings: WechatSettings, available: boolean, decrypt: (value: string) => string): WechatSettings {
  if (!settings.appSecret) return { ...settings };
  try {
    if (!available || !settings.appSecret.startsWith('safe:')) throw new Error();
    const appSecret = decrypt(settings.appSecret.slice(5));
    if (!appSecret) throw new Error();
    return { ...settings, appSecret };
  } catch {
    throw new Error('无法解密公众号密钥，已停止读取/保存配置，请检查系统钥匙串后重试');
  }
}
