import React from 'react';
import { apiClient } from '../services/api';
import { QrLoginPanel, type QrLoginApi, type QrLoginCopy } from './QrLoginPanel';

const API: QrLoginApi = {
  start: () => apiClient.startDouyinLogin(),
  poll: () => apiClient.pollDouyinLogin(),
  cancel: () => apiClient.cancelDouyinLogin(),
  loginInWindow: async () => {
    await apiClient.cancelDouyinLogin();
    const result = await apiClient.startQrLogin();
    return { loggedIn: result.hasAuth, message: result.message };
  },
  verify: async () => {
    const status = await apiClient.getCookieStatus();
    return {
      loggedIn: status.hasAuth,
      message: status.hasAuth ? '本地已保存登录 Cookie；实际有效性请看运行环境的验证结论。' : '本地尚无抖音登录 Cookie。',
    };
  },
};

const COPY: QrLoginCopy = {
  platformName: '抖音',
  appName: '抖音',
  testId: 'douyin-login-panel',
  qrTestId: 'douyin-qr',
  successLabel: '已保存登录凭据（有效性待验证）',
  footnote: '二维码显示在本页，登录 Cookie 保存在本机供采集与发布共用；实际有效性以「运行环境」的验证结论为准。',
};

export function DouyinLoginPanel({ onLoggedIn }: { onLoggedIn?: () => void }) {
  return <QrLoginPanel api={API} copy={COPY} onLoggedIn={onLoggedIn} />;
}
