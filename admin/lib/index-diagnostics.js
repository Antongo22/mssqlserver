export function installIndexDiagnostics(app,{withDb,sql,fail}){
  app.get('/api/databases/:database/index-diagnostics',async(req,res)=>{
    const objectId=Number(req.query.objectId),indexId=Number(req.query.indexId);if(!Number.isInteger(objectId)||objectId<1||!Number.isInteger(indexId)||indexId<1)throw fail('Выберите индекс.');
    const data=await withDb(req.params.database,async p=>{
      const r=await p.request().input('object',sql.Int,objectId).input('idx',sql.Int,indexId).query(`
        SELECT i.type typeId,i.name FROM sys.indexes i JOIN sys.objects o ON o.object_id=i.object_id WHERE i.object_id=@object AND i.index_id=@idx AND o.is_ms_shipped=0;
        SELECT CONVERT(varchar(30),SUM(row_count)) [rows],CAST(SUM(reserved_page_count)*8.0/1024 AS decimal(20,2)) sizeMB,CONVERT(varchar(30),SUM(used_page_count)) pages FROM sys.dm_db_partition_stats WHERE object_id=@object AND index_id=@idx;
        SELECT CONVERT(varchar(30),user_seeks) seeks,CONVERT(varchar(30),user_scans) scans,CONVERT(varchar(30),user_lookups) lookups,CONVERT(varchar(30),user_updates) updates,last_user_seek lastSeek,last_user_scan lastScan,last_user_update lastUpdate FROM sys.dm_db_index_usage_stats WHERE database_id=DB_ID() AND object_id=@object AND index_id=@idx;
        SELECT sqlserver_start_time startedAt FROM sys.dm_os_sys_info;`);
      if(!r.recordsets[0].length)throw fail('Индекс не найден.',404);
      let fragmentation=[];if([1,2].includes(r.recordsets[0][0].typeId))fragmentation=(await p.request().input('object',sql.Int,objectId).input('idx',sql.Int,indexId).query("SELECT partition_number partitionNumber,avg_fragmentation_in_percent fragmentation,CONVERT(varchar(30),page_count) pages FROM sys.dm_db_index_physical_stats(DB_ID(),@object,@idx,NULL,'LIMITED') WHERE index_level=0 AND alloc_unit_type_desc='IN_ROW_DATA'")).recordset;
      return {index:r.recordsets[0][0],size:r.recordsets[1][0],usage:r.recordsets[2][0]||null,startedAt:r.recordsets[3][0].startedAt,fragmentation};
    });res.json(data);
  });
}
