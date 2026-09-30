import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { ArticleError, type ArticleService } from './articles.js';
import type { ArticleStep } from './article-types.js';
import { getActor, requireActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import { WechatArticleError } from './wechat-article.js';
import { PublishingServiceError } from './publishing-service.js';
import { PublishingAssetError } from './publishing-assets.js';
import { PublishingError } from './publishing-store.js';
import { publishingErrorStatus } from './publishing-routes.js';
export function registerArticleRoutes(app: Express, deps: { articles: ArticleService; sessions: LocalSessionStore }) {
  const router = Router(); const s = deps.articles;
  const handle = (fn: (req: Request,res: Response) => Promise<unknown>) => (req: Request,res: Response,next: NextFunction) => { void fn(req,res).catch(next); };
  const actor = requireActor(deps.sessions);
  router.get('/',handle(async (_req,res) => res.json({ articles: await s.list() })));
  router.post('/',actor,handle(async (req,res) => res.status(201).json({article: await s.create(req.body)})));
  router.get('/:id',handle(async (req,res) => res.json({article:await s.get(String(req.params.id))})));
  router.patch('/:id',actor,handle(async (req,res) => res.json({article:await s.update(String(req.params.id),req.body)})));
  router.delete('/:id',actor,handle(async (req,res) => { await s.remove(String(req.params.id),req.body?.version); res.json({ok:true}); }));
  router.post('/:id/steps/:step',actor,handle(async (req,res) => res.json({article:await s.run(String(req.params.id),String(req.params.step) as ArticleStep,req.body?.version)})));
  router.post('/:id/sources/read',actor,handle(async (req,res) => res.json({article:await s.readSources(String(req.params.id),req.body?.version,req.body?.sourceIds)})));
  router.post('/:id/publishing/preview',handle(async (req,res) => res.json({preview:await s.preview(String(req.params.id),req.body?.version)})));
  router.post('/:id/publishing/packages',actor,handle(async (req,res) => res.status(201).json({detail:await s.createPackage(String(req.params.id),req.body?.version,req.body?.previewRevision,getActor(req))})));
  router.use((error: unknown,_req: Request,res: Response,_next: NextFunction) => {
    if (error instanceof ArticleError || error instanceof LocalAuthError || error instanceof WechatArticleError || error instanceof PublishingServiceError || error instanceof PublishingAssetError) { res.status(error.status).json({code:error.code,message:error.message}); return; }
    if (error instanceof PublishingError) { res.status(publishingErrorStatus(error.code)).json({code:error.code,message:error.message}); return; }
    console.error('[articles]',error); res.status(500).json({code:'article_failed',message:'文章操作失败，未覆盖已保存内容'});
  });
  app.use('/api/articles',router);
}
