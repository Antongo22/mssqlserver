import test from 'node:test';import assert from 'node:assert/strict';
import {emptyDesign,validateDesign,designSQL} from '../lib/designer-model.js';
const column=(id,name,type='INT',extra={})=>({id,name,type,nullable:false,primaryKey:false,identity:false,unique:false,...extra});
function fixture(){return {version:1,tables:[{id:'parent',schema:'dbo',name:'Parent',x:0,y:0,columns:[column('p1','Code','INT',{primaryKey:true}),column('p2','Version','INT',{primaryKey:true})]},{id:'child',schema:'dbo',name:'Child',x:400,y:150,columns:[column('id','Id','INT',{primaryKey:true,identity:true}),column('c1','ParentCode'),column('c2','ParentVersion')]}],relations:[{id:'fk',kind:'fk',name:'FK_Composite',parent:'parent',child:'child',columns:[{parent:'p1',child:'c1'},{parent:'p2',child:'c2'}],onDelete:'NO ACTION',onUpdate:'NO ACTION'}],notes:[{id:'note',text:'Design only',x:30,y:400}]};}
test('designer validates structure and exports composite foreign keys after all tables',()=>{
 const model=fixture(),r=designSQL(model);assert.deepEqual(r.errors,[]);assert.ok(r.sql.indexOf('CREATE TABLE [dbo].[Child]')<r.sql.indexOf('ALTER TABLE'));assert.match(r.sql,/FOREIGN KEY \(\[ParentCode\], \[ParentVersion\]\) REFERENCES \[dbo\]\.\[Parent\] \(\[Code\], \[Version\]\)/);assert.ok(!r.sql.includes('Design only'));
 model.relations.push({id:'concept',kind:'association',name:'Business relation',parent:'child',child:'parent',columns:[],onDelete:'NO ACTION',onUpdate:'NO ACTION'});assert.ok(designSQL(model).warnings.some(w=>w.includes('Business relation')));
 model.tables[1].columns[1].type='BIGINT';assert.equal(designSQL(model).sql,null);assert.ok(designSQL(model).errors.some(e=>e.includes('типы')));
});
test('designer rejects broken imports and flags missing, incompatible and cascading identity keys',()=>{
 assert.throws(()=>validateDesign({...emptyDesign(),version:2}));const m=fixture();m.tables[0].x=Infinity;assert.throws(()=>validateDesign(m));m.tables[0].x=0;m.relations[0].columns[0].child='missing';assert.throws(()=>validateDesign(m));
 const a=fixture();a.relations[0].columns.pop();assert.ok(designSQL(a).errors.some(e=>e.includes('полным PK')));
 const b=fixture();b.tables[1].columns[1].identity=true;b.relations[0].onDelete='CASCADE';assert.ok(designSQL(b).errors.some(e=>e.includes('каскадное')));
 const c=fixture();c.tables[0].columns[0].type='INT); DROP DATABASE master;--';assert.equal(designSQL(c).sql,null);
 const d=fixture();d.tables[1].name='Parent';assert.ok(designSQL(d).errors.some(e=>e.includes('Повторяется таблица')));
});
const base=process.env.ADMIN_URL||'http://localhost:3001';
async function call(path,method='GET',body,connection='local'){const r=await fetch(base+path,{method,headers:{'X-Admin-Request':'1','Content-Type':'application/json','X-Studio-Connection':connection},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
async function ok(...args){const r=await call(...args);assert.ok(r.status<300,JSON.stringify(r.data));return r.data;}
test('design projects persist and reject stale saves; exported SQL creates an isolated database model',async()=>{
 const model=fixture(),name='Design test '+Date.now();let project,db;
 try{
  project=await ok('/api/designs','POST',{name,model});assert.equal(project.revision,1);assert.equal((await ok('/api/designs/'+project.id)).model.tables.length,2);assert.ok((await ok('/api/designs')).some(p=>p.id===project.id));
  const updated=await ok('/api/designs/'+project.id,'PUT',{name:name+' updated',model,revision:1});assert.equal(updated.revision,2);assert.equal((await call('/api/designs/'+project.id,'PUT',{name,model,revision:1})).status,409);project=updated;
  assert.equal((await call('/api/designs/'+project.id,'DELETE',{confirm:name,revision:1})).status,409);
  db='Studio_design_'+Date.now();await ok('/api/databases','POST',{name:db});await ok('/api/query','POST',{database:db,sql:designSQL(model).sql});const diagram=await ok('/api/databases/'+db+'/diagram');assert.equal(diagram.tables.length,2);assert.equal(diagram.foreignKeys[0].columns.length,2);
 }finally{if(db)await ok('/api/databases/'+db,'DELETE',{confirm:db});if(project)await ok('/api/designs/'+project.id,'DELETE',{confirm:project.name,revision:project.revision});}
});
test('projects remain editable on read-only production profiles without connecting to SQL Server',async()=>{
 let profile,project;
 try{
  profile=await ok('/api/connections','POST',{name:'Design offline '+Date.now(),server:'127.0.0.1',port:1,user:'designer',password:crypto.randomUUID(),environment:'production',readOnly:true});
  project=await ok('/api/designs','POST',{name:'Offline draft',model:emptyDesign()},profile.id);
  assert.equal((await call('/api/query','POST',{database:'master',sql:'SELECT 1'},profile.id)).status,403);
  assert.equal((await call('/api/designs','POST',{name:'Invalid',model:{version:99}},profile.id)).status,400);
  project=await ok('/api/designs/'+project.id,'PUT',{name:'Offline draft',revision:1,model:fixture()},profile.id);assert.equal(project.model.tables.length,2);
 }finally{if(project)await ok('/api/designs/'+project.id,'DELETE',{confirm:project.name,revision:project.revision},profile.id);if(profile)await ok('/api/connections/'+profile.id,'DELETE',{confirm:profile.name});}
});
