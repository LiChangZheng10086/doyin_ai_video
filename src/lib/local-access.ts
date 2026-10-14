import type { RequestHandler } from 'express';

function localHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** 本机免登录入口只服务可信来源；Electron 的不透明来源另用主进程凭证识别。 */
export function localAccess(desktopToken?: string): RequestHandler {
  return (req, res, next) => {
    const address = req.socket.remoteAddress;
    const origin = req.get('Origin');
    const desktop = !!desktopToken && req.get('X-Desktop-Access') === desktopToken;
    let allowed = false;
    try {
      const host = new URL(`http://${req.get('Host') ?? ''}`);
      const local = address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
      const development = !desktopToken && (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173');
      allowed = local && localHost(host.hostname) && !host.username && !host.password && host.pathname === '/'
        && (desktop || (origin ? origin === host.origin || development : req.get('Sec-Fetch-Site') !== 'cross-site'));
    } catch { /* 无效 Host 不进入本机 API。 */ }
    if (!allowed) {
      res.status(403).json({ code: 'local_access_forbidden', message: '仅允许本机应用访问，请从抖创工坊打开。' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Local-Session, Last-Event-ID, X-Desktop-Access');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  };
}
