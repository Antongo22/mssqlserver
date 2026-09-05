import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createStore } from '../lib/settings-store.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { sql, MSSQL } from '@codemirror/lang-sql';
import { joinCompletion } from '../lib/join-completion.js';
const base=process.env.ADMIN_URL||'http://localhost:3001';
async function call(url,method='GET',body,connection='local'){
  const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json','X-Admin-Request':'1','X-Studio-Connection':connection},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
}
async function ok(...args){const r=await call(...args);assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}

test('settings are atomic, private and survive reopening',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-settings-'));
  try{const store=await createStore(dir);await Promise.all(Array.from({length:20},(_,i)=>store.update(s=>{s.connections.push({id:i});})));assert.equal((await createStore(dir)).read().connections.length,20);assert.equal((await stat(path.join(dir,'settings.json'))).mode&0o777,0o600);}finally{await rm(dir,{recursive:true});}
});
test('CodeMirror completes live table columns through an alias',async()=>{
  const doc='SELECT p. FROM dbo.Products AS p',pos=9;
  const state=EditorState.create({doc,extensions:[sql({dialect:MSSQL,schema:{dbo:{Products:['Id','Price']}},defaultSchema:'dbo'})]});
  const sources=state.languageDataAt('autocomplete',pos),context=new CompletionContext(state,pos,true);
  const results=await Promise.all(sources.map(source=>typeof source==='function'?source(context):null));
  assert.ok(results.some(r=>r?.options.some(o=>o.label==='Price')));
});
test('JOIN suggestions map composite foreign keys using an existing alias',()=>{
  const doc='SELECT c.* FROM dbo.Child AS c LEFT JOIN ',state=EditorState.create({doc});
  const result=joinCompletion(new CompletionContext(state,doc.length,true),{tables:[{id:1,schema:'dbo',name:'Child',columns:[{id:1,name:'Code'},{id:2,name:'Version'}]},{id:2,schema:'other',name:'Parent',columns:[{id:4,name:'Code'},{id:5,name:'Version'}]}],foreignKeys:[{name:'FK_Pair',parentTableId:2,childTableId:1,columns:[{childColumnId:1,parentColumnId:4},{childColumnId:2,parentColumnId:5}]}]});
  assert.equal(result.options.length,1);assert.match(result.options[0].apply,/c\.\[Code\] = related\.\[Code\] AND c\.\[Version\] = related\.\[Version\]/);
});
test('schema migration, preview, import, parameters and scheduled restore checks', {timeout:180000},async()=>{
  const db='Studio_tools_'+Date.now(),target=db+'_target',root='/api/databases/'+db;
  let scheduleId,backup,profile,liveProfile,login;
  const query=(sql,other={})=>ok('/api/query','POST',{database:db,sql,...other});
  await ok('/api/databases','POST',{name:db});await ok('/api/databases','POST',{name:target});
  try{
    await query(`CREATE TABLE dbo.Parent(Id int PRIMARY KEY,Label nvarchar(8) NOT NULL,Amount decimal(20,4) NULL);CREATE TABLE dbo.Child(Id int PRIMARY KEY,ParentId int REFERENCES dbo.Parent(Id));\nGO\nCREATE VIEW dbo.ParentView AS SELECT Id,Label FROM dbo.Parent;`);
    const completion=await ok(root+'/completion');assert.deepEqual(completion.dbo.Parent,['Id','Label','Amount']);assert.deepEqual(completion.dbo.ParentView,['Id','Label']);
    const comparison=await ok('/api/schema-compare','POST',{sourceDatabase:db,targetDatabase:target});assert.ok(comparison.changes.length>=5);assert.match(comparison.sql,/FOREIGN KEY/);
    await ok('/api/query','POST',{database:target,sql:comparison.sql});
    const compared=await ok('/api/schema-compare','POST',{sourceDatabase:db,targetDatabase:target});assert.equal(compared.changes.length,0,JSON.stringify(compared.changes));
    const preview=await ok(root+'/structure','POST',{schema:'dbo',name:'Parent',action:'dropColumn',column:'Label',preview:true});assert.match(preview.sql,/DROP COLUMN/);assert.ok(preview.dependencies.some(d=>d.name==='ParentView'));assert.ok((await ok(root+'/completion')).dbo.Parent.includes('Label'));
    const invalid=await ok(root+'/data/import/preview','POST',{name:'Parent',records:[{Id:'not-int',Label:'Too long value'},{Id:'2',Label:null}]});assert.equal(invalid.valid,false);assert.ok(invalid.errors.length>=3);
    const records=[{Id:'1',Label:'Текст',Amount:'123456789012.1234'}];assert.equal((await ok(root+'/data/import/preview','POST',{name:'Parent',records})).valid,true);
    await ok(root+'/data/import','POST',{name:'Parent',records});
    const param=await query('SELECT @Text value,CONVERT(varchar(30),@Big) big;\nGO\nSELECT @Text;', {parameters:[{name:'Text',type:'NVARCHAR(MAX)',value:"x'; DROP TABLE dbo.Parent;--"},{name:'Big',type:'BIGINT',value:'9007199254740993'}]});assert.equal(param.recordsets[0].rows[0][0],"x'; DROP TABLE dbo.Parent;--");assert.equal(param.recordsets[0].rows[0][1],'9007199254740993');assert.equal(param.recordsets.length,2);
    assert.equal((await call('/api/query','POST',{database:db,sql:'SELECT @x',parameters:[{name:'x',type:'INT); DROP TABLE dbo.Parent;--',value:'1'}]})).status,400);
    const wb=new ExcelJS.Workbook(),sheet=wb.addWorksheet('Импорт');sheet.addRow(['Id','Name','Date']);sheet.addRow([1,'Привет',new Date('2026-01-02T00:00:00Z')]);const bytes=await wb.xlsx.writeBuffer();
    const parsed=await fetch(base+'/api/import-file',{method:'POST',headers:{'X-Admin-Request':'1','Content-Type':'application/octet-stream'},body:bytes});assert.equal(parsed.status,200);const excel=await parsed.json();assert.equal(excel.sheets[0].rows[1][1],'Привет');assert.match(excel.sheets[0].rows[1][2],/2026-01-02/);
    const badFile=await fetch(base+'/api/import-file',{method:'POST',headers:{'X-Admin-Request':'1','Content-Type':'application/octet-stream'},body:'not an xlsx'});assert.equal(badFile.status,400);
    const schedule=await ok('/api/backup-schedules','POST',{database:db,minutes:1440,retentionDays:7,restoreCheck:true});scheduleId=schedule.id;
    backup=(await ok('/api/backup-schedules/'+scheduleId,'POST',{action:'run'})).name;
    const history=(await ok('/api/backup-schedules')).history.find(h=>h.scheduleId===scheduleId);assert.equal(history.success,true);assert.equal(history.restoreCheck,true);
    assert.ok(!(await ok('/api/databases')).databases.some(d=>d.name.startsWith('Studio_RestoreCheck_')));
    await ok('/api/backup-schedules/'+scheduleId,'POST',{action:'disable'});assert.equal((await ok('/api/backup-schedules')).schedules.find(s=>s.id===scheduleId).enabled,false);
    profile=await ok('/api/connections','POST',{name:'Test profile '+Date.now(),server:'127.0.0.1',port:1,user:'test',password:'Private_dummy_password1!',environment:'test',trustServerCertificate:true});assert.ok(!('password' in profile));assert.ok(!(JSON.stringify(await ok('/api/connections')).includes('Private_dummy_password')));
    assert.equal((await call('/api/databases','GET',undefined,'nonexistent')).status,404);
    assert.ok((await call('/api/databases','GET',undefined,profile.id)).status>=400,'Unavailable profile must not fall back to local server');
    assert.ok((await ok('/api/databases')).databases.some(d=>d.name===db));
    login='Studio_profile_'+Date.now();const password='Test_'+crypto.randomUUID()+'A1!';
    await ok('/api/security','POST',{action:'createLogin',name:login,password});
    await ok('/api/security','POST',{database:db,action:'createUser',name:login,login});
    await ok('/api/security','POST',{database:db,action:'permission',name:login,mode:'GRANT',permission:'SELECT'});
    const config={name:login,server:'mssql',port:1433,user:login,password,environment:'test',trustServerCertificate:true};
    await ok('/api/connections/test','POST',config);liveProfile=await ok('/api/connections','POST',config);
    const identity=await ok('/api/query','POST',{database:db,sql:'SELECT SUSER_SNAME();SELECT COUNT(*) FROM dbo.Parent;'},liveProfile.id);
    assert.equal(identity.recordsets[0].rows[0][0],login);assert.equal(identity.recordsets[1].rows[0][0],1);
    assert.equal((await query('SELECT SUSER_SNAME()')).recordsets[0].rows[0][0],'sa');
  }finally{
    if(scheduleId)await ok('/api/backup-schedules/'+scheduleId,'POST',{action:'delete',confirm:db});
    if(backup)await ok('/api/backups/'+backup,'DELETE',{confirm:backup});
    if(profile)await ok('/api/connections/'+profile.id,'DELETE',{confirm:profile.name});
    if(liveProfile)await ok('/api/connections/'+liveProfile.id,'DELETE',{confirm:liveProfile.name});
    for(const name of [target,db])await ok('/api/databases/'+name,'DELETE',{confirm:name});
    if(login)await ok('/api/security','POST',{action:'dropLogin',name:login,confirm:login});
  }
});
