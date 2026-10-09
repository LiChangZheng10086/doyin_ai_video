export interface ResearchSettings {jinaEnabled:boolean;exaEnabled:boolean}
export function mergeResearchSettings(existing?:Partial<ResearchSettings>,changes?:Partial<ResearchSettings>):ResearchSettings {
  if(changes!==undefined){
    if(!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).some(k=>!['jinaEnabled','exaEnabled'].includes(k)))throw new Error('资料设置包含未知字段');
    if(Object.values(changes).some(v=>typeof v!=='boolean'))throw new Error('资料设置应为布尔值');
  }
  return {jinaEnabled:existing?.jinaEnabled===true,exaEnabled:existing?.exaEnabled===true,...changes};
}
