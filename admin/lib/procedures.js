import {randomUUID} from 'node:crypto';
import {executeScript} from './query.js';
import {typeSQL} from './schema-tools.js';
export function installProcedures(app,{withDb,sql,identifier:q,fail,ddlHistory}){
  app.post('/api/databases/:database/procedures/:id/execute',async(req,res)=>{
    const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw fail('Некорректный ID процедуры.');
    const inputs=req.body.parameters||{};if(!inputs||typeof inputs!=='object'||Array.isArray(inputs))throw fail('Некорректные параметры.');
    let disconnect;
    try{const result=await withDb(req.params.database,async pool=>{
      const meta=await pool.request().input('id',sql.Int,id).query(`SELECT SCHEMA_NAME(schema_id) [schema],name FROM sys.procedures WHERE object_id=@id AND is_ms_shipped=0 AND type='P';
        SELECT p.name,p.parameter_id id,p.is_output [output],p.is_readonly [readOnly],p.max_length maxLength,p.precision,p.scale,t.name type,t.is_user_defined userType,SCHEMA_NAME(t.schema_id) typeSchema,t.is_table_type tableType
        FROM sys.parameters p JOIN sys.types t ON t.user_type_id=p.user_type_id WHERE p.object_id=@id ORDER BY p.parameter_id;`);
      const proc=meta.recordsets[0][0],params=meta.recordsets[1];if(!proc)throw fail('T-SQL процедура не найдена.',404);
      if(Object.keys(inputs).some(name=>!params.some(p=>p.name===name)))throw fail('Параметры процедуры изменились. Откройте форму заново.');
      const bindings=[],declarations=[],args=[],outputs=[];
      for(const p of params){
        const input=inputs[p.name]||{mode:'default'};if(!['default','null','value'].includes(input.mode))throw fail('Некорректный режим параметра.');
        if(input.mode==='default')continue;
        if(p.tableType)throw fail('Для табличного параметра '+p.name+' используйте SQL-редактор с DECLARE переменной табличного типа.');
        if(!/^(?:n?varchar|n?char|varbinary|binary|int|bigint|smallint|tinyint|decimal|numeric|money|smallmoney|bit|float|real|date|datetime|smalldatetime|datetime2|datetimeoffset|time|uniqueidentifier|xml)$/.test(p.type)||p.userType)throw fail('Тип '+p.type+' пока доступен через SQL-редактор.');
        if(input.mode==='value'&&typeof input.value!=='string')throw fail('Введите строковое значение параметра.');
        const type=typeSQL(p),n='studio_value_'+p.id,v='@studio_argument_'+p.id;
        bindings.push({name:n,value:input.mode==='null'?null:input.value});declarations.push(`DECLARE ${v} ${type}=CONVERT(${type},@${n}${/binary/.test(p.type)?',1':p.type==='xml'?'':',126'});`);
        if(!/^@[\p{L}_][\p{L}\p{N}_@$#]*$/u.test(p.name))throw fail('Имя параметра требует SQL-редактора.');
        args.push(`${p.name}=${v}${p.output?' OUTPUT':''}`);if(p.output)outputs.push({name:p.name,variable:v,type:p.type});
      }
      const marker='__studio_return_'+randomUUID().replaceAll('-','');
      const command=`${declarations.join('\n')}\nDECLARE @studio_return int;EXEC @studio_return=${q(proc.schema)}.${q(proc.name)} ${args.join(',')};\nSELECT @studio_return AS ${q(marker)}${outputs.map((o,i)=>`,CONVERT(nvarchar(max),${o.variable},${/binary/.test(o.type)?1:o.type==='xml'?0:126}) AS ${q('output'+i)}`).join('')};`;
      const execute=()=>executeScript(pool,{sql:command,id:req.body.id||randomUUID(),timeout:req.body.timeout||60},cancel=>{disconnect=()=>{if(!res.writableEnded)cancel('Клиент отключился.');};res.on('close',disconnect);},{outputMarker:marker,configureRequest:r=>{for(const b of bindings)r.input(b.name,sql.NVarChar(sql.MAX),b.value);}});
      const data=await ddlHistory.run(req.params.database,`EXEC ${q(proc.schema)}.${q(proc.name)}; -- Значения параметров не сохраняются`,execute);
      const values=data.procedureOutput;delete data.procedureOutput;
      return {...data,returnValue:values?.[0]??null,output:Object.fromEntries(outputs.map((o,i)=>[o.name,values?.[i+1]??null]))};
    },{audit:false});res.json(result);}finally{if(disconnect)res.off('close',disconnect);}
  });
}
