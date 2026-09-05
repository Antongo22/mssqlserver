import test from 'node:test';
import assert from 'node:assert/strict';
import { columnType } from '../lib/create-table.js';

const base = process.env.ADMIN_URL || 'http://localhost:3001';
const headers = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };
async function call(path, method='GET', body) {
  const response = await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});
  return { status:response.status, data:await response.json() };
}
async function ok(path,method,body) {
  const response=await call(path,method,body);
  assert.ok(response.status<300,JSON.stringify(response.data));return response.data;
}

test('FK type selection only permits concrete SQL types',()=>{
  for(const type of ['INT','NVARCHAR(48)','DECIMAL(30,4)','DATETIME2(3)','VARBINARY(128)'])assert.equal(columnType(type),type);
  for(const type of ['INT); DROP TABLE x;--','NVARCHAR(9000)','NUMERIC(8,9)','DATETIME2(8)','VARCHAR(0)'])assert.throws(()=>columnType(type));
});

test('create tables with live simple and composite PK references atomically', {timeout:60000},async()=>{
  const db='Studio_fk_'+Date.now(), root='/api/databases/'+db;
  const query=sql=>ok('/api/query','POST',{database:db,sql});
  await ok('/api/databases','POST',{name:db});
  try {
    await query(`CREATE SCHEMA [sales space];\nGO\nCREATE TABLE [sales space].[Parent]]](Id int PRIMARY KEY);\nCREATE TABLE dbo.Composite(Code nvarchar(48) NOT NULL, Version int NOT NULL, CONSTRAINT PK_Composite PRIMARY KEY(Version,Code));\nCREATE TABLE dbo.WithoutPK(Id int);\nINSERT [sales space].[Parent]]] VALUES(7);\nINSERT dbo.Composite VALUES(N'Ключ',2);`);
    const keys=await ok(root+'/primary-keys');
    const parent=keys.find(k=>k.table==='Parent]'), composite=keys.find(k=>k.table==='Composite');
    assert.equal(parent.schema,'sales space');assert.equal(parent.columns[0].type,'INT');
    assert.deepEqual(composite.columns.map(c=>c.name),['Version','Code']);
    assert.equal(composite.columns[1].type,'NVARCHAR(48)');
    assert.ok(!keys.some(k=>k.table==='WithoutPK'));
    await ok(root+'/tables','POST',{name:'Child',columns:[{name:'Id',type:'INT',primaryKey:true},{name:'ParentId',type:'INT',nullable:true}],foreignKeys:[{name:'FK_Child_Parent',keyId:parent.id,columns:['ParentId'],onDelete:'CASCADE'}]});
    await query('INSERT dbo.Child VALUES(1,7)');
    assert.equal((await call('/api/query','POST',{database:db,sql:'INSERT dbo.Child VALUES(2,999)'})).status,400,'FK must enforce existing parent values');
    await query('DELETE FROM [sales space].[Parent]]] WHERE Id=7');
    assert.equal((await query('SELECT COUNT(*) FROM dbo.Child')).recordsets[0].rows[0][0],0,'ON DELETE CASCADE must work');
    await ok(root+'/tables','POST',{name:'CompositeChild',columns:[{name:'Id',type:'INT',primaryKey:true},{name:'LocalCode',type:'NVARCHAR(48)'},{name:'LocalVersion',type:'INT'}],foreignKeys:[{keyId:composite.id,columns:['LocalVersion','LocalCode']}]});
    await query("INSERT dbo.CompositeChild VALUES(1,N'Ключ',2)");
    const fks=(await ok(root+'/structure?name=CompositeChild')).foreignKeys;
    assert.deepEqual(fks.map(f=>[f.column,f.refColumn]),[['LocalVersion','Version'],['LocalCode','Code']]);
    const attempt=async(name,columns,foreignKeys)=>{
      assert.equal((await call(root+'/tables','POST',{name,columns,foreignKeys})).status,400);
      assert.ok(!(await ok(root+'/tables')).some(t=>t.name===name),'failed FK creation must not leave a table');
    };
    await attempt('WrongType',[{name:'Bad',type:'NVARCHAR(255)'}],[{keyId:parent.id,columns:['Bad']}]);
    await attempt('WrongCount',[{name:'Bad',type:'INT'}],[{keyId:composite.id,columns:['Bad']}]);
    await attempt('MissingColumn',[{name:'Id',type:'INT'}],[{keyId:parent.id,columns:['NotThere']}]);
    await attempt('WrongNull',[{name:'Id',type:'INT'}],[{keyId:parent.id,columns:['Id'],onDelete:'SET NULL'}]);
    await attempt('BadAction',[{name:'Id',type:'INT'}],[{keyId:parent.id,columns:['Id'],onDelete:'CASCADE; DROP TABLE dbo.Child'}]);
    const identityColumns=[{name:'Id',type:'INT',identity:true,primaryKey:true}];
    const identityError=await call(root+'/tables','POST',{name:'IdentityInvalid',columns:identityColumns,foreignKeys:[{keyId:parent.id,columns:['Id'],onDelete:'CASCADE',onUpdate:'CASCADE'}]});
    assert.equal(identityError.status,400);assert.match(identityError.data.error,/AUTO \(IDENTITY\)/);
    assert.ok(!(await ok(root+'/tables')).some(t=>t.name==='IdentityInvalid'));
    await ok(root+'/tables','POST',{name:'IdentityValid',columns:identityColumns,foreignKeys:[{keyId:parent.id,columns:['Id'],onDelete:'NO ACTION',onUpdate:'NO ACTION'}]});
    await attempt('IdentityDeleteCascade',identityColumns,[{keyId:parent.id,columns:['Id'],onDelete:'CASCADE'}]);
    await attempt('IdentitySetDefault',identityColumns,[{keyId:parent.id,columns:['Id'],onDelete:'SET DEFAULT'}]);
    await query('DROP TABLE dbo.IdentityValid;');
    await query('DROP TABLE dbo.Child; DROP TABLE [sales space].[Parent]]];');
    await attempt('StaleKey',[{name:'Id',type:'INT'}],[{keyId:parent.id,columns:['Id']}]);
    const icon=await fetch(base+'/icon.svg');assert.equal(icon.status,200);assert.match(icon.headers.get('content-type'),/image\/svg\+xml/);
    const page=await(await fetch(base)).text();assert.match(page,/rel="icon"[^>]+icon\.svg/);
    for(const file of ['/create-table-fks.js','/create-table-fks.css'])assert.equal((await fetch(base+file)).status,200);
  } finally {await ok(root,'DELETE',{confirm:db});}
});
