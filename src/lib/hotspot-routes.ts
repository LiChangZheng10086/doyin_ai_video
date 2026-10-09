import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { HotspotService, HotspotError } from './hotspots.js';
import { getActor, requireActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import type { ResearchService } from './research-service.js';
import { researchErrorBoundary } from './research-routes.js';

export function registerHotspotRoutes(app: Express, deps: { hotspots: HotspotService; sessions: LocalSessionStore; research?:ResearchService }): void {
  const router = Router(); const service = deps.hotspots;
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', handle(async (_req, res) => res.json({ boards: await service.list() })));
  router.post('/refresh', handle(async (_req, res) => res.json({ boards: await service.list(true) })));
  router.post('/detail',requireActor(deps.sessions),handle(async(req,res)=>{
    const detail=await service.resolveDetail(req.body?.sourceId,req.body?.itemId);
    if(!detail)throw new HotspotError(404,'该热点已下榜且未收藏，请重新选择');
    if(!deps.research)throw new HotspotError(422,'资料读取服务未启用');
    res.json({item:detail.item,result:await deps.research.read(getActor(req).userId,{url:detail.item.url})});
  }));
  router.get('/favorites', handle(async (_req, res) => res.json({ favorites: await service.favorites() })));
  router.post('/favorites', requireActor(deps.sessions), handle(async (req, res) => res.status(201).json({ favorite: await service.save(req.body?.sourceId, req.body?.itemId) })));
  router.patch('/favorites/:id', requireActor(deps.sessions), handle(async (req, res) => res.json({ favorite: await service.update(String(req.params.id), req.body?.note, req.body?.version) })));
  router.delete('/favorites/:id', requireActor(deps.sessions), handle(async (req, res) => { await service.remove(String(req.params.id), req.body?.version); res.json({ ok: true }); }));
  router.use(researchErrorBoundary);
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HotspotError || error instanceof LocalAuthError) { res.status(error.status).json({ code: error instanceof LocalAuthError ? error.code : 'hotspot_error', message: error.message }); return; }
    console.error('[hotspots] local operation failed', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ code: 'hotspot_storage_failed', message: '热点或收藏读写失败，请检查本地存储目录；原收藏未被覆盖' });
  });
  app.use('/api/hotspots', router);
}
