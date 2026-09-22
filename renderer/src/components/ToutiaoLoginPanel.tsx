import React from 'react';
import { apiClient } from '../services/api';
import { QrLoginPanel, type QrLoginApi, type QrLoginCopy } from './QrLoginPanel';

/**
 * 今日头条登录面板（**应用内扫码**，不弹浏览器窗口）。
 *
 * 逻辑全部在通用面板 `QrLoginPanel` 里（小红书用的是同一份实现），这里只提供
 * **头条的端点与文案**。头条号没有可手工粘贴的凭据（登录态是浏览器 profile），所以扫码是唯一入口。
 */
const TOUTIAO_API: QrLoginApi = {
  start: () => apiClient.startToutiaoLogin(),
  poll: () => apiClient.pollToutiaoLogin(),
  cancel: () => apiClient.cancelToutiaoLogin(),
  loginInWindow: () => apiClient.loginToutiaoInWindow(),
  verify: () => apiClient.verifyToutiaoLogin(),
};

const TOUTIAO_COPY: QrLoginCopy = {
  platformName: '今日头条',
  appName: '今日头条',
  testId: 'toutiao-login-panel',
  qrTestId: 'toutiao-qr',
  footnote: '登录用的是应用内置的无头浏览器（不会弹出窗口），登录态保存在本机 storage 里的头条会话目录中。',
};

export interface ToutiaoLoginPanelProps {
  onLoggedIn?: (username?: string) => void;
}

export function ToutiaoLoginPanel({ onLoggedIn }: ToutiaoLoginPanelProps) {
  return <QrLoginPanel api={TOUTIAO_API} copy={TOUTIAO_COPY} onLoggedIn={onLoggedIn} />;
}
