import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { GalleryService } from './galleries.js';
import { GalleryError } from './gallery-media.js';
import { getActor, requireActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import { VideoOutputError } from './video-output.js';
import { PublishingServiceError } from './publishing-service.js';
import { PublishingAssetError } from './publishing-assets.js';
import { PublishingError } from './publishing-store.js';
import { publishingErrorStatus } from './publishing-routes.js';

export function registerGalleryRoutes(app: Express, deps: { galleries: GalleryService; sessions: LocalSessionStore }): void {
  const router = Router();
  const service = deps.galleries;
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
  router.get('/', handle(async (_req, res) => res.json({ galleries: await service.list() })));
  router.post('/', requireActor(deps.sessions), handle(async (req, res) => res.status(201).json({ gallery: await service.create(req.body?.sourceJobId) })));
  router.get('/:id', handle(async (req, res) => res.json({ gallery: await service.get(String(req.params.id)) })));
  router.patch('/:id', requireActor(deps.sessions), handle(async (req, res) => res.json({ gallery: await service.update(String(req.params.id), req.body) })));
  router.delete('/:id', requireActor(deps.sessions), handle(async (req, res) => { await service.remove(String(req.params.id), req.body?.version); res.json({ ok: true }); }));
  router.get('/:id/source', handle(async (req, res) => res.json({ source: await service.inspectSource(String(req.params.id)) })));
  router.get('/:id/frame', handle(async (req, res) => {
    if (typeof req.query.time !== 'string' || !req.query.time.trim()) throw new GalleryError(400, '请选择画面时间');
    res.type('png').set('Cache-Control', 'no-store').send(await service.frame(String(req.params.id), Number(req.query.time)));
  }));
  router.post('/:id/plan', requireActor(deps.sessions), handle(async (req, res) => res.json({ gallery: await service.plan(String(req.params.id), req.body) })));
  router.post('/:id/copy', requireActor(deps.sessions), handle(async (req, res) => res.json({ gallery: await service.generateCopy(String(req.params.id), req.body?.version) })));
  router.post('/:id/plan/render', requireActor(deps.sessions), handle(async (req, res) => res.json({ gallery: await service.renderPlan(String(req.params.id), req.body) })));
  router.get('/:id/plan/images/:index', handle(async (req, res) => res.type('png').set('Cache-Control', 'no-store').send(
    await service.planImage(String(req.params.id), Number(req.params.index), typeof req.query.planId === 'string' ? req.query.planId : '', Number(req.query.version)))));
  router.post('/:id/render', requireActor(deps.sessions), handle(async (req, res) => res.json({ gallery: await service.render(String(req.params.id), req.body?.version) })));
  router.get('/:id/images/:index', handle(async (req, res) => res.type('png').set('Cache-Control', 'no-store').send(await service.image(String(req.params.id), Number(req.params.index), typeof req.query.generation === 'string' ? req.query.generation : undefined))));
  router.post('/:id/publishing/preview', handle(async (req, res) => res.json({ preview: await service.preview(String(req.params.id), req.body?.version) })));
  router.post('/:id/publishing/packages', requireActor(deps.sessions), handle(async (req, res) => res.status(201).json({ detail: await service.createPackage(String(req.params.id), req.body?.previewRevision, req.body?.rightsConfirmed, getActor(req)) })));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof GalleryError || error instanceof LocalAuthError || error instanceof VideoOutputError
      || error instanceof PublishingServiceError || error instanceof PublishingAssetError) {
      res.status(error.status).json({ code: error.code, message: error.message }); return;
    }
    if (error instanceof PublishingError) { res.status(publishingErrorStatus(error.code)).json({ code: error.code, message: error.message }); return; }
    console.error('[galleries]', error);
    res.status(500).json({ code: 'gallery_failed', message: '图集操作失败，请检查原视频或本地运行环境后重试' });
  });
  app.use('/api/galleries', router);
}
