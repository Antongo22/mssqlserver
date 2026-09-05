import { readdir, stat, unlink, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function installOperations(app, { withDb, sql, identifier: q, fail }) {
  const backupRoot = process.env.BACKUP_DIR || '/backups';
  const serverRoot = '/var/opt/mssql/backups';
  const filename = value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+\.bak$/.test(value) || value.length>180) throw fail('Некорректное имя файла резервной копии.');
    return value;
  };
  app.get('/api/backups', async(req,res)=>{
    const names=(await readdir(backupRoot)).filter(n=>n.endsWith('.bak'));
    const files=await Promise.all(names.map(async name=>{const s=await stat(path.join(backupRoot,name));return {name,size:s.size,modified:s.mtime};}));
    res.json(files.sort((a,b)=>b.modified-a.modified));
  });
  app.get('/api/backups/:file/download',async(req,res)=>{
    res.download(path.join(backupRoot,filename(req.params.file)));
  });
  app.delete('/api/backups/:file',async(req,res)=>{
    const file=filename(req.params.file);
    if(req.body.confirm!==file)throw fail('Подтвердите имя файла.');
    await unlink(path.join(backupRoot,file));res.json({ok:true});
  });
  app.post('/api/backups/upload',async(req,res)=>{
    const name=`upload_${Date.now()}_${randomUUID()}.bak`,target=path.join(backupRoot,name);
    let bytes=0;
    const limiter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>512*1024*1024?fail('Файл больше 512 МБ.'):null,chunk);}});
    try{await pipeline(req,limiter,createWriteStream(target,{flags:'wx',mode:0o660}));await chmod(target,0o660);res.status(201).json({name});}
    catch(error){await unlink(target).catch(()=>{});throw error;}
  });
  app.post('/api/backups',async(req,res)=>{
    const db=req.body.database;
    const name=`backup_${String(db).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,50)}_${Date.now()}_${randomUUID()}.bak`;
    await withDb('master',async p=>{
      const request=new sql.Request(p,{requestTimeout:600000}).input('file',sql.NVarChar(400),`${serverRoot}/${name}`);
      await request.batch(`BACKUP DATABASE ${q(db)} TO DISK=@file WITH COPY_ONLY,COMPRESSION,CHECKSUM,INIT;`);
    });res.status(201).json({name});
  });
  app.post('/api/backups/:file/verify',async(req,res)=>{
    await withDb('master',async p=>{const r=new sql.Request(p,{requestTimeout:600000}).input('file',sql.NVarChar(400),`${serverRoot}/${filename(req.params.file)}`);await r.batch('RESTORE VERIFYONLY FROM DISK=@file WITH CHECKSUM;');});res.json({ok:true});
  });
  app.post('/api/backups/:file/restore',async(req,res)=>{
    const name=req.body.database, full=q(name),file=filename(req.params.file);
    if(req.body.confirm!==name)throw fail('Подтвердите имя новой базы.');
    await withDb('master',async p=>{
      const existing=await p.request().input('name',sql.NVarChar(128),name).query('SELECT DB_ID(@name) id');
      if(existing.recordset[0].id!==null)throw fail('База уже существует. Восстановление выполняется только в новую базу.');
      const listing=await p.request().input('file',sql.NVarChar(400),`${serverRoot}/${file}`).query('RESTORE FILELISTONLY FROM DISK=@file');
      if(listing.recordset.some(f=>!['D','L'].includes(f.Type)))throw fail('Эта копия содержит FILESTREAM или другие специальные файлы. Используйте RESTORE через SQL.');
      const request=new sql.Request(p,{requestTimeout:600000}).input('file',sql.NVarChar(400),`${serverRoot}/${file}`);
      const id=randomUUID().replaceAll('-','');
      const moves=listing.recordset.map((f,i)=>{
        request.input('logical'+i,sql.NVarChar(128),f.LogicalName);
        request.input('physical'+i,sql.NVarChar(400),`/var/opt/mssql/data/restore_${id}_${i}.${f.Type==='L'?'ldf':'mdf'}`);
        return `MOVE @logical${i} TO @physical${i}`;
      });
      await request.batch(`RESTORE DATABASE ${full} FROM DISK=@file WITH ${moves.join(',')},RECOVERY,CHECKSUM;`);
    });res.status(201).json({ok:true});
  });
  app.get('/api/monitor',async(req,res)=>{
    const r=await withDb('master',p=>p.request().query(`
      SELECT s.session_id id,s.login_name login,s.host_name host,s.program_name program,s.status,
        DB_NAME(r.database_id) [database],r.command,r.blocking_session_id blockedBy,r.wait_type wait,
        r.cpu_time cpuMs,r.total_elapsed_time elapsedMs,r.reads,r.writes,r.logical_reads logicalReads,
        LEFT(t.text,8000) sqlText,s.open_transaction_count openTransactions
      FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id=s.session_id
      OUTER APPLY sys.dm_exec_sql_text(r.sql_handle)t WHERE s.is_user_process=1 AND s.session_id<>@@SPID ORDER BY r.total_elapsed_time DESC,s.session_id;
      SELECT physical_memory_in_use_kb/1024 memoryMB,virtual_address_space_committed_kb/1024 committedMB FROM sys.dm_os_process_memory;
      SELECT servicename,status_desc status,last_startup_time startedAt FROM sys.dm_server_services;`));
    res.json({sessions:r.recordsets[0],memory:r.recordsets[1][0],services:r.recordsets[2]});
  });
  app.post('/api/monitor/kill',async(req,res)=>{
    const id=Number(req.body.id);
    if(!Number.isInteger(id)||id<51||req.body.confirm!==String(id))throw fail('Подтвердите номер пользовательской сессии.');
    await withDb('master',async p=>{
      const r=await p.request().input('id',sql.Int,id).query('SELECT session_id FROM sys.dm_exec_sessions WHERE session_id=@id AND is_user_process=1 AND session_id<>@@SPID');
      if(!r.recordset.length)throw fail('Сессия не найдена.');await p.request().batch(`KILL ${id}`);
    });res.json({ok:true});
  });
  app.get('/api/security',async(req,res)=>{
    const r=await withDb(req.query.database||'master',p=>p.request().query(`
      SELECT name,type_desc type,is_disabled disabled FROM sys.server_principals WHERE type IN ('S','U','G') AND name NOT LIKE '##%' ORDER BY name;
      SELECT name,type_desc type,authentication_type_desc authentication FROM sys.database_principals WHERE type IN ('S','U','G','R') AND name NOT LIKE '##%' ORDER BY type,name;
      SELECT r.name role,m.name member FROM sys.database_role_members rm JOIN sys.database_principals r ON r.principal_id=rm.role_principal_id JOIN sys.database_principals m ON m.principal_id=rm.member_principal_id;
      SELECT u.name principal,p.state_desc state,p.permission_name permission,p.class_desc scope,OBJECT_SCHEMA_NAME(p.major_id) [schema],OBJECT_NAME(p.major_id) objectName
      FROM sys.database_permissions p JOIN sys.database_principals u ON u.principal_id=p.grantee_principal_id;`));
    res.json({logins:r.recordsets[0],principals:r.recordsets[1],memberships:r.recordsets[2],permissions:r.recordsets[3]});
  });
  app.post('/api/security',async(req,res)=>{
    const b=req.body;
    if(['dropLogin','dropUser','dropRole','disableLogin'].includes(b.action)&&b.confirm!==b.name)throw fail('Подтвердите имя.');
    const protectedNames=['sa','dbo','guest','sys','INFORMATION_SCHEMA','public'];
    if(['dropLogin','dropUser','dropRole','disableLogin'].includes(b.action)&&protectedNames.some(n=>n.toLowerCase()===String(b.name).toLowerCase()))throw fail('Системная учётная запись защищена.');
    const literal=value=>`N'${String(value).replaceAll("'","''")}'`;
    let command,database=b.database||'master';
    switch(b.action){
      case 'createLogin':
        if(typeof b.password!=='string'||b.password.length<8||b.password.length>128)throw fail('Пароль: 8–128 символов.');
        command=`CREATE LOGIN ${q(b.name)} WITH PASSWORD=${literal(b.password)},CHECK_POLICY=ON`;database='master';break;
      case 'dropLogin':command=`DROP LOGIN ${q(b.name)}`;database='master';break;
      case 'disableLogin':case 'enableLogin':command=`ALTER LOGIN ${q(b.name)} ${b.action==='disableLogin'?'DISABLE':'ENABLE'}`;database='master';break;
      case 'createUser':command=`CREATE USER ${q(b.name)} FOR LOGIN ${q(b.login)}`;break;
      case 'dropUser':command=`DROP USER ${q(b.name)}`;break;
      case 'createRole':command=`CREATE ROLE ${q(b.name)}`;break;
      case 'dropRole':command=`DROP ROLE ${q(b.name)}`;break;
      case 'addMember':case 'dropMember':command=`ALTER ROLE ${q(b.role)} ${b.action==='addMember'?'ADD':'DROP'} MEMBER ${q(b.name)}`;break;
      case 'permission':{
        if(!['GRANT','DENY','REVOKE'].includes(b.mode)||!['SELECT','INSERT','UPDATE','DELETE','EXECUTE','VIEW DEFINITION','CREATE TABLE','CREATE VIEW','CREATE PROCEDURE','CREATE FUNCTION','CONTROL'].includes(b.permission))throw fail('Некорректное разрешение.');
        command=`${b.mode} ${b.permission}${b.object?` ON OBJECT::${q(b.schema||'dbo')}.${q(b.object)}`:''} ${b.mode==='REVOKE'?'FROM':'TO'} ${q(b.name)}`;break;
      }
      default:throw fail('Неизвестное действие безопасности.');
    }
    await withDb(database,p=>p.request().batch(command));res.json({ok:true});
  });
  app.get('/api/jobs',async(req,res)=>{
    const r=await withDb('msdb',p=>p.request().query(`
      SELECT j.job_id id,j.name,j.enabled,j.description,
        (SELECT TOP(1) h.run_status FROM dbo.sysjobhistory h WHERE h.job_id=j.job_id AND h.step_id=0 ORDER BY h.instance_id DESC) lastStatus,
        CONVERT(bit,CASE WHEN EXISTS(SELECT 1 FROM dbo.sysjobactivity a WHERE a.job_id=j.job_id AND a.session_id=(SELECT MAX(session_id) FROM dbo.syssessions) AND a.start_execution_date IS NOT NULL AND a.stop_execution_date IS NULL) THEN 1 ELSE 0 END) running
      FROM dbo.sysjobs j ORDER BY j.name;
      SELECT h.instance_id,h.job_id jobId,j.name,h.step_name step,h.run_status status,h.run_date date,h.run_time time,h.run_duration duration,h.message
      FROM dbo.sysjobhistory h JOIN dbo.sysjobs j ON j.job_id=h.job_id ORDER BY h.instance_id DESC OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY;`));
    res.json({jobs:r.recordsets[0],history:r.recordsets[1]});
  });
  app.post('/api/jobs',async(req,res)=>{
    const b=req.body;
    q(b.name);q(b.database);
    if(typeof b.sql!=='string'||!b.sql.trim())throw fail('Введите T-SQL задания.');
    const minutes=Number(b.minutes||0);if(!Number.isInteger(minutes)||minutes<0||minutes>1440)throw fail('Интервал: 0 (вручную) или 1–1440 минут.');
    await withDb('msdb',p=>p.request().input('name',sql.NVarChar(128),b.name).input('db',sql.NVarChar(128),b.database)
      .input('command',sql.NVarChar(sql.MAX),b.sql).input('minutes',sql.Int,minutes).batch(`
      SET XACT_ABORT ON; BEGIN TRANSACTION;
      DECLARE @id uniqueidentifier;
      EXEC dbo.sp_add_job @job_name=@name,@enabled=1,@job_id=@id OUTPUT;
      EXEC dbo.sp_add_jobstep @job_id=@id,@step_name=N'T-SQL',@subsystem=N'TSQL',@database_name=@db,@command=@command;
      EXEC dbo.sp_add_jobserver @job_id=@id;
      IF @minutes>0 BEGIN
        DECLARE @schedule nvarchar(128)=CONVERT(nvarchar(36),@id);
        EXEC dbo.sp_add_jobschedule @job_id=@id,@name=@schedule,@freq_type=4,@freq_interval=1,@freq_subday_type=4,@freq_subday_interval=@minutes,@active_start_time=0;
      END;
      COMMIT TRANSACTION;`));res.status(201).json({ok:true});
  });
  app.post('/api/jobs/:id',async(req,res)=>{
    const actions={start:'sp_start_job',stop:'sp_stop_job',delete:'sp_delete_job',enable:'sp_update_job',disable:'sp_update_job'};
    const action=req.body.action,proc=actions[action];if(!proc)throw fail('Неизвестное действие.');
    await withDb('msdb',async p=>{
      if(action==='delete'){
        const found=await p.request().input('id',sql.UniqueIdentifier,req.params.id).query('SELECT name FROM dbo.sysjobs WHERE job_id=@id');
        if(!found.recordset.length||req.body.confirm!==found.recordset[0].name)throw fail('Подтвердите имя задания.');
      }
      await p.request().input('id',sql.UniqueIdentifier,req.params.id).batch(`EXEC dbo.${proc} @job_id=@id${['enable','disable'].includes(action)?`,@enabled=${action==='enable'?1:0}`:''}`);
    });res.json({ok:true});
  });
}
