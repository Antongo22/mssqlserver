const quote=name=>'['+name.replaceAll(']',']]')+']';
function typeName(c){
  if(c.userDefined)return `${quote(c.typeSchema)}.${quote(c.typeName)}`;
  let t=c.typeName;
  if(['nvarchar','nchar','varchar','char','binary','varbinary'].includes(t))t+=`(${c.maxLength===-1?'MAX':c.maxLength/(t.startsWith('n')?2:1)})`;
  else if(['decimal','numeric'].includes(t))t+=`(${c.precision},${c.scale})`;
  else if(['time','datetime2','datetimeoffset'].includes(t))t+=`(${c.scale})`;
  return t;
}
export function installCatalogDetails(app,{withDb,sql,fail}){
  const root='/api/databases/:database';
  function objectId(value){const id=Number(value);if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw fail('Некорректный ID объекта.');return id;}
  app.get(root+'/indexes',async(req,res)=>{
    const id=req.query.objectId===undefined?null:objectId(req.query.objectId);
    const r=await withDb(req.params.database,p=>p.request().input('id',sql.Int,id).query(`
      SELECT i.object_id objectId,i.index_id indexId,s.name [schema],o.name [table],i.name,i.type typeId,i.type_desc kind,
        i.is_unique [unique],i.is_primary_key primaryKey,i.is_unique_constraint uniqueConstraint,i.is_disabled disabled,
        i.is_hypothetical hypothetical,i.has_filter hasFilter,i.filter_definition filter,i.fill_factor [fillFactor],
        i.allow_row_locks allowRowLocks,i.allow_page_locks allowPageLocks,d.name dataSpace,d.type_desc dataSpaceKind
      FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id
      LEFT JOIN sys.data_spaces d ON d.data_space_id=i.data_space_id
      WHERE o.is_ms_shipped=0 AND o.type IN ('U','V') AND i.index_id>0 AND (@id IS NULL OR o.object_id=@id)
      ORDER BY s.name,o.name,i.index_id;
      SELECT ic.object_id objectId,ic.index_id indexId,c.name,ic.key_ordinal keyOrdinal,ic.index_column_id position,
        ic.is_descending_key [descending],ic.is_included_column included,ic.partition_ordinal partitionOrdinal
      FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
      JOIN sys.objects o ON o.object_id=ic.object_id WHERE o.is_ms_shipped=0 AND o.type IN ('U','V') AND ic.index_id>0 AND (@id IS NULL OR o.object_id=@id)
      ORDER BY ic.object_id,ic.index_id,ic.index_column_id;`));
    const columns=new Map();for(const c of r.recordsets[1]){const key=c.objectId+':'+c.indexId;if(!columns.has(key))columns.set(key,[]);columns.get(key).push(c);}
    res.json({indexes:r.recordsets[0].map(i=>({...i,columns:columns.get(i.objectId+':'+i.indexId)||[]}))});
  });
  app.get(root+'/objects/:id/details',async(req,res)=>{
    const id=objectId(req.params.id);
    const r=await withDb(req.params.database,p=>p.request().input('id',sql.Int,id).query(`
      SELECT o.object_id id,s.name [schema],o.name,o.type,o.type_desc kind,o.create_date createdAt,o.modify_date modifiedAt,
        OBJECT_SCHEMA_NAME(o.parent_object_id) parentSchema,OBJECT_NAME(o.parent_object_id) parentName,
        CONVERT(bit,OBJECTPROPERTYEX(o.object_id,'IsEncrypted')) encrypted,m.definition,m.uses_ansi_nulls ansiNulls,m.uses_quoted_identifier quotedIdentifier
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id
      WHERE o.object_id=@id AND o.is_ms_shipped=0;
      SELECT p.parameter_id id,p.name,t.name typeName,SCHEMA_NAME(t.schema_id) typeSchema,t.is_user_defined userDefined,t.is_table_type tableType,
        p.max_length maxLength,p.precision,p.scale,p.is_output [output],p.is_readonly [readOnly]
      FROM sys.parameters p JOIN sys.types t ON t.user_type_id=p.user_type_id WHERE p.object_id=@id ORDER BY p.parameter_id;
      SELECT c.column_id id,c.name,t.name typeName,SCHEMA_NAME(t.schema_id) typeSchema,t.is_user_defined userDefined,c.max_length maxLength,c.precision,c.scale,c.is_nullable nullable
      FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=@id ORDER BY c.column_id;
      SELECT DISTINCT referenced_server_name server,referenced_database_name [database],referenced_schema_name [schema],referenced_entity_name name,is_schema_bound_reference schemaBound
      FROM sys.sql_expression_dependencies WHERE referencing_id=@id;
      SELECT DISTINCT OBJECT_SCHEMA_NAME(referencing_id) [schema],OBJECT_NAME(referencing_id) name
      FROM sys.sql_expression_dependencies WHERE referenced_id=@id;
      SELECT is_disabled disabled,is_instead_of_trigger insteadOf,is_not_for_replication notForReplication FROM sys.triggers WHERE object_id=@id;
      SELECT type_desc [event] FROM sys.trigger_events WHERE object_id=@id ORDER BY type_desc;
      SELECT CONVERT(nvarchar(128),start_value) startValue,CONVERT(nvarchar(128),increment) [increment],
        CONVERT(nvarchar(128),minimum_value) minimum,CONVERT(nvarchar(128),maximum_value) maximum,
        CONVERT(nvarchar(128),current_value) currentValue,is_cycling cycling,is_cached cached,CONVERT(varchar(30),cache_size) cacheSize,TYPE_NAME(user_type_id) typeName
      FROM sys.sequences WHERE object_id=@id;
      SELECT base_object_name target FROM sys.synonyms WHERE object_id=@id;`));
    const object=r.recordsets[0][0];if(!object)throw fail('Объект не найден или недоступен текущему логину.',404);
    res.json({...object,parameters:r.recordsets[1].map(c=>({...c,sqlType:typeName(c)})),columns:r.recordsets[2].map(c=>({...c,sqlType:typeName(c)})),dependencies:r.recordsets[3],dependents:r.recordsets[4],trigger:r.recordsets[5][0]||null,events:r.recordsets[6],sequence:r.recordsets[7][0]||null,synonym:r.recordsets[8][0]||null});
  });
}
