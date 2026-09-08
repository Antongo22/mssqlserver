import test from 'node:test';import assert from 'node:assert/strict';
import {blockingTree} from '../lib/blocking-tree.js';import {hasDDL,historySQL,createDDLHistory} from '../lib/ddl-history.js';import {createProtection} from '../lib/protection.js';
test('blocking tree includes sleeping roots, missing owners, chains and cycles once',()=>{
  const rows=blockingTree([{id:1,status:'sleeping'},{id:2,blockedBy:1},{id:3,blockedBy:2},{id:4,blockedBy:-2},{id:5,blockedBy:6},{id:6,blockedBy:5}]);
  assert.deepEqual(rows.slice(0,3).map(s=>[s.id,s.depth]),[[1,0],[2,1],[3,2]]);assert.equal(rows.find(s=>s.id===-2).missing,true);assert.equal(new Set(rows.map(s=>s.id)).size,7);assert.ok(rows.some(s=>s.cycle));
});
test('DDL classification ignores comments and literals, redacts PASSWORD and bounds persistent history',async()=>{
  assert.equal(hasDDL("SELECT 'CREATE TABLE x'; /* ALTER /* nested */ TABLE t */ SELECT [DROP TABLE];"),false);
  assert.equal(hasDDL('CREATE OR ALTER PROCEDURE p AS SELECT 1'),true);assert.equal(hasDDL("EXEC(N'CREATE TABLE t(Id int)')"),true);
  assert.ok(!historySQL("CREATE LOGIN x WITH PASSWORD=N'private''password'; CREATE TABLE t(Id int)").includes('private'));
  const state={ddlHistory:Array.from({length:500},(_,id)=>({id}))},store={update:async fn=>fn(state)},connections={get:()=>({id:'local',name:'Local',server:'mssql',port:1433,user:'sa'})};
  const history=createDDLHistory({store,connections});await history.run('db','CREATE TABLE t(Id int)',async()=>({completedBatches:1}));assert.equal(state.ddlHistory.length,500);assert.equal(state.ddlHistory[0].status,'success');
  await assert.rejects(history.run('db','DROP TABLE missing',async()=>{throw new Error('missing');}));assert.equal(state.ddlHistory[0].status,'error');
});
test('read-only protection denies all mutation methods, previews cannot bypass other routes',()=>{
  const guard=createProtection({connections:{get:()=>({id:'test',readOnly:true})}});
  for(const [method,path,body] of [['POST','/query',{sql:'SELECT 1'}],['POST','/databases',{}],['PATCH','/databases/db/data/batch',{}],['POST','/jobs',{}],['POST','/backups/upload',{}],['POST','/databases/db/tables',{preview:true}],['DELETE','/databases/db',{}]]){
    let status;guard({method,path,body},{status(n){status=n;return this;},json(){}},()=>assert.fail('mutation allowed'));assert.equal(status,403,path);
  }
  for(const [method,path,body] of [['GET','/databases/db/data',{}],['POST','/databases/db/structure',{preview:true}],['POST','/query/request-id/cancel',{}],['PATCH','/connections/test',{}]]){
    let allowed=false;guard({method,path,body},{status(){assert.fail('read denied');}},()=>allowed=true);assert.ok(allowed,path);
  }
});
const base=process.env.ADMIN_URL||'http://localhost:3001';
async function call(path,method='GET',body,connection='local',token){const r=await fetch(base+path,{method,headers:{'X-Admin-Request':'1','Content-Type':'application/json','X-Studio-Connection':connection,...(token?{'X-Studio-Confirmation':token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
async function ok(...args){const r=await call(...args);assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}
test('production confirmations bind SQL and cannot be replayed; DDL outcomes persist and read-only is enforced', {timeout:60000},async()=>{
  const db='Studio_guard_'+Date.now(),login=db+'_login',password='Test_'+crypto.randomUUID()+'A1!';let profile;
  await ok('/api/databases','POST',{name:db});
  try{
    await ok('/api/security','POST',{action:'createLogin',name:login,password});
    await ok('/api/query','POST',{database:db,sql:`CREATE USER [${login}] FOR LOGIN [${login}]; ALTER ROLE db_owner ADD MEMBER [${login}];`});
    profile=await ok('/api/connections','POST',{name:login,server:'mssql',port:1433,user:login,password,environment:'test',trustServerCertificate:true});
    await ok('/api/query','POST',{database:db,sql:'CREATE TABLE dbo.Items(Id int PRIMARY KEY,Label nvarchar(20));'},profile.id);
    const failed=await call('/api/query','POST',{database:db,sql:'CREATE TABLE dbo.RollbackTest(Id int);\nGO\nCREATE TABLE dbo.RollbackTest(Id int);',transaction:true},profile.id);assert.equal(failed.status,400);assert.equal(failed.data.partial.rolledBack,true);
    await ok('/api/databases/'+db+'/structure','POST',{name:'Items',action:'dropColumn',column:'Label',confirm:'Items'},profile.id);
    let history=(await ok('/api/ddl-history','GET',null,profile.id)).entries;
    assert.ok(history.some(h=>h.sql.includes('CREATE TABLE dbo.Items')&&h.status==='success'));assert.ok(history.some(h=>h.rolledBack&&h.status==='error'));assert.ok(history.some(h=>h.sql.includes('DROP COLUMN')&&h.status==='success'));
    assert.ok(!JSON.stringify(history).includes(password));
    await ok('/api/connections/'+profile.id,'PATCH',{environment:'production',password:''});
    const body={database:db,sql:'SELECT 42 AS value'},challenge=await call('/api/query','POST',body,profile.id);assert.equal(challenge.status,428);
    const token=challenge.data.confirmation.token;
    assert.equal((await call('/api/query','POST',{...body,sql:'SELECT 43'},profile.id,token)).status,428);
    const result=await ok('/api/query','POST',body,profile.id,token);assert.equal(result.recordsets[0].rows[0][0],42);
    assert.equal((await call('/api/query','POST',body,profile.id,token)).status,428);
    await ok('/api/connections/'+profile.id,'PATCH',{readOnly:true});
    assert.equal((await call('/api/query','POST',body,profile.id)).status,403);
    assert.equal((await call('/api/databases/'+db+'/data','POST',{name:'Items',values:{Id:'1'}},profile.id)).status,403);
    assert.equal((await ok('/api/databases/'+db+'/data?name=Items','GET',null,profile.id)).rows.length,0);
    assert.ok((await ok('/api/ddl-history','GET',null,profile.id)).entries.length>0);
    assert.ok(!(await ok('/api/databases/'+db+'/tables')).some(t=>t.name==='RollbackTest'));
  }finally{
    if(profile)await ok('/api/connections/'+profile.id,'DELETE',{confirm:profile.name});
    await ok('/api/databases/'+db,'DELETE',{confirm:db});
    await ok('/api/security','POST',{action:'dropLogin',name:login,confirm:login});
  }
});
