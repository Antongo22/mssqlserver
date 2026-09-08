import {randomUUID} from 'node:crypto';
// Remove literals, identifiers and nested comments before classifying a batch.
export function sqlWords(source){
  let out='',quote=null,comment=0;
  for(let i=0;i<source.length;i++){
    const c=source[i],n=source[i+1];
    if(comment){if(c==='/'&&n==='*'){comment++;i++;}else if(c==='*'&&n==='/'){comment--;i++;}out+=' ';}
    else if(quote){if(c===quote){if(n===quote)i++;else quote=null;}out+=' ';}
    else if(c==='-'&&n==='-'){while(i<source.length&&source[i]!=='\n')i++;out+=' ';}
    else if(c==='/'&&n==='*'){comment++;i++;out+=' ';}
    else if(c==="'"||c==='"'||c==='['){quote=c==='['?']':c;out+=' ';}
    else out+=c;
  }return out;
}
export const hasDDL=source=>/\b(?:CREATE(?:\s+OR\s+ALTER)?|ALTER|DROP)\s+(?:(?:UNIQUE|CLUSTERED|NONCLUSTERED)\s+)*(?:DATABASE|TABLE|VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER|INDEX|SCHEMA|SEQUENCE|SYNONYM)\b|\bTRUNCATE\s+TABLE\b|\bEXEC(?:UTE)?\b/i.test(sqlWords(source));
export const historySQL=source=>source.replace(/\bPASSWORD\s*=\s*N?'(?:[^']|'')*'/gi,"PASSWORD = '[скрыто]'").slice(0,65536);
export function createDDLHistory({store,connections}){
  async function run(database,source,execute,options={}){
    if(!hasDDL(source)||options.estimated)return execute();
    const c=connections.get(),entry={id:randomUUID(),connection:c.id,connectionName:c.name,server:c.server,port:c.port,login:c.user,database,started:Date.now(),sql:historySQL(source),truncated:source.length>65536,status:'pending',transaction:!!options.transaction};
    await store.update(s=>{s.ddlHistory=[entry,...(s.ddlHistory||[])].slice(0,500);});
    let result,error;try{result=await execute();}catch(e){error=e;}
    try{await store.update(s=>{const item=s.ddlHistory.find(x=>x.id===entry.id);if(item)Object.assign(item,{finished:Date.now(),status:error?'error':'success',error:error?historySQL(error.message).slice(0,4000):undefined,rolledBack:error?.partial?.rolledBack,completedBatches:result?.completedBatches??error?.partial?.completedBatches});});}
    catch(e){console.error('DDL history could not save outcome:',e.message);}
    if(error)throw error;return result;
  }
  function observe(pool,database){
    const request=pool.request.bind(pool);pool.request=(...args)=>{
      const r=request(...args);for(const method of ['query','batch']){const execute=r[method].bind(r);r[method]=(text,...rest)=>typeof text==='string'?run(database,text,()=>execute(text,...rest)):execute(text,...rest);}return r;
    };
  }
  function install(app){app.get('/api/ddl-history',(req,res)=>{let entries=(store.read().ddlHistory||[]).filter(x=>x.connection===connections.get().id);if(req.query.database)entries=entries.filter(x=>x.database===req.query.database);res.json({entries,limit:500});});}
  return {run,observe,install};
}
