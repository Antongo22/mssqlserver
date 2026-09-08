export function installObjectSearch(app,{withDb,sql,fail}){
  app.get('/api/databases/:database/search',async(req,res)=>{
    const term=String(req.query.q||'').trim();if(term.length<2||term.length>200)throw fail('Поиск: 2–200 символов.');
    const r=await withDb(req.params.database,p=>p.request().input('q',sql.NVarChar(200),term).query(`
      WITH hits AS (
        SELECT o.object_id id,SCHEMA_NAME(o.schema_id) [schema],o.name,o.type,'OBJECT' hit,CAST(NULL AS nvarchar(128)) [column],CAST(NULL AS nvarchar(400)) snippet,0 position
        FROM sys.objects o WHERE o.is_ms_shipped=0 AND o.type IN ('U','V','P','FN','IF','TF','TR','SO','SN') AND CHARINDEX(@q,SCHEMA_NAME(o.schema_id)+'.'+o.name)>0
        UNION ALL
        SELECT o.object_id,SCHEMA_NAME(o.schema_id),o.name,o.type,'COLUMN',c.name,NULL,0 FROM sys.objects o JOIN sys.columns c ON c.object_id=o.object_id WHERE o.is_ms_shipped=0 AND o.type IN ('U','V') AND CHARINDEX(@q,c.name)>0
        UNION ALL
        SELECT o.object_id,SCHEMA_NAME(o.schema_id),o.name,o.type,'DEFINITION',NULL,SUBSTRING(m.definition,CASE WHEN CHARINDEX(@q,m.definition)>100 THEN CHARINDEX(@q,m.definition)-100 ELSE 1 END,350),CHARINDEX(@q,m.definition)
        FROM sys.objects o JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.is_ms_shipped=0 AND CHARINDEX(@q,m.definition)>0
      ) SELECT TOP(201) * FROM hits ORDER BY [schema],name,hit,[column];`));
    res.json({results:r.recordset.slice(0,200),truncated:r.recordset.length>200});
  });
}
