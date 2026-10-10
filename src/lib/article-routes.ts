import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { ArticleError, type ArticleService } from './articles.js';
import type { ArticleStep } from './article-types.js';
import { getActor, requireActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import { WechatArticleError } from './wechat-article.js';
import { PublishingServiceError } from './publishing-service.js';
import { PublishingAssetError } from './publishing-assets.js';
import { PublishingError } from './publishing-store.js';
import { publishingErrorStatus } from './publishing-routes.js';
import { researchErrorBoundary } from './research-routes.js';
export function registerArticleRoutes(app: Express, deps: { articles: ArticleService; sessions: LocalSessionStore }) {
  const router = Router(); const s = deps.articles;
  const handle = (fn: (req: Request,res: Response) => Promise<unknown>) => (req: Request,res: Response,next: NextFunction) => { void fn(req,res).catch(next); };
  const actor = requireActor(deps.sessions);
  router.get('/capabilities',actor,handle(async(_req,res)=>res.json(await s.capabilities())));
  router.post('/auto',actor,handle(async(req,res)=>res.status(202).json({article:await s.createAuto(req.body,getActor(req).userId)})));
  router.get('/layout-defaults',actor,handle(async (_req,res)=>res.json({defaults:await s.layoutDefaults()})));
  router.put('/layout-defaults',actor,handle(async (req,res)=>res.json({defaults:await s.saveLayoutDefaults(req.body)})));
  router.get('/',handle(async (_req,res) => res.json({ articles: await s.list() })));
  router.post('/',actor,handle(async (req,res) => res.status(201).json({article: await s.create(req.body,getActor(req).userId)})));
  router.get('/:id',handle(async (req,res) => res.json({article:await s.get(String(req.params.id))})));
  router.patch('/:id',actor,handle(async (req,res) => res.json({article:await s.update(String(req.params.id),req.body)})));
  router.post('/:id/automation/resume',actor,handle(async(req,res)=>{const {version,...recovery}=req.body??{};res.status(202).json({article:await s.resumeAuto(String(req.params.id),version,getActor(req).userId,recovery)});}));
  router.post('/:id/automation/cancel',actor,handle(async(req,res)=>res.json({article:await s.cancelAuto(String(req.params.id),req.body?.runId,getActor(req).userId)})));
  router.delete('/:id',actor,handle(async (req,res) => { await s.remove(String(req.params.id),req.body?.version); res.json({ok:true}); }));
  router.post('/:id/steps/:step',actor,handle(async (req,res) => res.json({article:await s.run(String(req.params.id),String(req.params.step) as ArticleStep,req.body?.version)})));
  router.post('/:id/sources/read',actor,handle(async (req,res) => res.json({article:await s.readSources(String(req.params.id),req.body?.version,req.body?.sourceIds,getActor(req).userId)})));
  router.post('/:id/sources/import',actor,handle(async(req,res)=>res.json({article:await s.importResearchSources(String(req.params.id),req.body?.version,req.body?.selections,getActor(req).userId)})));
  router.post('/:id/layout-preview',actor,handle(async(req,res)=>res.json({preview:await s.previewLayout(String(req.params.id),req.body)})));
  router.post('/:id/publishing/preview',handle(async (req,res) => res.json({preview:await s.preview(String(req.params.id),req.body?.version)})));
  router.post('/:id/publishing/packages',actor,handle(async (req,res) => res.status(201).json({detail:await s.createPackage(String(req.params.id),req.body?.version,req.body?.previewRevision,getActor(req))})));
  router.post('/:id/wechat-drafts/:taskId/preview',actor,handle(async (req,res) => res.json({preview:await s.previewDraftUpdate(String(req.params.id),String(req.params.taskId),req.body?.version,getActor(req))})));
  router.post('/:id/wechat-drafts/:taskId/update',actor,handle(async (req,res) => res.json({task:await s.updateDraft(String(req.params.id),String(req.params.taskId),req.body?.version,req.body?.previewRevision,getActor(req))})));
  router.post('/:id/wechat-drafts',actor,handle(async(req,res)=>res.json(await s.saveWechatDraft(String(req.params.id),req.body?.version,req.body?.previewRevision,req.body?.confirmed,getActor(req)))));
  router.use(researchErrorBoundary);
  router.use((error: unknown,_req: Request,res: Response,_next: NextFunction) => {
    if (error instanceof ArticleError || error instanceof LocalAuthError || error instanceof WechatArticleError || error instanceof PublishingServiceError || error instanceof PublishingAssetError) { res.status(error.status).json({code:error.code,message:error.message}); return; }
    if (error instanceof PublishingError) { res.status(publishingErrorStatus(error.code)).json({code:error.code,message:error.message}); return; }
    console.error('[articles]',error); res.status(500).json({code:'article_failed',message:'文章操作失败，未覆盖已保存内容'});
  });
  app.use('/api/articles',router);
}
