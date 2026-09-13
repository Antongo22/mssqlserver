import {randomUUID} from 'node:crypto';
export function installDataCompare(app,{withDb,sql,identifier:q,fail,connections,tableData:{metadata,cell,hash}}){
  const plans=new Map(),limit=10000,maxBytes=16*1024*1024;
  const cleanup=()=>{for(const [id,p] of plans)if(p.expires<Date.now())plans.delete(id);};
  const profile=c=>JSON.stringify(connections.get(c));
  async function snapshot(side){
    q(side.database);q(side.schema);q(side.name);
    return connections.run(side.connection,()=>withDb(side.database,async pool=>{
      const columns=await metadata(pool,side.schema,side.name);const pk=columns.filter(c=>c.primaryKey);if(!pk.length)throw fail('Обе таблицы должны иметь первичный ключ.');
      const r=await pool.request().query(`SELECT TOP(${limit+1}) ${columns.map((c,i)=>`${cell(c)} AS ${q('c'+i)}`).join(',')},${hash(columns)} token FROM ${q(side.schema)}.${q(side.name)} t ORDER BY ${pk.map(c=>'t.'+q(c.name)).join(',')}`);
      if(r.recordset.length>limit)throw fail(`Сравнение ограничено ${limit} строками на таблицу. Полное сравнение не выполнено.`);
      if(Buffer.byteLength(JSON.stringify(r.recordset))>maxBytes)throw fail('Таблица превышает 16 МБ для сравнения.');
      return {columns,rows:r.recordset.map(r=>({values:columns.map((_,i)=>r['c'+i]),token:r.token}))};
    }));
  }
  const literal=(c,v)=>v===null?'NULL':`CONVERT(${c.sqlType},N'${v.replaceAll("'","''")}',${/binary/.test(c.type)?1:126})`;
  app.post('/api/data-compare',async(req,res)=>{
    const {source,target}=req.body;if(!source||!target)throw fail('Выберите источник и приёмник.');
    for(const side of [source,target]){side.connection||=connections.get().id;side.schema||='dbo';}
    if(source.connection===target.connection&&source.database===target.database&&source.schema===target.schema&&source.name===target.name)throw fail('Выберите разные таблицы.');
    const sourceProfile=profile(source.connection),targetProfile=profile(target.connection),[a,b]=await Promise.all([snapshot(source),snapshot(target)]);
    if(sourceProfile!==profile(source.connection)||targetProfile!==profile(target.connection))throw fail('Подключение изменилось. Повторите сравнение.');
    const columns=b.columns.filter(c=>!c.computed&&!c.generated&&!['timestamp','rowversion'].includes(c.type));
    if(columns.some(c=>!c.writable&&!c.identity)||columns.some(c=>{const s=a.columns.find(x=>x.name===c.name);return !s||s.sqlType!==c.sqlType||s.primaryKey!==c.primaryKey;}))throw fail('Нужны одинаковые типы и ключи сопоставляемых столбцов. Специальные типы не поддерживаются.');
    const pk=columns.filter(c=>c.primaryKey);if(!pk.length||a.columns.filter(c=>c.primaryKey).length!==pk.length)throw fail('Первичные ключи различаются.');
    const values=(snapshot,row)=>Object.fromEntries(snapshot.columns.map((c,i)=>[c.name,row.values[i]]));
    const key=v=>JSON.stringify(pk.map(c=>v[c.name]));
    const map=new Map(b.rows.map(r=>{const v=values(b,r);return [key(v),{values:v,token:r.token}];})),changes=[];let same=0;
    for(const row of a.rows){const v=values(a,row),k=key(v),old=map.get(k);map.delete(k);if(!old)changes.push({kind:'insert',after:v,key:JSON.parse(k)});else if(columns.some(c=>v[c.name]!==old.values[c.name]))changes.push({kind:'update',before:old.values,after:v,token:old.token,key:JSON.parse(k)});else same++;}
    for(const [k,old] of map)changes.push({kind:'delete',before:old.values,token:old.token,key:JSON.parse(k)});
    const counts={insert:0,update:0,delete:0,same};for(const c of changes)counts[c.kind]++;
    const full=`${q(target.schema)}.${q(target.name)}`,statements=[];
    for(const change of changes){
      const data=change.after||change.before,where=pk.map(c=>`t.${q(c.name)}=${literal(c,data[c.name])}`).join(' AND ');
      if(change.kind==='insert'){
        statements.push(`IF EXISTS(SELECT 1 FROM ${full} t WITH(UPDLOCK,HOLDLOCK) WHERE ${where}) THROW 50010,N'Новая строка уже появилась в приёмнике. Повторите сравнение.',1;\nINSERT INTO ${full} (${columns.map(c=>q(c.name))}) VALUES (${columns.map(c=>literal(c,change.after[c.name]))});`);
      }else{
        if(change.kind==='update'&&columns.some(c=>c.identity&&change.before[c.name]!==change.after[c.name]))throw fail('Значения IDENTITY вне первичного ключа различаются. Требуется ручной перенос.');
        const writable=columns.filter(c=>c.writable&&!c.primaryKey);if(change.kind==='update'&&!writable.length)throw fail('Нет изменяемых столбцов.');
        statements.push(`${change.kind==='delete'?'DELETE t':`UPDATE t SET ${writable.map(c=>q(c.name)+'='+literal(c,change.after[c.name])).join(',')}`} FROM ${full} t WITH(UPDLOCK,HOLDLOCK) WHERE ${where} AND ${hash(b.columns)}='${change.token}';\nIF @@ROWCOUNT<>1 THROW 50010,N'Строка приёмника изменилась. Повторите сравнение.',1;`);
      }
    }
    const identity=columns.some(c=>c.identity)&&counts.insert>0;
    const command=`SET XACT_ABORT ON;SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nBEGIN TRY\nBEGIN TRANSACTION;\n${identity?'SET IDENTITY_INSERT '+full+' ON;\n':''}${statements.join('\n')}\n${identity?'SET IDENTITY_INSERT '+full+' OFF;\n':''}COMMIT;\nEND TRY BEGIN CATCH\nIF @@TRANCOUNT>0 ROLLBACK;\n${identity?'SET IDENTITY_INSERT '+full+' OFF;\n':''}THROW;\nEND CATCH;`;
    cleanup();if(plans.size>=10)throw fail('Уже подготовлено 10 сравнений. Закройте их или повторите через 10 минут.');
    const executable=changes.length<=500&&Buffer.byteLength(command)<=1024*1024;
    const id=randomUUID();if(executable)plans.set(id,{target,targetProfile,sql:command,expires:Date.now()+600000,changes:changes.length});
    res.json({id:executable?id:null,counts,changes:changes.slice(0,500),truncated:changes.length>500,sql:executable?command:null,target,executable,limit,expiresInSeconds:600});
  });
  app.post('/api/data-compare/:id/apply',async(req,res)=>{
    cleanup();const plan=plans.get(req.params.id);if(!plan)throw fail('Сравнение истекло или уже применено. Повторите его.',409);
    if(connections.get().id!==plan.target.connection)throw fail('Выберите подключение приёмника.',409);
    if(profile(plan.target.connection)!==plan.targetProfile)throw fail('Подключение приёмника изменилось. Повторите сравнение.',409);
    if(req.body.confirm!==plan.target.database+'.'+plan.target.schema+'.'+plan.target.name)throw fail('Подтвердите полное имя приёмника.');
    plans.delete(req.params.id);await withDb(plan.target.database,p=>p.request().batch(plan.sql));res.json({ok:true,changes:plan.changes});
  });
}
