import React from 'react';
import { apiClient } from '../services/api';
import { QrLoginPanel, type QrLoginApi, type QrLoginCopy } from './QrLoginPanel';

/**
 * 小红书登录面板（**应用内扫码**，与头条共用同一份实现）。
 *
 * 小红书没有可手工粘贴的凭据（登录态是浏览器 profile），所以扫码是唯一入口。
 * 两个平台特有的坑（都已写进执行器并有用例守着）：
 * ① 登录页**默认是短信登录**，必须先切到扫码模式才拿得到二维码；
 * ② 二维码**会静默轮换**，轮询同步当前码；会话过期后可点「重新获取二维码」。
 */
const XHS_API: QrLoginApi = {
  start: () => apiClient.startXhsLogin(),
  poll: () => apiClient.pollXhsLogin(),
  cancel: () => apiClient.cancelXhsLogin(),
  loginInWindow: () => apiClient.loginXhsInWindow(),
  verify: () => apiClient.verifyXhsLogin(),
};

const XHS_COPY: QrLoginCopy = {
  platformName: '小红书',
  appName: '小红书',
  testId: 'xhs-login-panel',
  qrTestId: 'xhs-qr',
  footnote:
    '登录态保存在本机 storage 里的小红书会话目录中，不会离开 storage。'
    + '本工具只做发布：不读取你的笔记、不搜索、不评论、不点赞收藏。'
    + '⚠️ 自动化发布违反平台规则，风险由你的账号承担，平台可能警告、限流或封号。',
};

export interface XhsLoginPanelProps {
  onLoggedIn?: (username?: string) => void;
}

export function XhsLoginPanel({ onLoggedIn }: XhsLoginPanelProps) {
  return <QrLoginPanel api={XHS_API} copy={XHS_COPY} onLoggedIn={onLoggedIn} />;
}
