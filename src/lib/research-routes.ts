import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { getActor, requireActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import { ResearchError } from './research-types.js';
import type { ResearchService } from './research-service.js';
export function researchErrorBoundary(error:unknown,_req:Request,res:Response,next:NextFunction){
  if(error instanceof ResearchError||error instanceof LocalAuthError){
    if(error instanceof ResearchError&&error.retryAfterSeconds)res.set('Retry-After',String(error.retryAfterSeconds));
    res.status(error.status).json({code:error.code,message:error.message,...(error instanceof ResearchError&&error.retryAfterSeconds?{details:{retryAfterSeconds:error.retryAfterSeconds}}:{})});return;
  }next(error);
}
export function registerResearchRoutes(app:Express,deps:{research:ResearchService;sessions:LocalSessionStore}){
  const router=Router();const handle=(fn:(req:Request,res:Response)=>Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get('/status',handle(async(_req,res)=>res.json(await deps.research.status())));
  router.post('/search',requireActor(deps.sessions),handle(async(req,res)=>res.json({result:await deps.research.search(getActor(req).userId,req.body?.query)})));
  router.post('/read',requireActor(deps.sessions),handle(async(req,res)=>res.json({result:await deps.research.read(getActor(req).userId,req.body)})));
  router.use(researchErrorBoundary);app.use('/api/research',router);
}
