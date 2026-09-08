import {createHash,randomUUID} from 'node:crypto';
// This is an accident-prevention mode, not a replacement for SQL login permissions.
export function createProtection({connections}){
  const tickets=new Map();
  const fingerprint=(req,c)=>createHash('sha256').update(JSON.stringify([req.method,req.originalUrl,req.body,c])).digest('hex');
  return (req,res,next)=>{
    const path=req.path,c=connections.get();
    if(['GET','HEAD','OPTIONS'].includes(req.method)||/^\/connections(?:\/|$)/.test(path))return next();
    const readOperation=req.method==='POST'&&(path==='/schema-compare'||path==='/import-file'||/^\/query\/[\w-]+\/cancel$/.test(path)||/^\/backups\/[^/]+\/verify$/.test(path)||/^\/databases\/[^/]+\/data\/import\/preview$/.test(path)||(/^\/databases\/[^/]+\/structure$/.test(path)&&req.body?.preview===true));
    if(readOperation)return next();
    if(c.readOnly)return res.status(403).json({error:'Подключение в режиме «Только чтение». Изменения, задания, загрузка файлов и произвольный SQL отключены. Данные доступны во вкладке «Таблицы».',code:'STUDIO_READ_ONLY'});
    // Upload only stages a file; the separate restore operation requires confirmation.
    if(c.environment!=='production'||path==='/backups/upload')return next();
    for(const [id,t] of tickets)if(t.expires<Date.now())tickets.delete(id);
    const signature=fingerprint(req,c),token=req.headers['x-studio-confirmation'],ticket=tickets.get(token);
    if(ticket&&ticket.signature===signature){tickets.delete(token);return next();}
    if(tickets.size>=1000)return res.status(429).json({error:'Слишком много ожидающих подтверждений. Повторите через пять минут.'});
    const id=randomUUID();tickets.set(id,{signature,expires:Date.now()+300000});
    res.status(428).json({error:'Подтвердите операцию на рабочем сервере.',confirmation:{token:id,name:c.name,server:c.server,port:c.port,database:req.body?.database||(/\/databases\/([^/]+)/.exec(path)?.[1]?decodeURIComponent(/\/databases\/([^/]+)/.exec(path)[1]):'master')}});
  };
}
