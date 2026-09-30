import { open } from 'node:fs/promises';
import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { OnlineAudioService, OnlineAudioError, AUDIO_SOURCES, AUDIO_BOARDS } from './online-audio.js';
import { requireActor, getActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import { sendRangeResponse } from './range-response.js';

export function registerOnlineAudioRoutes(app: Express, deps: { audio: OnlineAudioService; sessions: LocalSessionStore }): void {
  const router = Router(); const service = deps.audio;
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/catalog', (_req, res) => res.json({ sources: AUDIO_SOURCES, boards: AUDIO_BOARDS }));
  router.get('/boards', handle(async (req, res) => res.json({ board: await service.list(req.query.source, req.query.board) })));
  router.post('/boards/refresh', handle(async (req, res) => res.json({ board: await service.list(req.body?.source, req.body?.board, true) })));
  router.get('/search', handle(async (req, res) => res.json({ tracks: await service.search(req.query.source, req.query.q) })));
  router.post('/preview', requireActor(deps.sessions), handle(async (req, res) => res.json({ preview: await service.preview(req.body?.trackKey) })));
  router.get('/media/:token', handle(async (req, res) => {
    const media = await service.openMedia(String(req.params.token));
    const file = await open(media.path, 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile() || !stats.size) throw new OnlineAudioError(404, '试听文件已过期，请重新点击试听');
      await sendRangeResponse(req, res, { size: stats.size, mimeType: media.mimeType,
        createReadStream: options => file.createReadStream(options), close: () => file.close() });
    } catch (error) { await file.close().catch(() => {}); throw error; }
  }));
  router.post('/imports', requireActor(deps.sessions), handle(async (req, res) => res.status(202).json({ batch: service.startImport(req.body?.trackKeys, getActor(req).userId) })));
  router.get('/imports/:id', requireActor(deps.sessions), handle(async (req, res) => res.json({ batch: service.getImport(String(req.params.id), getActor(req).userId) })));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof OnlineAudioError || error instanceof LocalAuthError) {
      res.status(error.status).json({ code: error instanceof LocalAuthError ? error.code : 'online_audio_error', message: error.message }); return;
    }
    res.status(500).json({ code: 'online_audio_failed', message: '在线音频操作失败，请检查网络与本地存储后重试' });
  });
  app.use('/api/online-audio', router);
}
