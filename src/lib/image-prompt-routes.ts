import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { ImagePromptService, ImagePromptError } from './image-prompts.js';
import { LocalAuthError, requireActor, type LocalSessionStore } from './local-auth.js';

export function registerImagePromptRoutes(app: Express, deps: { prompts: ImagePromptService; sessions: LocalSessionStore }): void {
  const router = Router(); const auth = requireActor(deps.sessions);
  const id = (req: Request): string => {
    if (typeof req.params.id !== 'string') throw new ImagePromptError(400, 'image_prompt_input_invalid', '提示词 ID 无效');
    return req.params.id;
  };
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', handle(async (_req, res) => res.json({ prompts: await deps.prompts.list() })));
  router.post('/', auth, handle(async (req, res) => res.status(201).json({ prompts: await deps.prompts.generate(req.body) })));
  router.patch('/:id', auth, handle(async (req, res) => res.json({ prompt: await deps.prompts.update(id(req), req.body) })));
  router.delete('/:id', auth, handle(async (req, res) => { await deps.prompts.remove(id(req), req.body?.version); res.status(204).end(); }));
  app.use('/api/image-prompts', router);
  app.use('/api/image-prompts', (e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (e instanceof ImagePromptError || e instanceof LocalAuthError) { res.status(e.status).json({ code: e.code, message: e.message }); return; }
    if (e instanceof SyntaxError && 'status' in e && e.status === 400) { res.status(400).json({ code: 'image_prompt_input_invalid', message: '请求 JSON 无效' }); return; }
    res.status(500).json({ code: 'image_prompt_storage_failed', message: '提示词操作失败，请检查本地存储' });
  });
}
