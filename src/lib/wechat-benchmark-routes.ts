import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import { requireActor, LocalAuthError, type LocalSessionStore } from './local-auth.js';
import { BenchmarkError, type WechatBenchmarkService } from './wechat-benchmarks.js';

export function registerWechatBenchmarkRoutes(app:Express,deps:{benchmarks:WechatBenchmarkService;sessions:LocalSessionStore}){
  const r=Router();const actor=requireActor(deps.sessions);const s=deps.benchmarks;
  const handle=(fn:(req:Request,res:Response)=>Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req,res).catch(next);};
  r.get('/',handle(async(_req,res)=>res.json({groups:await s.list()})));
  r.post('/',actor,handle(async(req,res)=>res.status(201).json({group:await s.create(req.body)})));
  r.post('/search',actor,handle(async(req,res)=>res.json({result:await s.search(req.body?.keyword)})));
  r.patch('/:id',actor,handle(async(req,res)=>res.json({group:await s.update(String(req.params.id),req.body)})));
  r.delete('/:id',actor,handle(async(req,res)=>{await s.remove(String(req.params.id),req.body?.version);res.json({ok:true});}));
  r.use((e:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(e instanceof BenchmarkError||e instanceof LocalAuthError){res.status(e.status).json({code:e.code,message:e.message});return;}
    console.error('[wechat-benchmarks]',e);res.status(500).json({code:'benchmark_failed',message:'对标操作失败，已保存内容仍保留'});
  });
  app.use('/api/wechat-benchmarks',r);
}
