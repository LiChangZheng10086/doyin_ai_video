import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { XhsNoteError, type XhsNoteService } from './xhs-notes.js';
import { getActor, requireActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import { AssetError } from './assets-store.js';
import { PublishingServiceError } from './publishing-service.js';
import { PublishingAssetError } from './publishing-assets.js';
import { PublishingError } from './publishing-store.js';
import { publishingErrorStatus } from './publishing-routes.js';

export function registerXhsNoteRoutes(app: Express, deps: { notes: XhsNoteService; sessions: LocalSessionStore }): void {
  const router = Router(); const service = deps.notes;
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
  const requestVersion = (req: Request): unknown => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => key !== 'version')) {
      throw new XhsNoteError(400, '此操作仅接受当前版本，不能写入服务端字段');
    }
    return req.body.version;
  };
  router.get('/', handle(async (_req, res) => res.json({ notes: await service.list() })));
  router.get('/:id', handle(async (req, res) => res.json({ note: await service.get(String(req.params.id)) })));
  router.post('/', requireActor(deps.sessions), handle(async (req, res) => res.status(201).json({ note: await service.create(req.body) })));
  router.patch('/:id', requireActor(deps.sessions), handle(async (req, res) => res.json({ note: await service.update(String(req.params.id), req.body) })));
  router.delete('/:id', requireActor(deps.sessions), handle(async (req, res) => { await service.remove(String(req.params.id), requestVersion(req)); res.json({ ok: true }); }));
  router.post('/:id/rewrite', requireActor(deps.sessions), handle(async (req, res) => {
    req.setTimeout(0); res.setTimeout(0);
    res.json({ note: await service.rewrite(String(req.params.id), requestVersion(req)) });
  }));
  router.post('/:id/publishing/preview', requireActor(deps.sessions), handle(async (req, res) => res.json({ preview: await service.preview(String(req.params.id), requestVersion(req)) })));
  router.post('/:id/publishing/packages', requireActor(deps.sessions), handle(async (req, res) => res.status(201).json({ detail: await service.createPackage(String(req.params.id), req.body, getActor(req)) })));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof XhsNoteError || error instanceof LocalAuthError || error instanceof AssetError || error instanceof PublishingServiceError || error instanceof PublishingAssetError) {
      res.status(error.status).json({ code: error.code, message: error.message }); return;
    }
    if (error instanceof PublishingError) { res.status(publishingErrorStatus(error.code)).json({ code: error.code, message: error.message }); return; }
    res.status(500).json({ code: 'xhs_note_failed', message: '笔记操作失败，请检查本地存储后重试' });
  });
  app.use('/api/xhs-notes', router);
}
