import test from 'node:test';import assert from 'node:assert/strict';
const base=process.env.ADMIN_URL||'http://localhost:3001',headers={'X-Admin-Request':'1','Content-Type':'application/json'};
async function call(path,method='GET',body,connection='local'){const r=await fetch(base+path,{method,headers:{...headers,'X-Studio-Connection':connection},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
async function ok(...args){const r=await call(...args);assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}
test('full export shares compound native filters and multiple sorting with table browsing',async()=>{
 const db='Studio_export_'+Date.now(),root='/api/databases/'+db;await ok('/api/databases','POST',{name:db});
 try{
  await ok('/api/query','POST',{database:db,sql:"CREATE TABLE dbo.Items(Id bigint PRIMARY KEY,Name nvarchar(50),Amount decimal(30,4),Note nvarchar(max));WITH n AS(SELECT 1 i UNION ALL SELECT i+1 FROM n WHERE i<130) INSERT dbo.Items SELECT 9007199254740993+i,N'item',i,CASE WHEN i%2=0 THEN NULL ELSE N'line'+CHAR(10)+N'next' END FROM n OPTION(MAXRECURSION 200);"});
  const filters={logic:'AND',rules:[{column:'Amount',op:'BETWEEN',values:['20','110']},{logic:'OR',rules:[{column:'Note',op:'IS NULL'},{column:'Id',op:'IN',values:['9007199254741014']}]}]},sorts=[{column:'Name',direction:'ASC'},{column:'Amount',direction:'DESC'}];
  const query=new URLSearchParams({name:'Items',filters:JSON.stringify(filters),sorts:JSON.stringify(sorts),pageSize:25});
  const page=await ok(root+'/data?'+query);assert.equal(page.rows.length,25);assert.equal(page.rows[0].values[2],'110.0000');assert.equal(page.hasMore,true);
  const r=await fetch(base+root+'/data/export?'+query,{headers});assert.equal(r.status,200);const frames=(await r.text()).trim().split('\n').map(JSON.parse);assert.equal(frames.at(-1).done,true);assert.equal(frames.at(-1).rows,47);assert.ok(frames.some(f=>f.csv?.includes('9007199254741014')));assert.ok(frames.some(f=>f.csv?.includes('\\N')));assert.ok(frames.some(f=>f.csv?.includes('line\nnext')));
  const all=await fetch(base+root+'/data/export?name=Items',{headers});assert.equal(JSON.parse((await all.text()).trim().split('\n').at(-1)).rows,130);
  const bad=new URLSearchParams({name:'Items',filters:JSON.stringify({column:'Id',op:'= 1; DROP TABLE dbo.Items;--',value:'1'})});assert.equal((await call(root+'/data?'+bad)).status,400);
  assert.equal((await call(root+'/data?name=Items&sorts='+encodeURIComponent(JSON.stringify([{column:'missing',direction:'ASC'}])))).status,400);
 }finally{await ok(root,'DELETE',{confirm:db});}
});
test('procedure forms preserve decimals, defaults, output and return code; diagnostics inspect a single index',async()=>{
 const db='Studio_proc_'+Date.now(),root='/api/databases/'+db;await ok('/api/databases','POST',{name:db});
 try{
  await ok('/api/query','POST',{database:db,sql:"CREATE TABLE dbo.Items(Id int PRIMARY KEY,Value int);INSERT dbo.Items VALUES(1,1);\nGO\nCREATE PROC dbo.RunMe @Text nvarchar(100)=N'default',@Big bigint,@Amount decimal(30,4) OUTPUT AS BEGIN SET @Amount=@Amount+1; SELECT @Text text,CONVERT(varchar(30),@Big) big; RETURN 7; END;"});
  const object=(await ok(root+'/objects')).objects.find(o=>o.name==='RunMe');
  const r=await ok(root+'/procedures/'+object.id+'/execute','POST',{parameters:{'@Text':{mode:'default'},'@Big':{mode:'value',value:'9007199254740993'},'@Amount':{mode:'value',value:'1234567890123456789012345.1234'}}});
  assert.equal(r.returnValue,7);assert.equal(r.output['@Amount'],'1234567890123456789012346.1234');assert.deepEqual(r.recordsets[0].rows[0],['default','9007199254740993']);assert.equal(r.recordsets.length,1);
  const literal="x';DROP TABLE dbo.Items;--";const text=await ok(root+'/procedures/'+object.id+'/execute','POST',{parameters:{'@Text':{mode:'value',value:literal},'@Big':{mode:'value',value:'1'},'@Amount':{mode:'null'}}});assert.equal(text.recordsets[0].rows[0][0],literal);assert.equal(text.output['@Amount'],null);
  assert.equal((await call(root+'/procedures/'+object.id+'/execute','POST',{parameters:{bad:{mode:'value',value:'1'}}})).status,400);
  const index=(await ok(root+'/indexes')).indexes[0],diag=await ok(root+'/index-diagnostics?objectId='+index.objectId+'&indexId='+index.indexId);assert.equal(diag.index.name,index.name);assert.equal(diag.size.rows,'1');assert.ok(Array.isArray(diag.fragmentation));assert.equal((await call(root+'/index-diagnostics?objectId=0&indexId=1')).status,400);
 }finally{await ok(root,'DELETE',{confirm:db});}
});
test('data comparison previews insert/update/delete, rolls back stale targets, supports composite PK and identity',async()=>{
 const a='Studio_diff_a_'+Date.now(),b=a+'_target';await ok('/api/databases','POST',{name:a});await ok('/api/databases','POST',{name:b});
 const query=(database,sql)=>ok('/api/query','POST',{database,sql});
 const source={connection:'local',database:a,schema:'dbo',name:'Items'},target={...source,database:b};
 try{
  for(const db of [a,b])await query(db,'CREATE TABLE dbo.Items(Id bigint IDENTITY(9007199254740993,1),Version int,Amount decimal(30,4),Text nvarchar(100),PRIMARY KEY(Id,Version));');
  await query(a,"SET IDENTITY_INSERT dbo.Items ON;INSERT dbo.Items(Id,Version,Amount,Text) VALUES(9007199254740993,1,1,N'changed'),(9007199254740994,1,12345678901234567890.1234,N'insert');");
  await query(b,"SET IDENTITY_INSERT dbo.Items ON;INSERT dbo.Items(Id,Version,Amount,Text) VALUES(9007199254740993,1,1,N'old'),(9007199254740995,1,3,N'delete');");
  let plan=await ok('/api/data-compare','POST',{source,target});assert.deepEqual(plan.counts,{insert:1,update:1,delete:1,same:0});assert.match(plan.sql,/IDENTITY_INSERT/);
  await query(b,"UPDATE dbo.Items SET Text=N'concurrent' WHERE Id=9007199254740993");
  assert.equal((await call('/api/data-compare/'+plan.id+'/apply','POST',{confirm:b+'.dbo.Items'})).status,400);
  assert.equal((await query(b,'SELECT COUNT(*) FROM dbo.Items')).recordsets[0].rows[0][0],2);assert.equal((await query(b,'SELECT Text FROM dbo.Items WHERE Id=9007199254740993')).recordsets[0].rows[0][0],'concurrent');
  plan=await ok('/api/data-compare','POST',{source,target});assert.equal((await call('/api/data-compare/'+plan.id+'/apply','POST',{confirm:'wrong'})).status,400);
  await ok('/api/data-compare/'+plan.id+'/apply','POST',{confirm:b+'.dbo.Items'});
  const equal=await ok('/api/data-compare','POST',{source,target});assert.deepEqual(equal.counts,{insert:0,update:0,delete:0,same:2});
  assert.equal((await call('/api/data-compare/'+plan.id+'/apply','POST',{confirm:b+'.dbo.Items'})).status,409);
 }finally{for(const db of [a,b])await ok('/api/databases/'+db,'DELETE',{confirm:db});}
});
test('new write operations respect read-only and production; comparison targets cannot switch profiles after preview',async()=>{
 const db='Studio_workflow_guard_'+Date.now(),login=db+'_login',password='Test_'+crypto.randomUUID()+'A1!';let profile;
 await ok('/api/databases','POST',{name:db});
 try{
  await ok('/api/security','POST',{action:'createLogin',name:login,password});
  await ok('/api/query','POST',{database:db,sql:`CREATE USER [${login}] FOR LOGIN [${login}];ALTER ROLE db_owner ADD MEMBER [${login}];CREATE TABLE dbo.Source(Id int PRIMARY KEY);CREATE TABLE dbo.Target(Id int PRIMARY KEY);INSERT dbo.Source VALUES(1);\nGO\nCREATE PROC dbo.RunMe AS SELECT 1;`});
  profile=await ok('/api/connections','POST',{name:login,server:'mssql',port:1433,user:login,password,environment:'test',trustServerCertificate:true});
  const source={connection:'local',database:db,schema:'dbo',name:'Source'},target={...source,connection:profile.id,name:'Target'};
  let plan=await ok('/api/data-compare','POST',{source,target});assert.equal(plan.counts.insert,1);
  await ok('/api/connections/'+profile.id,'PATCH',{name:login+'_changed'});
  assert.equal((await call('/api/data-compare/'+plan.id+'/apply','POST',{confirm:db+'.dbo.Target'},profile.id)).status,409);
  await ok('/api/connections/'+profile.id,'PATCH',{environment:'production'});
  plan=await ok('/api/data-compare','POST',{source,target});assert.equal((await call('/api/data-compare/'+plan.id+'/apply','POST',{confirm:db+'.dbo.Target'},profile.id)).status,428);
  const proc=(await ok('/api/databases/'+db+'/objects')).objects.find(o=>o.name==='RunMe');assert.equal((await call('/api/databases/'+db+'/procedures/'+proc.id+'/execute','POST',{},profile.id)).status,428);
  await ok('/api/connections/'+profile.id,'PATCH',{readOnly:true});
  assert.equal((await call('/api/databases/'+db+'/procedures/'+proc.id+'/execute','POST',{},profile.id)).status,403);
  assert.equal((await call('/api/data-compare/'+plan.id+'/apply','POST',{confirm:db+'.dbo.Target'},profile.id)).status,403);
  assert.equal((await call('/api/data-compare','POST',{source,target},profile.id)).status,200);
  const exported=await fetch(base+'/api/databases/'+db+'/data/export?name=Source',{headers:{...headers,'X-Studio-Connection':profile.id}});assert.equal(exported.status,200);assert.equal(JSON.parse((await exported.text()).trim().split('\n').at(-1)).rows,1);
 }finally{
  if(profile){const updated=(await ok('/api/connections')).find(p=>p.id===profile.id);await ok('/api/connections/'+profile.id,'DELETE',{confirm:updated.name});}
  await ok('/api/databases/'+db,'DELETE',{confirm:db});await ok('/api/security','POST',{action:'dropLogin',name:login,confirm:login});
 }
});
test('export cancellation releases the SQL request and procedure outputs survive result-set limits',async()=>{
 const db='Studio_stream_'+Date.now(),root='/api/databases/'+db;await ok('/api/databases','POST',{name:db});
 try{
  await ok('/api/query','POST',{database:db,sql:"CREATE TABLE dbo.BigExport(Id int PRIMARY KEY,Payload AS REPLICATE(CONVERT(nvarchar(max),N'x'),100000));INSERT dbo.BigExport(Id) SELECT TOP(1000) ROW_NUMBER() OVER(ORDER BY (SELECT NULL)) FROM sys.all_objects;\nGO\nCREATE PROC dbo.ManyResults @Out bigint OUTPUT AS BEGIN "+Array(22).fill('SELECT 1;').join('')+" SET @Out=9007199254740993;RETURN 9;END;"});
  const controller=new AbortController(),response=await fetch(base+root+'/data/export?name=BigExport',{headers,signal:controller.signal}),reader=response.body.getReader();await reader.read();controller.abort();await reader.cancel().catch(()=>{});
  let active=true;for(let i=0;i<30&&active;i++){await new Promise(r=>setTimeout(r,50));active=(await ok('/api/monitor')).sessions.some(s=>s.database===db&&s.command==='SELECT');}assert.equal(active,false);
  const proc=(await ok(root+'/objects')).objects.find(o=>o.name==='ManyResults'),r=await ok(root+'/procedures/'+proc.id+'/execute','POST',{parameters:{'@Out':{mode:'null'}}});assert.equal(r.returnValue,9);assert.equal(r.output['@Out'],'9007199254740993');assert.equal(r.truncated,true);assert.equal(r.recordsets.length,20);
 }finally{await ok(root,'DELETE',{confirm:db});}
});
