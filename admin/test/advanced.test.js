import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const base=process.env.ADMIN_URL||'http://localhost:3001';
const headers={'Content-Type':'application/json','X-Admin-Request':'1'};
async function call(path,method='GET',body){const r=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});const data=await r.json();return {status:r.status,data};}
async function ok(path,method='GET',body){const r=await call(path,method,body);assert.ok(r.status<300,`${path}: ${JSON.stringify(r.data)}`);return r.data;}
test('advanced workflows on isolated databases', {timeout:180000},async()=>{
  const suffix=Date.now(),db='Studio_advanced_'+suffix,restored=db+'_restored',uploadedDb=db+'_uploaded';
  const root='/api/databases/'+db,login='Studio_login_'+suffix,job='Studio_job_'+suffix;
  let backupName,uploadName,jobId;
  const query=(text,options={})=>ok('/api/query','POST',{database:db,sql:text,...options});
  await ok('/api/databases','POST',{name:db});
  try{
    await query(`CREATE TABLE dbo.Items(Id bigint IDENTITY(1,1) PRIMARY KEY, Amount decimal(30,4) NOT NULL, Name nvarchar(255) NULL, CreatedAt datetime2 NOT NULL DEFAULT SYSDATETIME());\nGO\nINSERT dbo.Items(Amount,Name) VALUES(1234567890123456789012345.6789,N'Анна');`);
    let data=await ok(root+'/data?schema=dbo&name=Items');assert.equal(data.rows[0].values[1],'1234567890123456789012345.6789');assert.equal(data.editable,true);
    const first=data.rows[0],payload={schema:'dbo',name:'Items',keys:{Id:first.values[0]},token:first.token,values:{Name:'Новое'}};
    await ok(root+'/data','PATCH',payload);
    assert.equal((await call(root+'/data','PATCH',payload)).status,400,'stale token must fail');
    await ok(root+'/data','POST',{name:'Items',values:{Amount:'2.5000',Name:'Борис'}});
    await ok(root+'/data/import','POST',{name:'Items',records:[{Amount:'3',Name:'CSV;line'},{Amount:'4',Name:null}]});
    assert.equal((await call(root+'/data/import','POST',{name:'Items',records:[{Amount:'5',Name:'rollback'},{Amount:'invalid'}]})).status,400);
    data=await ok(root+'/data?name=Items&sort=Amount&direction=DESC&filterColumn=Name&filter=Новое');assert.equal(data.rows.length,1);assert.equal(data.rows[0].values[2],'Новое');
    const count=await query('SELECT COUNT(*) AS n FROM dbo.Items');assert.equal(count.recordsets[0].rows[0][0],4);
    await ok(root+'/structure','POST',{name:'Items',action:'addColumn',column:'Note',type:'NVARCHAR(255)',nullable:true});
    await ok(root+'/structure','POST',{name:'Items',action:'createIndex',index:'IX_Name',columns:['Name']});
    const structure=await ok(root+'/structure?name=Items');assert.ok(structure.indexes.some(i=>i.name==='IX_Name'));assert.ok(structure.columns.some(c=>c.name==='Note'));
    await ok(root+'/schemas','POST',{name:'custom'});
    await query('CREATE OR ALTER VIEW custom.ItemNames AS SELECT Id,Name FROM dbo.Items;\nGO\nCREATE OR ALTER PROCEDURE dbo.ReadItems AS SELECT * FROM dbo.Items;');
    const objects=await ok(root+'/objects');assert.ok(objects.objects.some(o=>o.name==='ItemNames'));
    const view=objects.objects.find(o=>o.name==='ItemNames');assert.match((await ok(root+'/definition/'+view.id)).definition,/CREATE\s+(?:OR ALTER\s+)?VIEW/);
    const go=await query('CREATE TABLE #x(v int);\nGO\nINSERT #x VALUES(1);\nGO 2\nSELECT COUNT(*) n FROM #x;');assert.equal(go.recordsets.at(-1).rows[0][0],2);
    const rollback=await call('/api/query','POST',{database:db,transaction:true,sql:"INSERT dbo.Items(Amount) VALUES(99);\nGO\nSELECT * FROM MissingTable;"});assert.equal(rollback.status,400);assert.equal(rollback.data.partial.rolledBack,true);
    assert.equal((await query('SELECT COUNT(*) n FROM dbo.Items')).recordsets[0].rows[0][0],4);
    const plan=await query('SELECT * FROM dbo.Items WHERE Id=1',{mode:'estimated'});assert.match(plan.recordsets[0].rows[0][0],/ShowPlanXML/);
    const actual=await query('SELECT * FROM dbo.Items WHERE Id=1',{mode:'actual',statistics:true});assert.ok(actual.recordsets.some(s=>s.rows.some(r=>r.some(v=>typeof v==='string'&&v.includes('ShowPlanXML')))));
    const id=randomUUID();const pending=call('/api/query','POST',{database:db,id,sql:"WAITFOR DELAY '00:00:15'; SELECT 1;"});
    let cancelled=false;for(let i=0;i<30;i++){await delay(100);const r=await call('/api/query/'+id+'/cancel','POST');if(r.status===200){cancelled=true;break;}}assert.ok(cancelled);assert.equal((await pending).status,400);
    await ok('/api/security','POST',{action:'createLogin',name:login,password:'Test_'+randomUUID()+'aA1!'});
    await ok('/api/security','POST',{database:db,action:'createUser',name:'TestUser',login});
    await ok('/api/security','POST',{database:db,action:'createRole',name:'TestRole'});
    await ok('/api/security','POST',{database:db,action:'addMember',name:'TestUser',role:'TestRole'});
    await ok('/api/security','POST',{database:db,action:'permission',name:'TestRole',mode:'GRANT',permission:'SELECT'});
    assert.ok((await ok('/api/security?database='+db)).memberships.some(m=>m.role==='TestRole'&&m.member==='TestUser'));
    assert.ok((await ok('/api/monitor')).services.length>0);
    await ok('/api/jobs','POST',{name:job,database:db,sql:'SELECT 1;',minutes:0});
    jobId=(await ok('/api/jobs')).jobs.find(j=>j.name===job).id;await ok('/api/jobs/'+jobId,'POST',{action:'start'});
    backupName=(await ok('/api/backups','POST',{database:db})).name;
    await ok('/api/backups/'+backupName+'/verify','POST');
    await ok('/api/backups/'+backupName+'/restore','POST',{database:restored,confirm:restored});
    const copied=await ok('/api/query','POST',{database:restored,sql:'SELECT COUNT(*) n FROM dbo.Items'});assert.equal(copied.recordsets[0].rows[0][0],4);
    assert.equal((await call('/api/backups/'+backupName+'/restore','POST',{database:db,confirm:db})).status,400);
    const download=await fetch(base+'/api/backups/'+backupName+'/download',{headers:{'X-Admin-Request':'1'}});assert.equal(download.status,200);const file=await download.arrayBuffer();assert.ok(file.byteLength>0);
    const upload=await fetch(base+'/api/backups/upload',{method:'POST',headers:{'X-Admin-Request':'1','Content-Type':'application/octet-stream'},body:file});assert.equal(upload.status,201);uploadName=(await upload.json()).name;
    await ok('/api/backups/'+uploadName+'/verify','POST');
    await ok('/api/backups/'+uploadName+'/restore','POST',{database:uploadedDb,confirm:uploadedDb});
    assert.equal((await ok('/api/query','POST',{database:uploadedDb,sql:'SELECT COUNT(*) n FROM dbo.Items'})).recordsets[0].rows[0][0],4);
    const settings=await ok(root+'/properties');await ok(root+'/properties','PATCH',{recovery:settings.recovery,compatibility:settings.compatibility,confirm:db});
    data=await ok(root+'/data?name=Items');const row=data.rows[0];await ok(root+'/data','DELETE',{name:'Items',keys:{Id:row.values[0]},token:row.token});
  }finally{
    if(jobId)await ok('/api/jobs/'+jobId,'POST',{action:'delete',confirm:job});
    const databases=(await ok('/api/databases')).databases.map(d=>d.name);
    for(const name of [uploadedDb,restored,db])if(databases.includes(name))await ok('/api/databases/'+name,'DELETE',{confirm:name});
    const security=await ok('/api/security');if(security.logins.some(l=>l.name===login))await ok('/api/security','POST',{action:'dropLogin',name:login,confirm:login});
    for(const file of [backupName,uploadName].filter(Boolean))await ok('/api/backups/'+file,'DELETE',{confirm:file});
  }
});
