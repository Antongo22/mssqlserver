import test from 'node:test';import assert from 'node:assert/strict';
const base=process.env.ADMIN_URL||'http://localhost:3001';
async function call(path,method='GET',body){const r=await fetch(base+path,{method,headers:{'X-Admin-Request':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
async function ok(...args){const r=await call(...args);assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}
test('catalog inspects indexes, procedure parameters, dependencies and non-module objects without executing them',async()=>{
  const db='Studio_catalog_'+Date.now(),root='/api/databases/'+db;await ok('/api/databases','POST',{name:db});
  try{
    await ok('/api/query','POST',{database:db,sql:`CREATE TABLE dbo.Items(Id int PRIMARY KEY,Code int,Label nvarchar(80),Amount decimal(20,4));
CREATE TABLE dbo.Other(Id int);
CREATE NONCLUSTERED INDEX IX_Shared ON dbo.Items(Code DESC) INCLUDE(Label,Amount) WHERE Code IS NOT NULL;
CREATE INDEX IX_Shared ON dbo.Other(Id);
CREATE NONCLUSTERED COLUMNSTORE INDEX IX_Columnstore ON dbo.Items(Code,Amount);
CREATE TYPE dbo.ItemIds AS TABLE(Id int);
CREATE SEQUENCE dbo.Serial AS bigint START WITH 9007199254740993 INCREMENT BY 2;
CREATE SYNONYM dbo.Alias FOR dbo.Items;
GO
CREATE VIEW dbo.ItemView AS SELECT Id,Label FROM dbo.Items;
GO
CREATE PROCEDURE dbo.ReadItems @Text nvarchar(80)=N'default',@Amount decimal(20,4) OUTPUT,@Ids dbo.ItemIds READONLY AS SELECT Id,Label FROM dbo.ItemView;
GO
CREATE FUNCTION dbo.DoubleValue(@Value decimal(20,4)) RETURNS decimal(20,4) AS BEGIN RETURN @Value*2; END;
GO
CREATE TRIGGER dbo.ItemsChanged ON dbo.Items AFTER INSERT,UPDATE AS BEGIN SET NOCOUNT ON; END;
GO
DISABLE TRIGGER dbo.ItemsChanged ON dbo.Items;
GO
CREATE PROCEDURE dbo.Hidden WITH ENCRYPTION AS SELECT 1;`});
    const objects=(await ok(root+'/objects')).objects,detail=name=>ok(root+'/objects/'+objects.find(o=>o.name===name).id+'/details');
    const indexes=(await ok(root+'/indexes')).indexes;assert.equal(indexes.filter(i=>i.name==='IX_Shared').length,2);
    const index=indexes.find(i=>i.name==='IX_Shared'&&i.table==='Items');assert.match(index.filter,/Code/);assert.equal(index.hasFilter,true);assert.equal(index.columns.find(c=>c.name==='Code').descending,true);assert.equal(index.columns.find(c=>c.name==='Label').included,true);
    assert.equal(indexes.find(i=>i.name==='IX_Columnstore').columns.length,2);
    assert.ok((await ok(root+'/indexes?objectId='+index.objectId)).indexes.every(i=>i.table==='Items'));
    const proc=await detail('ReadItems');assert.equal(proc.parameters[0].sqlType,'nvarchar(80)');assert.equal(proc.parameters[1].sqlType,'decimal(20,4)');assert.equal(proc.parameters[1].output,true);assert.equal(proc.parameters[2].sqlType,'[dbo].[ItemIds]');assert.equal(proc.parameters[2].readOnly,true);assert.match(proc.definition,/default/);assert.ok(proc.dependencies.some(d=>d.name==='ItemView'));
    const view=await detail('ItemView');assert.equal(view.columns[1].sqlType,'nvarchar(80)');assert.ok(view.dependents.some(d=>d.name==='ReadItems'));
    const fn=await detail('DoubleValue');assert.equal(fn.parameters.find(p=>p.id===0).sqlType,'decimal(20,4)');
    const trigger=await detail('ItemsChanged');assert.equal(trigger.trigger.disabled,true);assert.equal(trigger.parentName,'Items');assert.deepEqual(trigger.events.map(e=>e.event),['INSERT','UPDATE']);
    assert.equal((await detail('Serial')).sequence.startValue,'9007199254740993');assert.equal((await detail('Alias')).synonym.target,'[dbo].[Items]');
    const hidden=await detail('Hidden');assert.equal(hidden.encrypted,true);assert.equal(hidden.definition,null);
    assert.equal((await call(root+'/indexes?objectId=1%3BDROP')).status,400);assert.equal((await call(root+'/objects/2147483647/details')).status,404);
    assert.equal((await ok(root+'/data?name=Items')).rows.length,0);
  }finally{await ok(root,'DELETE',{confirm:db});}
});
