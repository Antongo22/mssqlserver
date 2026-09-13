import {selection} from './data-selection.js';
export function installDataExport(app,services){
  const {withDb,sql,identifier:q,tableData:{metadata,cell,parameter}}=services;
  app.get('/api/databases/:database/data/export',async(req,res)=>{
    const {schema='dbo',name}=req.query;let request,closed=false;
    const cancel=()=>{closed=true;request?.cancel();};res.on('close',cancel);
    try{await withDb(req.params.database,async pool=>{
      const columns=await metadata(pool,schema,name);if(closed)return;
      request=new sql.Request(pool,{requestTimeout:600000});request.stream=true;request.arrayRowMode=true;request.on('error',()=>{});
      const selected=selection(columns,req.query,request, {...services,parameter,cell});let rows=0;
      res.type('application/x-ndjson');
      const csv=values=>values.map(v=>{let s=v===null?'\\N':String(v);if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(';')+'\r\n';
      res.write(JSON.stringify({csv:'\uFEFF'+csv(columns.map(c=>c.name)),rows:0})+'\n');
      res.on('drain',()=>{if(!closed)request.resume();});
      request.on('row',row=>{if(!closed&&!res.write(JSON.stringify({csv:csv(row),rows:++rows})+'\n'))request.pause();});
      await request.query(`SELECT ${columns.map(cell).join(',')} FROM ${q(schema)}.${q(name)} t ${selected.where} ORDER BY ${selected.order}`);
      if(!closed)res.end(JSON.stringify({done:true,rows})+'\n');
    },{audit:false});}catch(e){if(!closed){if(res.headersSent)res.end(JSON.stringify({error:e.message})+'\n');else throw e;}}finally{res.off('close',cancel);}
  });
}
