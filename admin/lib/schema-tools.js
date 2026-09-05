export async function readSchema(withDb, database) {
  const r = await withDb(database,p => p.request().query(`
    SELECT s.name [schema],t.name,t.temporal_type temporal,t.is_memory_optimized memoryOptimized FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name;
    SELECT SCHEMA_NAME(t.schema_id) [schema],t.name [table],c.name,c.column_id ordinal,ty.name type,SCHEMA_NAME(ty.schema_id) typeSchema,ty.is_user_defined userType,c.max_length maxLength,c.precision,c.scale,c.is_nullable nullable,c.is_identity [identity],CONVERT(nvarchar(60),ic.seed_value) seed,CONVERT(nvarchar(60),ic.increment_value) increment,cc.definition expression,cc.is_persisted persisted,dc.definition [default],c.collation_name collation
    FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE t.is_ms_shipped=0 ORDER BY t.object_id,c.column_id;
    SELECT SCHEMA_NAME(t.schema_id) [schema],t.name [table],i.name,i.type_desc kind,i.is_unique [unique],i.is_primary_key primaryKey,i.is_unique_constraint uniqueConstraint,i.filter_definition filter,
      STRING_AGG(CONVERT(nvarchar(max),CASE WHEN ic.is_included_column=0 THEN QUOTENAME(c.name)+CASE WHEN ic.is_descending_key=1 THEN ' DESC' ELSE ' ASC' END END),', ') WITHIN GROUP(ORDER BY ic.key_ordinal,ic.index_column_id) columns,
      STRING_AGG(CONVERT(nvarchar(max),CASE WHEN ic.is_included_column=1 THEN QUOTENAME(c.name) END),', ') WITHIN GROUP(ORDER BY ic.key_ordinal,ic.index_column_id) included
    FROM sys.tables t JOIN sys.indexes i ON i.object_id=t.object_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE t.is_ms_shipped=0 AND i.index_id>0 AND i.is_hypothetical=0 GROUP BY t.schema_id,t.name,i.name,i.type_desc,i.is_unique,i.is_primary_key,i.is_unique_constraint,i.filter_definition;
    SELECT SCHEMA_NAME(t.schema_id) [schema],t.name [table],fk.name,SCHEMA_NAME(rt.schema_id) refSchema,rt.name refTable,fk.delete_referential_action_desc onDelete,fk.update_referential_action_desc onUpdate,fk.is_disabled disabled,fk.is_not_trusted untrusted,STRING_AGG(CONVERT(nvarchar(max),QUOTENAME(c.name)),', ') WITHIN GROUP(ORDER BY fc.constraint_column_id) columns,STRING_AGG(CONVERT(nvarchar(max),QUOTENAME(rc.name)),', ') WITHIN GROUP(ORDER BY fc.constraint_column_id) refColumns
    FROM sys.foreign_keys fk JOIN sys.tables t ON t.object_id=fk.parent_object_id JOIN sys.tables rt ON rt.object_id=fk.referenced_object_id JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=fk.object_id JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=fc.parent_column_id JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fc.referenced_column_id WHERE t.is_ms_shipped=0 GROUP BY t.schema_id,t.name,fk.name,rt.schema_id,rt.name,fk.delete_referential_action_desc,fk.update_referential_action_desc,fk.is_disabled,fk.is_not_trusted;
    SELECT SCHEMA_NAME(t.schema_id) [schema],t.name [table],c.name,c.definition,c.is_disabled disabled,c.is_not_trusted untrusted FROM sys.check_constraints c JOIN sys.tables t ON t.object_id=c.parent_object_id WHERE t.is_ms_shipped=0;
    SELECT SCHEMA_NAME(o.schema_id) [schema],o.name,o.type,m.definition FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.is_ms_shipped=0 AND o.type IN ('V','P','FN','IF','TF','TR') ORDER BY o.type,o.name;
  `));
  const [tables,columns,indexes,foreignKeys,checks,modules] = r.recordsets;
  return { tables: tables.map(t => ({ ...t, columns: columns.filter(c => c.schema===t.schema && c.table===t.name), indexes: indexes.filter(c=>c.schema===t.schema&&c.table===t.name), foreignKeys: foreignKeys.filter(c=>c.schema===t.schema&&c.table===t.name), checks: checks.filter(c=>c.schema===t.schema&&c.table===t.name) })), modules };
}
const q = s => `[${s.replaceAll(']', ']]')}]`, full = t => `${q(t.schema)}.${q(t.name)}`;
export function typeSQL(c) {
  if(c.userType)return `${q(c.typeSchema)}.${q(c.type)}`;
  if(/^(n?varchar|n?char|varbinary|binary)$/i.test(c.type))return `${c.type}(${c.maxLength===-1?'MAX':c.maxLength/(c.type.startsWith('n')?2:1)})`;
  if(/^(decimal|numeric)$/i.test(c.type))return `${c.type}(${c.precision},${c.scale})`;
  if(/^(time|datetime2|datetimeoffset)$/i.test(c.type))return `${c.type}(${c.scale})`;
  if(c.type==='float')return `float(${c.precision})`;
  return c.type;
}
const columnSQL = c => `${q(c.name)} ${c.expression?`AS ${c.expression}${c.persisted?' PERSISTED':''}`:`${typeSQL(c)}${c.collation?' COLLATE '+c.collation:''}${c.identity?` IDENTITY(${c.seed},${c.increment})`:''} ${c.nullable?'NULL':'NOT NULL'}${c.default?' DEFAULT '+c.default:''}`}`;
export function compareSchemas(source, target) {
  const changes=[], commands=[], warnings=[], later=[];
  const add=(kind,object,before,after,sql) => { changes.push({kind,object,before,after}); if(sql)commands.push(sql); };
  for(const t of source.tables) {
    const targetTable=target.tables.find(x=>x.schema===t.schema&&x.name===t.name), name=full(t);
    for(const c of t.columns)if(c.userType)warnings.push(`${name}.${q(c.name)}: пользовательский тип ${q(c.typeSchema)}.${q(c.type)} должен существовать в приёмнике.`);
    if(t.temporal||t.memoryOptimized) { warnings.push(`${name}: temporal/memory-optimized — перенос через специализированный DDL.`); continue; }
    if(!targetTable) {
      commands.push(`IF SCHEMA_ID(N'${t.schema.replaceAll("'","''")}') IS NULL EXEC(N'CREATE SCHEMA ${q(t.schema).replaceAll("'","''")}');`);
      add('Добавить таблицу',name,null,t.columns.map(columnSQL).join('\n'),`CREATE TABLE ${name} (\n  ${t.columns.map(columnSQL).join(',\n  ')}\n);`);
    } else {
      for(const c of t.columns) {
        const old=targetTable.columns.find(x=>x.name===c.name);
        if(!old) add('Добавить столбец',`${name}.${q(c.name)}`,null,columnSQL(c),`ALTER TABLE ${name} ADD ${columnSQL(c)};`);
        else if(columnSQL(c)!==columnSQL(old)) {
          const complex=c.expression||old.expression||c.identity!==old.identity||c.seed!==old.seed||c.increment!==old.increment||c.default!==old.default;
          add('Изменить столбец',`${name}.${q(c.name)}`,columnSQL(old),columnSQL(c),complex?null:`ALTER TABLE ${name} ALTER COLUMN ${q(c.name)} ${typeSQL(c)}${c.collation?' COLLATE '+c.collation:''} ${c.nullable?'NULL':'NOT NULL'};`);
          warnings.push(`${name}.${q(c.name)}: ${complex?'IDENTITY / вычисление / DEFAULT требуют отдельной миграции.':'Проверьте данные и зависимые индексы/ограничения перед ALTER COLUMN.'}`);
        }
      }
      for(const c of targetTable.columns.filter(c=>!t.columns.some(x=>x.name===c.name))) add('Только в приёмнике',`${name}.${q(c.name)}`,columnSQL(c),null);
    }
    for(const i of t.indexes) {
      const old=targetTable?.indexes.find(x=>x.name===i.name);
      if(old&&JSON.stringify(old)===JSON.stringify(i))continue;
      if(!['CLUSTERED','NONCLUSTERED'].includes(i.kind)){warnings.push(`${name}.${q(i.name)}: специальный индекс требует ручного DDL.`);continue;}
      const statement=i.primaryKey||i.uniqueConstraint?`ALTER TABLE ${name} ADD CONSTRAINT ${q(i.name)} ${i.primaryKey?'PRIMARY KEY':'UNIQUE'} ${i.kind} (${i.columns});`:`CREATE ${i.unique?'UNIQUE ':''}${i.kind} INDEX ${q(i.name)} ON ${name} (${i.columns})${i.included?' INCLUDE ('+i.included+')':''}${i.filter?' WHERE '+i.filter:''};`;
      add(old?'Изменить индекс/ключ':'Добавить индекс/ключ',`${name}.${q(i.name)}`,old?JSON.stringify(old):null,statement,old?null:statement);
      if(old)warnings.push(`${name}.${q(i.name)}: существующий индекс/ключ отличается; удалите зависимости и перестройте вручную по DDL из сравнения.`);
    }
    for(const fk of t.foreignKeys) {
      const old=targetTable?.foreignKeys.find(x=>x.name===fk.name);
      if(old&&JSON.stringify(old)===JSON.stringify(fk))continue;
      const ddl=`ALTER TABLE ${name} WITH ${fk.untrusted?'NOCHECK':'CHECK'} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns}) REFERENCES ${q(fk.refSchema)}.${q(fk.refTable)} (${fk.refColumns}) ON DELETE ${fk.onDelete.replaceAll('_',' ')} ON UPDATE ${fk.onUpdate.replaceAll('_',' ')};${fk.disabled?`\nALTER TABLE ${name} NOCHECK CONSTRAINT ${q(fk.name)};`:''}`;
      add(old?'Изменить FK':'Добавить FK',`${name}.${q(fk.name)}`,old?JSON.stringify(old):null,ddl);
      later.push(`${old?`ALTER TABLE ${name} DROP CONSTRAINT ${q(fk.name)};\n`:''}${ddl}`);
    }
    for(const check of t.checks) {
      const old=targetTable?.checks.find(x=>x.name===check.name);if(old&&JSON.stringify(old)===JSON.stringify(check))continue;
      const ddl=`${old?`ALTER TABLE ${name} DROP CONSTRAINT ${q(check.name)};\n`:''}ALTER TABLE ${name} WITH ${check.untrusted?'NOCHECK':'CHECK'} ADD CONSTRAINT ${q(check.name)} CHECK ${check.definition};${check.disabled?`\nALTER TABLE ${name} NOCHECK CONSTRAINT ${q(check.name)};`:''}`;
      add('CHECK',`${name}.${q(check.name)}`,old?.definition,check.definition,ddl);
    }
    for(const kind of ['indexes','foreignKeys','checks'])for(const x of targetTable?.[kind]||[])if(!t[kind].some(y=>y.name===x.name))add('Только в приёмнике',`${name}.${q(x.name)}`,JSON.stringify(x),null);
  }
  commands.push(...later);
  for(const t of target.tables.filter(t=>!source.tables.some(x=>x.schema===t.schema&&x.name===t.name)))add('Только в приёмнике',full(t),'Таблица',null);
  for(const m of source.modules) {
    const old=target.modules.find(x=>x.schema===m.schema&&x.name===m.name&&x.type===m.type);
    if(!m.definition){warnings.push(`${full(m)}: определение недоступно.`);continue;}
    const normalize=text=>text?.replace(/^\s*(CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+/i,'CREATE ').trim();
    if(normalize(old?.definition)===normalize(m.definition))continue;
    commands.push(`IF SCHEMA_ID(N'${m.schema.replaceAll("'","''")}') IS NULL EXEC(N'CREATE SCHEMA ${q(m.schema).replaceAll("'","''")}');`);
    add('SQL-объект',full(m),old?.definition,m.definition,m.definition.replace(/^\s*(CREATE|ALTER)(?!\s+OR\s+ALTER)\s+/i,'CREATE OR ALTER '));
  }
  for(const m of target.modules.filter(m=>!source.modules.some(x=>x.schema===m.schema&&x.name===m.name&&x.type===m.type)))add('Только в приёмнике',full(m),m.definition,null);
  return { changes, warnings, sql: ['-- Миграция: проверьте зависимости, данные и порядок SQL-объектов.\n-- Объекты только в приёмнике не удаляются.\n-- Типы пользователя и специальные свойства требуют отдельного переноса.',...commands].join('\nGO\n') };
}
export function installSchemaTools(app,{withDb,connections,fail}) {
  app.get('/api/databases/:database/completion',async(req,res)=>{
    const r=await withDb(req.params.database,p=>p.request().query("SELECT SCHEMA_NAME(o.schema_id) [schema],o.name [table],c.name FROM sys.objects o JOIN sys.columns c ON c.object_id=o.object_id WHERE o.type IN ('U','V') AND o.is_ms_shipped=0 ORDER BY o.schema_id,o.name,c.column_id"));
    const schema=Object.create(null);for(const c of r.recordset){schema[c.schema]??=Object.create(null);schema[c.schema][c.table]??=[];schema[c.schema][c.table].push(c.name);}res.json(schema);
  });
  app.post('/api/schema-compare',async(req,res)=>{
    const b=req.body;if(!b.sourceDatabase||!b.targetDatabase)throw fail('Выберите источник и приёмник.');
    const [source,target]=await Promise.all([connections.run(b.sourceConnection||connections.get().id,()=>readSchema(withDb,b.sourceDatabase)),connections.run(b.targetConnection||connections.get().id,()=>readSchema(withDb,b.targetDatabase))]);
    res.json(compareSchemas(source,target));
  });
}
