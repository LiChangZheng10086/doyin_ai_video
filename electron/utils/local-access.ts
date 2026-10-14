type RequestFrame = { url: string; top: { url: string } | null };

export function desktopAccessHeaders(headers: Record<string, string>, frame: RequestFrame | null | undefined, rendererUrl: string, token: string): Record<string, string> {
  const result = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'x-desktop-access'));
  const trusted = (value: string) => {
    try {
      const url = new URL(value); const renderer = new URL(rendererUrl);
      return renderer.protocol === 'file:'
        ? url.protocol === 'file:' && url.host === renderer.host && url.pathname === renderer.pathname
        : url.origin === renderer.origin && ['http:', 'https:'].includes(renderer.protocol);
    } catch { return false; }
  };
  try {
    if (frame?.top && trusted(frame.url) && trusted(frame.top.url)) result['X-Desktop-Access'] = token;
  } catch { /* 导航销毁的 frame 不再授予访问凭证。 */ }
  return result;
}
