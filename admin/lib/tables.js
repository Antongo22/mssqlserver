export function installTables(app, { withDb, sql, identifier: q, fail }) {
  const root = '/api/databases/:database/data';
  const typeName = c => {
    const type = c.type.toLowerCase();
    if (['nvarchar','nchar','varchar','char','varbinary','binary'].includes(type)) return `${type}(${c.maxLength === -1 ? 'max' : c.maxLength / (type.startsWith('n') ? 2 : 1)})`;
    if (['decimal','numeric'].includes(type)) return `${type}(${c.precision},${c.scale})`;
    if (['datetime2','datetimeoffset','time'].includes(type)) return `${type}(${c.scale})`;
    return type;
  };
  const writableTypes = new Set(['int','bigint','smallint','tinyint','bit','decimal','numeric','money','smallmoney','float','real','nvarchar','nchar','varchar','char','date','datetime','datetime2','datetimeoffset','smalldatetime','time','uniqueidentifier','binary','varbinary','xml']);
  async function metadata(p, schema, name) {
    const full = `${q(schema)}.${q(name)}`;
    const r = await p.request().input('object', sql.NVarChar(520), full).query(`
      SELECT c.name,ty.name type,c.max_length maxLength,c.precision,c.scale,c.is_nullable nullable,
        c.is_identity [identity],c.is_computed computed,c.generated_always_type generated,
        dc.definition [default],cc.definition expression,ic.seed_value seed,ic.increment_value increment,
        CONVERT(bit,CASE WHEN EXISTS(SELECT 1 FROM sys.index_columns x JOIN sys.indexes i
          ON i.object_id=x.object_id AND i.index_id=x.index_id WHERE i.is_primary_key=1
          AND x.object_id=c.object_id AND x.column_id=c.column_id) THEN 1 ELSE 0 END) primaryKey
      FROM sys.columns c JOIN sys.types ty ON ty.user_type_id=c.user_type_id
      LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id
      LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id
      LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id
      WHERE c.object_id=OBJECT_ID(@object,'U') ORDER BY c.column_id;`);
    if (!r.recordset.length) throw fail('Таблица не найдена.', 404);
    return r.recordset.map(c => ({ ...c, sqlType: typeName(c), writable: !c.identity && !c.computed && !c.generated && writableTypes.has(c.type) }));
  }
  const cell = c => `CONVERT(nvarchar(max),t.${q(c.name)},${['binary','varbinary','timestamp','rowversion'].includes(c.type) ? 1 : 126})`;
  const hash = cols => `CONVERT(varchar(64),HASHBYTES('SHA2_256',(SELECT ${cols.map((c,i) => `${cell(c)} AS ${q('c'+i)}`).join(',')} FOR JSON PATH,INCLUDE_NULL_VALUES,WITHOUT_ARRAY_WRAPPER)),2)`;
  function parameter(request, column, value, name) {
    if (value !== null && typeof value !== 'string') throw fail('Значения ячеек должны быть строками или NULL.');
    request.input(name, sql.NVarChar(sql.MAX), value);
    // Convert on SQL Server to preserve BIGINT/DECIMAL precision and date offsets.
    return `CONVERT(${column.sqlType},@${name}${['binary','varbinary'].includes(column.type) ? ',1' : ',126'})`;
  }
  app.get(root, async (req, res) => {
    const { schema = 'dbo', name, filterColumn, filter = '', sort, direction = 'ASC' } = req.query;
    const page = Number(req.query.page || 0), pageSize = Number(req.query.pageSize || 50);
    if (!Number.isInteger(page) || page < 0 || page > 100000 || ![25,50,100].includes(pageSize) || !['ASC','DESC'].includes(direction)) throw fail('Некорректные параметры страницы.');
    const result = await withDb(req.params.database, async p => {
      const columns = await metadata(p, schema, name), pk = columns.filter(c => c.primaryKey);
      const sortColumn = columns.find(c => c.name === sort) || pk[0] || columns[0];
      if (filterColumn && !columns.some(c => c.name === filterColumn)) throw fail('Столбец фильтра не найден.');
      const request = p.request().input('offset', sql.Int, page * pageSize).input('limit', sql.Int, pageSize + 1)
        .input('filter', sql.NVarChar(2000), String(filter));
      const where = filterColumn && filter ? `WHERE CHARINDEX(@filter,CONVERT(nvarchar(max),t.${q(filterColumn)}))>0` : '';
      // Sort on the native type where supported; XML and LOBs use their text value.
      const order = ['xml','text','ntext','image'].includes(sortColumn.type) ? cell(sortColumn) : `t.${q(sortColumn.name)}`;
      const tie = pk.filter(c => c.name !== sortColumn.name).map(c => `,t.${q(c.name)}`).join('');
      const r = await request.query(`SELECT ${columns.map((c,i) => `${cell(c)} AS ${q('c'+i)}`).join(',')},${hash(columns)} AS token
        FROM ${q(schema)}.${q(name)} t ${where} ORDER BY ${order} ${direction}${tie} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`);
      return { columns, rows: r.recordset.slice(0,pageSize).map(row => ({ values: columns.map((c,i) => row['c'+i]), token: row.token })),
        hasMore: r.recordset.length > pageSize, page, pageSize, editable: !!pk.length && pk.every(c => writableTypes.has(c.type)), sort: sortColumn.name };
    }); res.json(result);
  });
  app.post(root, async (req,res) => mutate(req,res,'insert'));
  app.patch(root, async (req,res) => mutate(req,res,'update'));
  app.delete(root, async (req,res) => mutate(req,res,'delete'));
  app.post(root + '/import/preview',async(req,res)=>{
    const {schema='dbo',name,records}=req.body;
    if(!Array.isArray(records)||records.length<1||records.length>500)throw fail('Импорт: 1–500 строк.');
    const errors=[];
    await withDb(req.params.database,async p=>{
      const columns=await metadata(p,schema,name);
      for(const [row,values] of records.entries()) {
        if(!values||typeof values!=='object'||Array.isArray(values))throw fail('Некорректная строка.');
        const request=p.request(),checks=[];
        for(const c of columns)if(c.writable&&!c.nullable&&!c.default&&!Object.hasOwn(values,c.name))errors.push({row:row+1,column:c.name,error:'Обязательный столбец не сопоставлен'});
        for(const [name,value] of Object.entries(values)){
          const c=columns.find(c=>c.name===name);
          if(!c?.writable){errors.push({row:row+1,column:name,error:'Столбец недоступен для импорта'});continue;}
          if(value===null&&!c.nullable){errors.push({row:row+1,column:name,error:'NULL запрещён'});continue;}
          const n='v'+checks.length;parameter(request,c,value,n);
          let condition=`@${n} IS NOT NULL AND TRY_CONVERT(${c.sqlType},@${n}) IS NULL`;
          if(['nvarchar','nchar'].includes(c.type)&&c.maxLength!==-1)condition+=` OR DATALENGTH(@${n})>${c.maxLength}`;
          if(['varchar','char'].includes(c.type)&&c.maxLength!==-1)condition+=` OR DATALENGTH(CONVERT(varchar(max),@${n}))>${c.maxLength}`;
          checks.push({name,sql:`SELECT ${checks.length} id WHERE ${condition}`});
        }
        if(checks.length){const r=await request.query(checks.map(c=>c.sql).join(' UNION ALL '));for(const bad of r.recordset)errors.push({row:row+1,column:checks[bad.id].name,error:'Несовместимый тип или превышена длина'});}
        if(errors.length>=100)break;
      }
    });res.json({valid:errors.length===0,errors:errors.slice(0,100),rows:records.length});
  });
  app.post(root + '/import', async (req,res) => {
    const {schema='dbo',name,records}=req.body;
    if(!Array.isArray(records)||records.length<1||records.length>500)throw fail('Импорт: от 1 до 500 записей.');
    await withDb(req.params.database,async p=>{
      const columns=await metadata(p,schema,name);
      await p.request().batch('SET XACT_ABORT ON; BEGIN TRANSACTION;');
      try{
        for(const values of records){
          if(!values||typeof values!=='object'||Array.isArray(values))throw fail('Некорректная строка CSV.');
          const r=p.request(),entries=Object.entries(values);
          if(!entries.length)throw fail('Строка CSV пуста.');
          const assignments=entries.map(([name,value],i)=>{
            const c=columns.find(c=>c.name===name);if(!c?.writable)throw fail(`Столбец ${name} недоступен для импорта.`);
            return {name:q(name),value:parameter(r,c,value,'v'+i)};
          });
          await r.batch(`INSERT INTO ${q(schema)}.${q(name)} (${assignments.map(a=>a.name)}) VALUES (${assignments.map(a=>a.value)});`);
        }
        await p.request().batch('COMMIT TRANSACTION;');
      }catch(error){await p.request().batch('IF @@TRANCOUNT>0 ROLLBACK TRANSACTION;');throw error;}
    });res.json({ok:true,inserted:records.length});
  });
  async function mutate(req,res,action) {
    const { schema = 'dbo', name, values = {}, keys, token } = req.body;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('Некорректные значения.');
    await withDb(req.params.database, async p => {
      const columns = await metadata(p,schema,name), request = p.request();
      const entries = Object.entries(values);
      const assignments = entries.map(([name,value],i) => {
        const column = columns.find(c => c.name === name);
        if (!column?.writable) throw fail(`Столбец ${name} недоступен для записи.`);
        return { name: q(name), value: parameter(request,column,value,'v'+i) };
      });
      const full = `${q(schema)}.${q(name)}`;
      if (action === 'insert') {
        await request.batch(assignments.length ? `INSERT INTO ${full} (${assignments.map(a=>a.name)}) VALUES (${assignments.map(a=>a.value)});` : `INSERT INTO ${full} DEFAULT VALUES;`);
        return;
      }
      const pk = columns.filter(c=>c.primaryKey);
      if (!pk.length || !keys || typeof keys !== 'object' || pk.some(c=>!Object.hasOwn(keys,c.name)) || typeof token !== 'string' || !/^[A-F0-9]{64}$/i.test(token)) throw fail('Для изменения нужны первичный ключ и версия строки.');
      const where = pk.map((c,i) => `t.${q(c.name)}=${parameter(request,c,keys[c.name],'k'+i)}`).join(' AND ');
      request.input('token',sql.VarChar(64),token);
      if (action === 'update' && !assignments.length) throw fail('Нет изменённых значений.');
      const statement = action === 'update' ? `UPDATE t SET ${assignments.map(a=>`${a.name}=${a.value}`)} FROM ${full} t` : `DELETE t FROM ${full} t`;
      // The PK and fingerprint are checked by the same statement under update locks.
      await request.batch(`SET XACT_ABORT ON; BEGIN TRANSACTION;
        ${statement} WHERE ${where} AND ${hash(columns)}=@token;
        IF @@ROWCOUNT <> 1 BEGIN ROLLBACK TRANSACTION; THROW 50010,N'Строка изменена или удалена другим запросом. Обновите таблицу.',1; END;
        COMMIT TRANSACTION;`);
    }); res.json({ok:true});
  }
  app.get('/api/databases/:database/structure', async (req,res) => {
    const {schema='dbo',name}=req.query;
    const result=await withDb(req.params.database,async p=>{
      const columns=await metadata(p,schema,name);
      const r=await p.request().input('object',sql.NVarChar(520),`${q(schema)}.${q(name)}`).query(`
        SELECT i.name,i.type_desc kind,i.is_unique [unique],i.is_primary_key primaryKey,i.is_unique_constraint uniqueConstraint,
          i.filter_definition filter,STRING_AGG(CONVERT(nvarchar(max),QUOTENAME(c.name)+CASE WHEN ic.is_descending_key=1 THEN ' DESC' ELSE ' ASC' END),', ') WITHIN GROUP(ORDER BY ic.key_ordinal) columns
        FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
        JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE i.object_id=OBJECT_ID(@object) AND ic.is_included_column=0 AND i.index_id>0
        GROUP BY i.name,i.type_desc,i.is_unique,i.is_primary_key,i.is_unique_constraint,i.filter_definition;
        SELECT fk.name,SCHEMA_NAME(rt.schema_id) refSchema,rt.name refTable,pc.name [column],rc.name refColumn,
          fk.delete_referential_action_desc onDelete,fk.update_referential_action_desc onUpdate
        FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
        JOIN sys.tables rt ON rt.object_id=fk.referenced_object_id
        JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id
        JOIN sys.columns rc ON rc.object_id=fkc.referenced_object_id AND rc.column_id=fkc.referenced_column_id
        WHERE fk.parent_object_id=OBJECT_ID(@object) ORDER BY fk.name,fkc.constraint_column_id;
        SELECT name,definition,'CHECK' kind FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(@object)
        UNION ALL SELECT name,definition,'DEFAULT' FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(@object);`);
      return {columns,indexes:r.recordsets[0],foreignKeys:r.recordsets[1],constraints:r.recordsets[2]};
    }); res.json(result);
  });
  function checkedType(type) {
    if(typeof type!=='string'|| !/^(?:INT|BIGINT|SMALLINT|TINYINT|BIT|DATE|DATETIME|DATETIME2|DATETIMEOFFSET|TIME|UNIQUEIDENTIFIER|MONEY|FLOAT|REAL|XML|(?:N?VARCHAR|N?CHAR|VARBINARY|BINARY)\((?:MAX|[1-9]\d{0,3})\)|(?:DECIMAL|NUMERIC)\(\d{1,2},\d{1,2}\))$/i.test(type)) throw fail('Некорректный SQL-тип.');
    return type.toUpperCase();
  }
  app.post('/api/databases/:database/structure',async(req,res)=>{
    const b=req.body, full=`${q(b.schema||'dbo')}.${q(b.name)}`;
    const destructive=['dropTable','truncate','dropColumn','dropIndex','dropConstraint','alterColumn'];
    if(!b.preview&&destructive.includes(b.action)&&b.confirm!==b.name)throw fail('Подтвердите имя таблицы.');
    let statement;
    switch(b.action){
      case 'addColumn':case 'alterColumn': statement=`ALTER TABLE ${full} ${b.action==='addColumn'?'ADD':'ALTER COLUMN'} ${q(b.column)} ${checkedType(b.type)} ${b.nullable?'NULL':'NOT NULL'}`;break;
      case 'dropColumn': statement=`ALTER TABLE ${full} DROP COLUMN ${q(b.column)}`;break;
      case 'dropTable': statement=`DROP TABLE ${full}`;break;
      case 'truncate': statement=`TRUNCATE TABLE ${full}`;break;
      case 'createIndex':case 'primaryKey':case 'unique':{
        if(!Array.isArray(b.columns)||!b.columns.length||b.columns.length>16)throw fail('Выберите 1–16 столбцов.');
        const cols=b.columns.map(q).join(',');
        statement=b.action==='createIndex'?`CREATE ${b.unique?'UNIQUE ':''}NONCLUSTERED INDEX ${q(b.index)} ON ${full} (${cols})`:`ALTER TABLE ${full} ADD CONSTRAINT ${q(b.index)} ${b.action==='primaryKey'?'PRIMARY KEY':'UNIQUE'} (${cols})`;break;
      }
      case 'dropIndex': statement=`DROP INDEX ${q(b.index)} ON ${full}`;break;
      case 'rebuildIndex': statement=`ALTER INDEX ${q(b.index)} ON ${full} REBUILD`;break;
      case 'dropConstraint': statement=`ALTER TABLE ${full} DROP CONSTRAINT ${q(b.constraint)}`;break;
      case 'foreignKey':{
        if(!Array.isArray(b.columns)||!b.columns.length||!Array.isArray(b.refColumns)||b.columns.length!==b.refColumns.length)throw fail('Столбцы связи должны соответствовать друг другу.');
        const action=b.onDelete||'NO ACTION';if(!['NO ACTION','CASCADE','SET NULL','SET DEFAULT'].includes(action))throw fail('Некорректное действие связи.');
        statement=`ALTER TABLE ${full} ADD CONSTRAINT ${q(b.constraint)} FOREIGN KEY (${b.columns.map(q)}) REFERENCES ${q(b.refSchema||'dbo')}.${q(b.refTable)} (${b.refColumns.map(q)}) ON DELETE ${action}`;break;
      }
      case 'rename': {
        q(b.newName);
        statement=`EXEC sys.sp_rename N'${full.replaceAll("'","''")}',N'${b.newName.replaceAll("'","''")}','OBJECT';`;break;
      }
      default:throw fail('Неизвестное действие.');
    }
    if(b.preview) {
      const dependencies=await withDb(req.params.database,p=>p.request().input('object',sql.NVarChar(520),full).query(`
        SELECT DISTINCT OBJECT_SCHEMA_NAME(d.referencing_id) [schema],OBJECT_NAME(d.referencing_id) name,'SQL dependency' kind FROM sys.sql_expression_dependencies d WHERE d.referenced_id=OBJECT_ID(@object)
        UNION SELECT OBJECT_SCHEMA_NAME(f.parent_object_id),f.name,'Incoming FK' FROM sys.foreign_keys f WHERE f.referenced_object_id=OBJECT_ID(@object)
        UNION SELECT OBJECT_SCHEMA_NAME(i.object_id),i.name,'Index/key' FROM sys.indexes i WHERE i.object_id=OBJECT_ID(@object) AND i.index_id>0
        UNION SELECT OBJECT_SCHEMA_NAME(o.parent_object_id),o.name,o.type_desc FROM sys.objects o WHERE o.parent_object_id=OBJECT_ID(@object) AND o.type IN ('F','C','D','TR');`));
      res.json({sql:statement,dependencies:dependencies.recordset,destructive:destructive.includes(b.action)});return;
    }
    await withDb(req.params.database,p=>p.request().batch(statement));res.json({ok:true});
  });
}
