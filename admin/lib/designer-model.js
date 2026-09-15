import {columnType} from './create-table.js';
const q=v=>'['+v.replaceAll(']',']]')+']';
export const emptyDesign=()=>({version:1,tables:[],relations:[],notes:[]});
export function validateDesign(raw){
  const fail=m=>{throw new Error(m);};
  if(!raw||raw.version!==1)fail('Неподдерживаемый формат проекта.');
  const list=(v,n,label)=>{if(!Array.isArray(v)||v.length>n)fail(`${label}: максимум ${n}.`);return v;};
  const text=(v,n,label)=>{if(typeof v!=='string'||v.length>n)fail('Некорректное поле: '+label);return v;};
  const name=v=>{text(v,128,'имя');if(!v.trim()||/[\x00-\x1f]/.test(v))fail('Имя должно содержать 1–128 символов.');return v;};
  const ids=new Set(),id=v=>{if(typeof v!=='string'||!/^[-\w]{1,80}$/.test(v)||ids.has(v))fail('Некорректные или повторяющиеся ID.');ids.add(v);return v;};
  const pos=v=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>50000)fail('Координаты выходят за пределы холста.');return v;};
  const tables=list(raw.tables,100,'Таблицы').map(t=>({id:id(t.id),schema:name(t.schema),name:name(t.name),x:pos(t.x),y:pos(t.y),columns:list(t.columns,50,'Столбцы').map(c=>({id:id(c.id),name:name(c.name),type:text(c.type,80,'тип'),primaryKey:!!c.primaryKey,unique:!!c.unique,identity:!!c.identity,nullable:!!c.nullable}))}));
  const notes=list(raw.notes,100,'Заметки').map(n=>({id:id(n.id),text:text(n.text,4000,'заметка'),x:pos(n.x),y:pos(n.y)}));
  const actions=['NO ACTION','CASCADE','SET NULL'];
  const relations=list(raw.relations,200,'Связи').map(r=>{
    const parent=tables.find(t=>t.id===r.parent),child=tables.find(t=>t.id===r.child);if(!parent||!child)fail('Таблица связи не найдена.');
    if(!['fk','association'].includes(r.kind))fail('Неизвестный вид связи.');
    const columns=list(r.columns,16,'Столбцы связи').map(pair=>{if(!parent.columns.some(c=>c.id===pair.parent)||!child.columns.some(c=>c.id===pair.child))fail('Столбец связи не найден.');return {parent:pair.parent,child:pair.child};});
    if(r.kind==='fk'&&!columns.length)fail('Сопоставьте столбцы внешнего ключа.');
    if(!actions.includes(r.onDelete)||!actions.includes(r.onUpdate))fail('Неизвестное действие FK.');
    return {id:id(r.id),kind:r.kind,name:text(r.name,128,'название связи'),parent:r.parent,child:r.child,columns,onDelete:r.onDelete,onUpdate:r.onUpdate};
  });
  return {version:1,tables,relations,notes};
}
export function designSQL(raw){
  const model=validateDesign(raw),errors=[],statements=[],warnings=[];
  const fail=m=>errors.push(m),names=new Set(),constraintNames=new Set();
  const constraint=(schema,name)=>{const key=(schema+'.'+name).toLowerCase();if(constraintNames.has(key))fail('Повторяется имя ограничения: '+schema+'.'+name);constraintNames.add(key);return q(name);};
  if(!model.tables.length)fail('Добавьте хотя бы одну таблицу.');
  const types=new Map();
  for(const [index,t] of model.tables.entries()){
    const full=q(t.schema)+'.'+q(t.name),key=(t.schema+'.'+t.name).toLowerCase();if(names.has(key))fail('Повторяется таблица: '+t.schema+'.'+t.name);names.add(key);
    if(!t.columns.length)fail(t.name+': добавьте столбцы.');
    const colNames=new Set();for(const c of t.columns){if(colNames.has(c.name.toLowerCase()))fail(t.name+': повторяется столбец '+c.name);colNames.add(c.name.toLowerCase());try{types.set(c.id,columnType(c.type));}catch(e){fail(t.name+'.'+c.name+': '+e.message);}}
    if(t.columns.filter(c=>c.identity).length>1)fail(t.name+': допустим один IDENTITY.');
    const defs=t.columns.map(c=>{const type=types.get(c.id)||c.type;if(c.identity&&!['INT','BIGINT','SMALLINT','TINYINT'].includes(type))fail(t.name+'.'+c.name+': IDENTITY требует целочисленный тип.');if((c.primaryKey||c.unique)&&(type.includes('MAX')||type==='XML'))fail(t.name+'.'+c.name+': тип не поддерживает ключ.');if(c.identity&&c.nullable)fail(t.name+'.'+c.name+': IDENTITY не допускает NULL.');return `    ${q(c.name)} ${type}${c.identity?' IDENTITY(1,1)':''} ${c.primaryKey||!c.nullable?'NOT NULL':'NULL'}${c.unique?' UNIQUE':''}`;});
    const pk=t.columns.filter(c=>c.primaryKey);if(pk.length)defs.push(`    CONSTRAINT ${constraint(t.schema,('PK_'+t.name).slice(0,110)+'_'+(index+1))} PRIMARY KEY (${pk.map(c=>q(c.name)).join(', ')})`);else warnings.push(t.schema+'.'+t.name+': нет первичного ключа.');
    statements.push(`CREATE TABLE ${full} (\n${defs.join(',\n')}\n);`);
  }
  for(const [index,r] of model.relations.entries()){
    if(r.kind!=='fk'){warnings.push('Свободная связь «'+r.name+'» не включается в SQL.');continue;}
    const parent=model.tables.find(t=>t.id===r.parent),child=model.tables.find(t=>t.id===r.child),p=r.columns.map(x=>parent.columns.find(c=>c.id===x.parent)),c=r.columns.map(x=>child.columns.find(c=>c.id===x.child));
    const pk=parent.columns.filter(c=>c.primaryKey);
    if(new Set(p.map(c=>c.id)).size!==p.length||new Set(c.map(c=>c.id)).size!==c.length)fail('Повторяющиеся столбцы в связи '+r.name);
    if(!(p.length===1&&p[0].unique)&&!(p.length===pk.length&&p.every((c,i)=>c.id===pk[i].id)))fail('Связь '+r.name+': родитель должен быть полным PK в его порядке или столбцом UNIQUE.');
    if(c.some((column,i)=>types.get(column.id)!==types.get(p[i].id)))fail('Связь '+r.name+': типы столбцов различаются.');
    if(c.some(column=>column.identity)&&[r.onDelete,r.onUpdate].some(a=>a!=='NO ACTION'))fail('Связь '+r.name+': каскадное действие на IDENTITY недопустимо.');
    if([r.onDelete,r.onUpdate].includes('SET NULL')&&c.some(column=>!column.nullable||column.primaryKey))fail('Связь '+r.name+': SET NULL требует nullable-столбцы.');
    if(/[\x00-\x1f]/.test(r.name))fail('Имя внешнего ключа содержит управляющие символы.');
    const name=r.name.trim()||('FK_'+child.name+'_'+parent.name).slice(0,110)+'_'+(index+1);
    statements.push(`ALTER TABLE ${q(child.schema)}.${q(child.name)} ADD CONSTRAINT ${constraint(child.schema,name)} FOREIGN KEY (${c.map(c=>q(c.name)).join(', ')}) REFERENCES ${q(parent.schema)}.${q(parent.name)} (${p.map(c=>q(c.name)).join(', ')}) ON DELETE ${r.onDelete} ON UPDATE ${r.onUpdate};`);
  }
  if(errors.length)return {sql:null,errors,warnings};
  const schemas=[...new Set(model.tables.map(t=>t.schema))].filter(s=>s!=='dbo').map(s=>`IF SCHEMA_ID(N'${s.replaceAll("'","''")}') IS NULL EXEC(N'CREATE SCHEMA ${q(s).replaceAll("'","''")}');`);
  return {errors,warnings,sql:'-- Проект схемы. Проверьте имена и каскадные пути перед выполнением.\n-- Заметки и свободные связи не создают объектов SQL.\n'+[...schemas,...statements].join('\nGO\n')+'\n'};
}
