// Additional workspaces share the existing API, selection and dialog state.
const sections = { objects: 'Объекты', security: 'Доступ', backups: 'Резервные копии', monitor: 'Мониторинг', jobs: 'SQL Agent', settings: 'Свойства' };
for (const [id, label] of Object.entries(sections)) {
  const button = document.createElement('button'); button.id = `${id}-tab`; button.className = 'tab'; button.setAttribute('role','tab'); button.setAttribute('aria-selected','false'); button.setAttribute('aria-controls',`${id}-panel`); button.textContent = label;
  document.querySelector('.tabs').append(button);
  const panel = document.createElement('section'); panel.id = `${id}-panel`; panel.hidden = true; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',`${id}-tab`); document.querySelector('.workspace').append(panel);
  button.onclick = safe(async () => { tab(id); await loadSection(id); });
}
const extra = { page: 0, pageSize: 50, filter: '', filterColumn: '', sort: '', direction: 'ASC', structure: null, objects: [], backups: [], sessions: [], jobs: [], security: null, viewId: 0 };
const field = (name,label,value='',type='text',help='') => `<label class="field">${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${type==='password'?'autocomplete="new-password"':'autocomplete="off"'}>${help?`<small>${esc(help)}</small>`:''}</label>`;
const selectField = (name,label,options,selected) => `<label class="field">${esc(label)}<select name="${name}">${options.map(o=>{const value=typeof o==='string'?o:o.value;return `<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(typeof o==='string'?o:o.label)}</option>`;}).join('')}</select></label>`;
const formValues = form => Object.fromEntries(new FormData(form));
const button = (action,label,attrs='') => `<button class="button" data-action="${action}" ${attrs}>${label}</button>`;
const blank = text => `<div class="empty small"><p>${esc(text)}</p></div>`;
function download(text,filename,type='text/plain;charset=utf-8') { const url=URL.createObjectURL(new Blob([text],{type})); const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function csvText(columns,rows) {const cell=v=>{let s=v===null?'':String(v);if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return '\uFEFF'+[columns,...rows].map(r=>r.map(cell).join(';')).join('\r\n');}
function confirmAction(title,name,action,description='Действие изменит данные или структуру.') {
  modal(title,`<p class="modal-copy">${esc(description)}</p>${field('confirm',`Введите «${name}»`)}`,async form=>{const value=formValues(form).confirm;if(value!==name)throw new Error('Имя не совпадает.');await action(value);},'Подтвердить',true);
}
async function loadSection(id) {
  if(!state.database)return;
  const generation=state.generation;
  $(id+'-panel').innerHTML=blank('Загрузка…');
  try {
    const loaders={objects:loadObjects,security:loadSecurity,backups:loadBackups,monitor:loadMonitor,jobs:loadJobs,settings:loadSettings};
    await loaders[id](generation);
  } catch(error){if(generation===state.generation)$(id+'-panel').innerHTML=`<div class="empty"><h3>Не удалось загрузить раздел</h3><p>${esc(error.message)}</p>${button('reload','Повторить')}</div>`;}
}
document.addEventListener('database-changed',safe(async()=>{
  extra.viewId++;extra.structure=null;
  document.dispatchEvent(new CustomEvent('completion-refresh'));
  for(const id of Object.keys(sections))if(!$(id+'-panel').hidden)await loadSection(id);
}));

// Paged table browser and conflict-aware row editing.
openTable = async table => {
  extra.page=0;extra.filter='';extra.filterColumn='';extra.sort='';extra.direction='ASC';extra.structure=null;
  state.table=table;renderTables();$('table-detail').hidden=false;$('table-title').textContent=`${table.schema}.${table.name}`;
  $('insert-template').textContent='＋ Запись';$('insert-template').onclick=()=>editRow();
  await loadRows();
};
async function loadRows() {
  const table=state.table;if(!table)return;
  const generation=state.generation,view=++extra.viewId;
  $('table-content').textContent='Загрузка…';
  const params=new URLSearchParams({schema:table.schema,name:table.name,page:extra.page,pageSize:extra.pageSize,filter:extra.filter,filterColumn:extra.filterColumn,sort:extra.sort,direction:extra.direction});
  const data=await api(`${dbPath()}/data?${params}`);
  if(generation!==state.generation||view!==extra.viewId)return;
  state.columns=data.columns;state.data=data;extra.sort=data.sort;

  showTableData();
}
showTableData = () => {
  $('show-data').classList.add('active');$('show-structure').classList.remove('active');
  const data=state.data;if(!data?.columns)return;
  $('data-note').textContent=data.editable?'Редактирование по первичному ключу':'Нет подходящего PK: изменение и удаление через SQL';
  $('table-content').classList.remove('data-scroll');
  const options=data.columns.map(c=>`<option ${c.name===extra.filterColumn?'selected':''}>${esc(c.name)}</option>`).join('');
  $('table-content').innerHTML=`<div class="data-tools"><select id="filter-column" aria-label="Столбец фильтра"><option value="">Столбец…</option>${options}</select><input id="filter-value" placeholder="Содержит…" aria-label="Текст фильтра" value="${esc(extra.filter)}">${button('filter','Найти')}${button('clear-filter','Сбросить')}${button('refresh-data','↻')}${button('export-data','↓ CSV')}${button('import-data','↑ CSV / Excel')}</div>
    <div class="data-scroll"><table><thead><tr><th>Действия</th>${data.columns.map((c,i)=>`<th><button class="sort-button" data-action="sort" data-index="${i}">${esc(c.name)} ${c.name===extra.sort?(extra.direction==='ASC'?'↑':'↓'):''}</button></th>`).join('')}</tr></thead><tbody>${data.rows.map((r,i)=>`<tr><td class="row-actions">${button('edit-row','Изменить',`data-index="${i}" ${!data.editable?'disabled':''}`)}${button('delete-row','×',`data-index="${i}" ${!data.editable?'disabled':''} aria-label="Удалить запись"`)}</td>${r.values.map(v=>v===null?'<td class="null">NULL</td>':`<td title="${esc(v)}">${esc(v)}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${data.columns.length+1}">Записи не найдены</td></tr>`}</tbody></table></div>
    <div class="pager"><span>Страница ${extra.page+1} · ${data.rows.length} записей</span><select id="page-size" aria-label="Записей на странице">${[25,50,100].map(n=>`<option ${n===extra.pageSize?'selected':''}>${n}</option>`).join('')}</select>${button('prev-page','←',extra.page===0?'disabled':'')}${button('next-page','→',!data.hasMore?'disabled':'')}</div>`;
  $('page-size').onchange=safe(async e=>{extra.pageSize=Number(e.target.value);extra.page=0;await loadRows();});
};
function rowKeys(row) {return Object.fromEntries(state.columns.map((c,i)=>[c,row.values[i]]).filter(([c])=>c.primaryKey).map(([c,v])=>[c.name,v]));}
function editRow(index) {
  const row=index===undefined?null:state.data.rows[index],table=state.table,columns=state.columns,database=state.database;
  const content=columns.map((c,i)=>`<div class="row-field"><label>${esc(c.name)} <small>${esc(c.sqlType)}${c.primaryKey?' · PK':''}</small></label>${!c.writable?`<div class="readonly-value">${esc(row?row.values[i]:'Автоматически')}</div>`:`<select data-mode="${i}" aria-label="Режим ${esc(c.name)}"><option value="value">Значение</option>${c.nullable?'<option value="null">NULL</option>':''}${!row?'<option value="default">По умолчанию</option>':''}</select><textarea data-value="${i}" aria-label="${esc(c.name)}" rows="1">${esc(row?row.values[i]:'')}</textarea>`}</div>`).join('');
  modal(row?'Изменить запись':'Добавить запись',`<p class="modal-copy">${esc(table.schema+'.'+table.name)}. Пустая строка и NULL — разные значения.</p><div class="row-form">${content}</div>`,async()=>{
    const values={};
    for(let i=0;i<columns.length;i++){
      const c=columns[i];if(!c.writable)continue;
      const mode=document.querySelector(`[data-mode="${i}"]`).value;
      if(mode==='default')continue;
      const value=mode==='null'?null:document.querySelector(`[data-value="${i}"]`).value;
      if(!row||value!==row.values[i])values[c.name]=value;
    }
    await api(`/api/databases/${encodeURIComponent(database)}/data`,{method:row?'PATCH':'POST',body:{schema:table.schema,name:table.name,values,...(row?{keys:rowKeys(row),token:row.token}:{})}});
    await loadRows();notice(row?'Запись обновлена.':'Запись добавлена.');
  },'Сохранить',false,true);
  columns.forEach((c,i)=>{const select=document.querySelector(`[data-mode="${i}"]`);if(!select)return;select.value=row?(row.values[i]===null?'null':'value'):(c.default||c.nullable?'default':'value');const update=()=>document.querySelector(`[data-value="${i}"]`).disabled=select.value!=='value';select.onchange=update;update();});
}
function deleteRow(index) {
  const row=state.data.rows[index],table=state.table,keys=rowKeys(row),database=state.database;
  confirmAction('Удалить запись',table.name,async()=>{await api(`/api/databases/${encodeURIComponent(database)}/data`,{method:'DELETE',body:{schema:table.schema,name:table.name,keys,token:row.token}});await loadRows();},`Будет удалена одна запись: ${JSON.stringify(keys)}`);
}
$('table-content').onclick=safe(async event=>{
  const control=event.target.closest('[data-action]');if(!control)return;
  const action=control.dataset.action,index=Number(control.dataset.index);
  if(action==='edit-row')return editRow(index);if(action==='delete-row')return deleteRow(index);
  if(action==='filter'){extra.filter=$('filter-value').value;extra.filterColumn=$('filter-column').value;extra.page=0;}
  if(action==='clear-filter'){extra.filter='';extra.filterColumn='';extra.page=0;}
  if(action==='sort'){const name=state.columns[index].name;extra.direction=extra.sort===name&&extra.direction==='ASC'?'DESC':'ASC';extra.sort=name;extra.page=0;}
  if(action==='prev-page')extra.page--;if(action==='next-page')extra.page++;
  if(['filter','clear-filter','sort','prev-page','next-page','refresh-data'].includes(action))return loadRows();
  if(action==='export-data')return download(csvText(state.columns.map(c=>c.name),state.data.rows.map(r=>r.values)),`${state.table.name}.csv`,'text/csv;charset=utf-8');
  if(action==='import-data')return importCSV();
  return structureAction(action,control.dataset);
});
showStructure = async () => {
  $('show-data').classList.remove('active');$('show-structure').classList.add('active');$('data-note').textContent='Столбцы, индексы и ограничения';
  $('table-content').classList.remove('data-scroll');
  const table=state.table,generation=state.generation;
  const s=await api(`${dbPath()}/structure?${new URLSearchParams({schema:table.schema,name:table.name})}`);
  if(table!==state.table||generation!==state.generation)return;extra.structure=s;
  $('table-content').innerHTML=`<div class="data-tools">${button('addColumn','＋ Столбец')}${button('createIndex','＋ Индекс / ключ')}${button('foreignKey','＋ Связь')}${button('check','＋ CHECK / DEFAULT')}${button('rename','Переименовать')}${button('script','DDL → SQL')}${button('truncate','Очистить')}${button('dropTable','Удалить таблицу')}</div>
    <div class="data-scroll"><table><thead><tr><th>Столбец</th><th>Тип</th><th>NULL</th><th>Свойства</th><th></th></tr></thead><tbody>${s.columns.map((c,i)=>`<tr><td>${esc(c.name)}</td><td>${esc(c.sqlType)}</td><td>${c.nullable?'Да':'Нет'}</td><td>${esc([c.primaryKey?'PK':'',c.identity?'IDENTITY':'',c.computed?'COMPUTED':'',c.default||''].filter(Boolean).join(' · '))}</td><td>${button('alterColumn','Изменить',`data-index="${i}"`)}${button('dropColumn','Удалить',`data-index="${i}"`)}</td></tr>`).join('')}</tbody></table></div>
    <div class="subsection"><h3>Индексы и ключи</h3>${s.indexes.map((i,n)=>`<div class="object-row"><div><strong>${esc(i.name)}</strong><small>${esc(i.kind)} · ${esc(i.columns)} ${i.unique?'· UNIQUE':''}</small></div><div class="actions">${button('rebuildIndex','Перестроить',`data-index="${n}"`)}${button(i.primaryKey||i.uniqueConstraint?'dropKey':'dropIndex','Удалить',`data-index="${n}"`)}</div></div>`).join('')||'<p class="muted">Нет индексов</p>'}</div>
    <div class="subsection"><h3>Внешние ключи</h3>${s.foreignKeys.map((f,n)=>`<div class="object-row"><div><strong>${esc(f.name)}</strong><small>${esc(f.column)} → ${esc(f.refSchema+'.'+f.refTable+'.'+f.refColumn)} · DELETE ${esc(f.onDelete)}</small></div>${button('dropForeignKey','Удалить',`data-index="${n}"`)}</div>`).join('')||'<p class="muted">Нет связей</p>'}</div>
    <div class="subsection"><h3>CHECK / DEFAULT</h3>${s.constraints.map((c,n)=>`<div class="object-row"><div><strong>${esc(c.name)}</strong><small>${esc(c.kind)} · ${esc(c.definition)}</small></div>${button('dropOtherConstraint','Удалить',`data-index="${n}"`)}</div>`).join('')||'<p class="muted">Нет ограничений</p>'}</div>`;
};
$('show-structure').onclick=safe(showStructure);$('show-data').onclick=showTableData;
async function structureAction(action,dataset={}) {
  const t=state.table,s=extra.structure,index=Number(dataset.index),database=state.database;
  const apply=async values=>{const result=await api(`/api/databases/${encodeURIComponent(database)}/structure`,{method:'POST',body:{schema:t.schema,name:t.name,action,...values}});if(result?.preview)return;if(action==='dropTable'||action==='rename'){await selectDatabase(database);}else{await loadRows();await showStructure();}notice('Структура обновлена.');};
  if(action==='script')return stageSQL(tableDDL(t,s));
  if(['dropTable','truncate'].includes(action))return confirmAction(action==='dropTable'?'Удалить таблицу':'Очистить таблицу',t.name,confirm=>apply({confirm}),'Данные будут удалены. Связанные объекты могут запретить операцию.');
  if(action==='rename')return modal('Переименовать таблицу',field('newName','Новое имя',t.name),async form=>apply(formValues(form)),'Переименовать');
  if(['addColumn','alterColumn'].includes(action)){
    const c=action==='alterColumn'?s.columns[index]:null;
    return modal(c?'Изменить столбец':'Добавить столбец',field('column','Имя',c?.name||'')+field('type','SQL-тип',c?.sqlType||'NVARCHAR(255)','text','Например: INT, DECIMAL(18,2), NVARCHAR(MAX), DATETIME2')+selectField('nullable','Допускает NULL',['Да','Нет'],c?.nullable===false?'Нет':'Да')+(c?field('confirm',`Подтвердите имя таблицы «${t.name}»`):''),async form=>{const v=formValues(form);await apply({...v,nullable:v.nullable==='Да'});},'Применить');
  }
  if(['dropColumn','dropIndex','dropKey','dropForeignKey','dropOtherConstraint'].includes(action)){
    const payload=action==='dropColumn'?{column:s.columns[index].name}:action==='dropIndex'?{index:s.indexes[index].name}:{action:'dropConstraint',constraint:action==='dropKey'?s.indexes[index].name:action==='dropForeignKey'?s.foreignKeys[index].name:s.constraints[index].name};
    return confirmAction('Удалить элемент структуры',t.name,confirm=>apply({...payload,confirm}));
  }
  if(action==='rebuildIndex')return apply({index:s.indexes[index].name});
  if(action==='createIndex')return modal('Индекс или ключ',field('index','Название','IX_'+t.name)+selectField('action','Вид',[{value:'createIndex',label:'Индекс'},{value:'unique',label:'Уникальное ограничение'},{value:'primaryKey',label:'Первичный ключ'}])+`<fieldset><legend>Столбцы</legend>${s.columns.map(c=>`<label class="check-inline"><input type="checkbox" name="column" value="${esc(c.name)}"> ${esc(c.name)}</label>`).join('')}</fieldset>`,async form=>{const v=formValues(form);await apply({...v,columns:new FormData(form).getAll('column')});});
  if(action==='foreignKey')return modal('Внешний ключ',field('constraint','Имя связи','FK_'+t.name)+field('columns','Столбцы через запятую')+field('refSchema','Схема связанной таблицы','dbo')+field('refTable','Связанная таблица')+field('refColumns','Связанные столбцы через запятую')+selectField('onDelete','При удалении',['NO ACTION','CASCADE','SET NULL','SET DEFAULT']),async form=>{const v=formValues(form);await apply({...v,columns:v.columns.split(',').map(s=>s.trim()),refColumns:v.refColumns.split(',').map(s=>s.trim())});});
  if(action==='check')return stageSQL(`-- Замените имя и условие перед выполнением.\nALTER TABLE ${selectedTableName()}\nADD CONSTRAINT ${quote('CK_'+t.name)} CHECK ([ColumnName] >= 0);\n\n-- Пример DEFAULT:\n-- ALTER TABLE ${selectedTableName()} ADD CONSTRAINT ${quote('DF_'+t.name)} DEFAULT (0) FOR [ColumnName];`);
}
function tableDDL(t,s) {
  const full=`${quote(t.schema)}.${quote(t.name)}`;
  const cols=s.columns.map(c=>`    ${quote(c.name)} ${c.computed?'AS '+c.expression:c.sqlType+(c.identity?` IDENTITY(${c.seed},${c.increment})`:'')+(c.nullable?' NULL':' NOT NULL')+(c.default?' DEFAULT '+c.default:'')}`);
  const keys=s.indexes.filter(i=>i.primaryKey||i.uniqueConstraint).map(i=>`    CONSTRAINT ${quote(i.name)} ${i.primaryKey?'PRIMARY KEY':'UNIQUE'} ${i.kind==='CLUSTERED'?'CLUSTERED':'NONCLUSTERED'} (${i.columns})`);
  let text=`-- Скрипт основной структуры. Проверьте специальные свойства таблицы перед переносом.\nCREATE TABLE ${full} (\n${[...cols,...keys].join(',\n')}\n);\nGO\n`;
  for(const i of s.indexes.filter(i=>!i.primaryKey&&!i.uniqueConstraint))text+=`CREATE ${i.unique?'UNIQUE ':''}${i.kind==='CLUSTERED'?'CLUSTERED':'NONCLUSTERED'} INDEX ${quote(i.name)} ON ${full} (${i.columns})${i.filter?' WHERE '+i.filter:''};\n`;
  for(const c of s.constraints.filter(c=>c.kind==='CHECK'))text+=`ALTER TABLE ${full} ADD CONSTRAINT ${quote(c.name)} CHECK ${c.definition};\n`;
  const grouped=Object.groupBy(s.foreignKeys,f=>f.name);
  for(const [name,fs] of Object.entries(grouped)){const f=fs[0];text+=`ALTER TABLE ${full} ADD CONSTRAINT ${quote(name)} FOREIGN KEY (${fs.map(x=>quote(x.column))}) REFERENCES ${quote(f.refSchema)}.${quote(f.refTable)} (${fs.map(x=>quote(x.refColumn))}) ON DELETE ${f.onDelete.replaceAll('_',' ')} ON UPDATE ${f.onUpdate.replaceAll('_',' ')};\n`;}
  return text;
}

// Object explorer: definitions are staged in an editor tab before execution.
function stageSQL(text,name='Новый запрос') {newQueryTab(text,name);tab('query');window.sqlEditor?.focus();}
async function loadObjects(generation) {
  const data=await api(`${dbPath()}/objects`);if(generation!==state.generation)return;extra.objects=data.objects;
  $('objects-panel').innerHTML=`<div class="section-toolbar"><div><h2>Объекты базы</h2><p class="muted">Представления, процедуры, функции, триггеры и схемы</p></div><div class="actions">${button('new-object','＋ Объект')}${button('new-schema','＋ Схема')}${button('reload','↻')}</div></div><div class="panel"><div class="data-tools"><input id="object-search" type="search" placeholder="Поиск объектов" aria-label="Поиск объектов"></div><div id="object-list"></div></div><p class="muted">Схемы: ${data.schemas.map(s=>esc(s.name)).join(', ')}</p>`;
  renderObjects();$('object-search').oninput=renderObjects;
}
function renderObjects(){const search=$('object-search').value.toLowerCase();$('object-list').innerHTML=extra.objects.map((o,i)=>({...o,index:i})).filter(o=>(o.schema+'.'+o.name).toLowerCase().includes(search)).map(o=>`<div class="object-row"><div><strong>${esc(o.schema+'.'+o.name)}</strong><small>${esc(o.kind)} · ${new Date(o.modifiedAt).toLocaleString('ru-RU')}</small></div><div class="actions">${button('definition','Открыть',`data-index="${o.index}"`)}${button('drop-object','Удалить',`data-index="${o.index}"`)}</div></div>`).join('')||blank('Объектов пока нет.');}
function newObject(){
  modal('Создать объект',selectField('kind','Тип',[{value:'V',label:'Представление'},{value:'P',label:'Процедура'},{value:'FN',label:'Скалярная функция'},{value:'IF',label:'Табличная функция'},{value:'TR',label:'Триггер'}])+field('schema','Схема','dbo')+field('name','Имя','NewObject'),async form=>{
    const v=formValues(form),name=`${quote(v.schema)}.${quote(v.name)}`;
    const code={V:`CREATE OR ALTER VIEW ${name}\nAS\nSELECT 1 AS Value;`,P:`CREATE OR ALTER PROCEDURE ${name}\n    @Id INT\nAS\nBEGIN\n    SET NOCOUNT ON;\n    SELECT @Id AS Id;\nEND;`,FN:`CREATE OR ALTER FUNCTION ${name} (@Value INT)\nRETURNS INT\nAS\nBEGIN\n    RETURN @Value * 2;\nEND;`,IF:`CREATE OR ALTER FUNCTION ${name} (@Id INT)\nRETURNS TABLE\nAS\nRETURN (SELECT @Id AS Id);`,TR:`CREATE OR ALTER TRIGGER ${name}\nON dbo.TableName\nAFTER INSERT, UPDATE\nAS\nBEGIN\n    SET NOCOUNT ON;\n    -- Обработка записей из inserted и deleted\nEND;`};stageSQL(code[v.kind],v.name);
  },'Открыть SQL');
}

async function loadSecurity(generation){
  const data=await api('/api/security?'+new URLSearchParams({database:state.database}));if(generation!==state.generation)return;extra.security=data;
  const roles=data.principals.filter(p=>p.type==='DATABASE_ROLE');
  $('security-panel').innerHTML=`<div class="section-toolbar"><div><h2>Пользователи и разрешения</h2><p class="muted">Логины сервера и доступ к ${esc(state.database)}</p></div>${button('reload','↻')}</div><div class="admin-columns"><section class="panel"><div class="panel-head"><h2>Логины сервера</h2>${button('create-login','＋ Логин')}</div>${data.logins.map((l,i)=>`<div class="object-row"><div><strong>${esc(l.name)}</strong><small>${esc(l.type)} · ${l.disabled?'Отключён':'Включён'}</small></div><div class="actions">${button(l.disabled?'enable-login':'disable-login',l.disabled?'Включить':'Отключить',`data-index="${i}"`)}${button('drop-login','×',`data-index="${i}" aria-label="Удалить логин"`)}</div></div>`).join('')}</section>
    <section class="panel"><div class="panel-head"><h2>Пользователи базы</h2>${button('create-user','＋ Пользователь')}</div>${data.principals.filter(p=>p.type!=='DATABASE_ROLE').map(p=>`<div class="object-row"><div><strong>${esc(p.name)}</strong><small>${esc(data.memberships.filter(m=>m.member===p.name).map(m=>m.role).join(', ')||p.authentication)}</small></div>${button('drop-user','Удалить',`data-name="${esc(p.name)}"`)}</div>`).join('')}</section></div>
    <section class="panel subsection"><div class="panel-head"><h2>Роли базы</h2><div class="actions">${button('create-role','＋ Роль')}${button('add-member','Добавить участника')}</div></div><div class="data-scroll">${grid(['Роль','Участник'],data.memberships.map(m=>[m.role,m.member]))}</div><div class="object-row"><span class="muted">${roles.map(r=>esc(r.name)).join(', ')}</span>${button('drop-member','Исключить участника')}${button('drop-role','Удалить роль')}</div></section>
    <section class="panel subsection"><div class="panel-head"><h2>Явные разрешения</h2>${button('permission','GRANT / DENY / REVOKE')}</div><div class="data-scroll">${grid(['Пользователь / роль','Состояние','Право','Область','Объект'],data.permissions.map(p=>[p.principal,p.state,p.permission,p.scope,p.objectName||'—']))}</div></section>`;
}
function securityAction(action,control){
  const data=extra.security,database=state.database;
  const apply=async body=>{await api('/api/security',{method:'POST',body:{database,...body}});await loadSection('security');notice('Права доступа обновлены.');};
  const prompts={
    'create-login':['Новый логин',field('name','Имя')+field('password','Пароль','','password'),'createLogin'],
    'create-user':['Пользователь базы',field('name','Имя пользователя')+selectField('login','Логин',data.logins.map(l=>l.name)),'createUser'],
    'create-role':['Новая роль',field('name','Имя роли'),'createRole'],
    'add-member':['Добавить в роль',selectField('role','Роль',data.principals.filter(p=>p.type==='DATABASE_ROLE').map(p=>p.name))+selectField('name','Участник',data.principals.map(p=>p.name)),'addMember'],
    'drop-member':['Исключить из роли',selectField('role','Роль',data.principals.filter(p=>p.type==='DATABASE_ROLE').map(p=>p.name))+selectField('name','Участник',data.principals.map(p=>p.name)),'dropMember'],
    'permission':['Разрешения',selectField('name','Пользователь / роль',data.principals.map(p=>p.name))+selectField('mode','Действие',['GRANT','DENY','REVOKE'])+selectField('permission','Разрешение',['SELECT','INSERT','UPDATE','DELETE','EXECUTE','VIEW DEFINITION','CREATE TABLE','CREATE VIEW','CREATE PROCEDURE','CREATE FUNCTION','CONTROL'])+field('schema','Схема','dbo')+field('object','Объект (пусто — вся база)'),'permission'],
    'drop-role':['Удалить роль',selectField('name','Роль',data.principals.filter(p=>p.type==='DATABASE_ROLE'&&!p.name.startsWith('db_')&&p.name!=='public').map(p=>p.name))+field('confirm','Введите имя выбранной роли'),'dropRole'],
  };
  if(prompts[action]){const [title,content,op]=prompts[action];return modal(title,content,async form=>apply({action:op,...formValues(form)}),'Применить');}
  const login=data.logins[Number(control.dataset.index)];
  if(action==='enable-login')return apply({action:'enableLogin',name:login.name});
  const name=action==='drop-user'?control.dataset.name:login?.name;
  const op={'drop-user':'dropUser','drop-login':'dropLogin','disable-login':'disableLogin'}[action];
  if(op)return confirmAction('Изменить доступ',name,confirm=>apply({action:op,name,confirm}));
}
async function loadBackups(generation){
  const files=await api('/api/backups');if(generation!==state.generation)return;extra.backups=files;
  $('backups-panel').innerHTML=`<div class="section-toolbar"><div><h2>Резервные копии</h2><p class="muted">Полная COPY_ONLY-копия с CHECKSUM. Отдельное хранилище сохраняется при сбросе базы.</p></div><div class="actions">${button('backup-create','＋ Копия текущей базы')}${button('backup-local-restore','Восстановить с компьютера')}${button('backup-upload','↑ Загрузить .bak')}${button('reload','↻')}</div></div><div class="panel">${files.map((f,i)=>`<div class="object-row"><div><strong>${esc(f.name)}</strong><small>${(f.size/1048576).toFixed(1)} МБ · ${new Date(f.modified).toLocaleString('ru-RU')}</small></div><div class="actions">${button('backup-download','Скачать',`data-index="${i}"`)}${button('backup-verify','Проверить',`data-index="${i}"`)}${button('backup-restore','Восстановить',`data-index="${i}"`)}${button('backup-delete','×',`data-index="${i}" aria-label="Удалить резервную копию"`)}</div></div>`).join('')||blank('Резервных копий пока нет.')}</div><p class="muted">Восстановление выполняется в новую базу. Для перезаписи существующей используйте проверенный RESTORE-скрипт в редакторе.</p>`;
}
async function backupAction(action,control){
  const file=extra.backups[Number(control.dataset.index)];
  if(action==='backup-create')return modal('Создать резервную копию',`<p class="modal-copy">База: <strong>${esc(state.database)}</strong>. Файл будет сохранён отдельно от данных SQL Server.</p>`,async()=>{await api('/api/backups',{method:'POST',body:{database:state.database}});await loadSection('backups');notice('Резервная копия создана.');},'Создать копию');
  if(action==='backup-verify'){control.disabled=true;try{await api(`/api/backups/${encodeURIComponent(file.name)}/verify`,{method:'POST'});notice('RESTORE VERIFYONLY: резервная копия прошла проверку.');}finally{control.disabled=false;}return;}
  if(action==='backup-download'){
    const response=await fetch(`/api/backups/${encodeURIComponent(file.name)}/download`,{headers:{'X-Admin-Request':'1','X-Studio-Connection':state.connection}});if(!response.ok)throw new Error('Не удалось скачать файл.');const url=URL.createObjectURL(await response.blob());const a=document.createElement('a');a.href=url;a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
  if(action==='backup-upload')return modal('Загрузить резервную копию','<label class="field">Файл .bak (до 512 МБ)<input type="file" id="backup-file" accept=".bak" required></label>',async()=>{
    const f=$('backup-file').files[0];if(!f||f.size>512*1024*1024)throw new Error('Выберите .bak размером до 512 МБ.');
    const response=await fetch('/api/backups/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Admin-Request':'1','X-Studio-Connection':state.connection},body:f});const data=await response.json();if(!response.ok)throw new Error(data.error);await loadSection('backups');notice('Файл загружен. Перед восстановлением проверьте копию.');
  },'Загрузить');
  if(action==='backup-delete')return confirmAction('Удалить резервную копию',file.name,async confirm=>{await api(`/api/backups/${encodeURIComponent(file.name)}`,{method:'DELETE',body:{confirm}});await loadSection('backups');},'Файл резервной копии будет удалён из хранилища Docker.');
  if(action==='backup-local-restore')return modal('Восстановить с компьютера','<label class="field">Файл .bak (до 512 МБ)<input type="file" id="restore-local-file" accept=".bak" required></label>'+field('database','Имя новой базы')+field('confirm','Повторите имя базы')+'<p class="modal-copy">Файл будет загружен, проверен и восстановлен. Существующая база не перезаписывается.</p>',async form=>{
    const body=formValues(form),f=$('restore-local-file').files[0];
    if(!f||f.size>512*1024*1024)throw new Error('Выберите .bak до 512 МБ.');
    if(!body.database||body.database!==body.confirm)throw new Error('Имена базы должны совпадать.');
    const response=await fetch('/api/backups/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Admin-Request':'1','X-Studio-Connection':state.connection},body:f});
    const uploaded=await response.json();if(!response.ok)throw new Error(uploaded.error);
    await api(`/api/backups/${encodeURIComponent(uploaded.name)}/verify`,{method:'POST'});
    await api(`/api/backups/${encodeURIComponent(uploaded.name)}/restore`,{method:'POST',body});
    await loadDatabases(body.database);notice('Локальный файл восстановлен в новую базу.');
  },'Загрузить и восстановить');
  if(action==='backup-restore')return modal('Восстановить в новую базу',`<p class="modal-copy">${esc(file.name)}</p>${field('database','Имя новой базы')}${field('confirm','Повторите имя базы')}`,async form=>{const body=formValues(form);await api(`/api/backups/${encodeURIComponent(file.name)}/restore`,{method:'POST',body});await loadDatabases(body.database);notice('База восстановлена.');},'Восстановить');
}
async function loadMonitor(generation){
  const data=await api('/api/monitor');if(generation!==state.generation)return;extra.sessions=data.sessions;
  $('monitor-panel').innerHTML=`<div class="section-toolbar"><div><h2>Активность сервера</h2><p class="muted">Снимок на ${new Date().toLocaleTimeString('ru-RU')} · память процесса ${data.memory.memoryMB} МБ</p></div>${button('reload','↻ Обновить')}</div><div class="service-cards">${data.services.map(s=>`<div class="panel"><strong>${esc(s.servicename)}</strong><span>${esc(s.status)}</span></div>`).join('')}</div><div class="panel data-scroll"><table><thead><tr><th>Сессия</th><th>Логин / программа</th><th>База</th><th>Статус</th><th>CPU / время</th><th>Блокировка / ожидание</th><th>Транзакции</th><th></th></tr></thead><tbody>${data.sessions.map((s,i)=>`<tr><td>${s.id}</td><td>${esc(s.login)}<br>${esc(s.program)}</td><td>${esc(s.database||'—')}</td><td>${esc(s.status)}</td><td>${s.cpuMs||0} / ${s.elapsedMs||0} мс</td><td>${s.blockedBy||'—'} / ${esc(s.wait||'—')}</td><td>${s.openTransactions}</td><td>${button('session-sql','SQL',`data-index="${i}"`)}${button('session-kill','Завершить',`data-index="${i}"`)}</td></tr>`).join('')||'<tr><td colspan="8">Нет пользовательских сессий</td></tr>'}</tbody></table></div>`;
}
async function loadJobs(generation){
  const data=await api('/api/jobs');if(generation!==state.generation)return;extra.jobs=data.jobs;
  const statuses={0:'Ошибка',1:'Успешно',2:'Повтор',3:'Отменено',4:'Выполняется'};
  $('jobs-panel').innerHTML=`<div class="section-toolbar"><div><h2>SQL Server Agent</h2><p class="muted">T-SQL задания: ручной запуск или интервал в минутах</p></div><div class="actions">${button('new-job','＋ Задание')}${button('reload','↻')}</div></div><div class="panel">${data.jobs.map((j,i)=>`<div class="object-row"><div><strong>${esc(j.name)}</strong><small>${j.enabled?'Включено':'Отключено'} · ${j.running?'Выполняется':statuses[j.lastStatus]||'Ещё не запускалось'}</small></div><div class="actions">${button(j.running?'stop-job':'start-job',j.running?'Остановить':'Запустить',`data-index="${i}"`)}${button(j.enabled?'disable-job':'enable-job',j.enabled?'Отключить':'Включить',`data-index="${i}"`)}${button('delete-job','Удалить',`data-index="${i}"`)}</div></div>`).join('')||blank('Заданий пока нет.')}</div><section class="panel subsection"><div class="panel-head"><h2>Последние 100 событий</h2></div><div class="data-scroll">${grid(['Задание','Шаг','Результат','Дата','Время','Сообщение'],data.history.map(h=>[h.name,h.step,statuses[h.status],h.date,h.time,h.message]))}</div></section>`;
}
function newJob(){modal('Новое задание',field('name','Название')+selectField('database','База',state.databases.map(d=>d.name),state.database)+field('minutes','Интервал, минут (0 — только вручную)','0','number')+'<label class="field">T-SQL<textarea name="sql" rows="8" spellcheck="false">SELECT 1;</textarea></label>',async form=>{const v=formValues(form);await api('/api/jobs',{method:'POST',body:{...v,minutes:Number(v.minutes)}});await loadSection('jobs');},'Создать');}
async function loadSettings(generation){
  const data=await api(`${dbPath()}/properties`);if(generation!==state.generation)return;
  $('settings-panel').innerHTML=`<div class="section-toolbar"><div><h2>Свойства базы</h2><p class="muted">${esc(data.collation)} · ${data.readOnly?'Только чтение':'Чтение и запись'}</p></div>${button('reload','↻')}</div><form id="properties-form" class="panel settings-form">${selectField('recovery','Модель восстановления',['SIMPLE','FULL','BULK_LOGGED'],data.recovery)}${selectField('compatibility','Уровень совместимости',['100','110','120','130','140','150','160'],String(data.compatibility))}${field('confirm',`Введите «${state.database}» для применения`)}<p class="muted">Изменение модели восстановления влияет на цепочку резервных копий журналов.</p><button class="button primary">Применить</button></form><section class="panel subsection"><div class="panel-head"><h2>Файлы базы</h2></div><div class="data-scroll">${grid(['Имя','Тип','Путь','Размер, МБ','Прирост'],data.files.map(f=>[f.name,f.kind,f.path,f.sizeMB,f.is_percent_growth?f.growth+'%':f.growth*8/1024+' МБ']))}</div></section>`;
  $('properties-form').onsubmit=safe(async event=>{event.preventDefault();await api(`${dbPath()}/properties`,{method:'PATCH',body:formValues(event.target)});await loadSection('settings');notice('Свойства базы обновлены.');});
}
for(const id of Object.keys(sections))$(id+'-panel').onclick=safe(async event=>{
  const control=event.target.closest('[data-action]');if(!control)return;const action=control.dataset.action;
  if(action==='reload')return loadSection(id);
  if(id==='objects'){
    const o=extra.objects[Number(control.dataset.index)];
    if(action==='new-object')return newObject();
    if(action==='new-schema')return modal('Новая схема',field('name','Имя схемы'),async form=>{await api(`${dbPath()}/schemas`,{method:'POST',body:formValues(form)});await loadSection('objects');});
    if(action==='definition'){
      const data=await api(`${dbPath()}/definition/${o.id}`);
      if(!data.definition)throw new Error('Для этого объекта нет SQL-текста (возможно, он зашифрован).');
      stageSQL(data.definition.replace(/^\s*(CREATE|ALTER)(?!\s+OR\s+ALTER)\s+/i,'CREATE OR ALTER '),o.name);return;
    }
    if(action==='drop-object')return confirmAction('Удалить объект',o.name,async confirm=>{await api(`${dbPath()}/objects/${o.id}`,{method:'DELETE',body:{confirm}});await loadSection('objects');});
  }
  if(id==='security')return securityAction(action,control);
  if(id==='backups')return backupAction(action,control);
  if(id==='monitor'){
    const s=extra.sessions[Number(control.dataset.index)];
    if(action==='session-sql')return stageSQL(s.sqlText||'-- Нет активного запроса',`Сессия ${s.id}`);
    if(action==='session-kill')return confirmAction('Завершить сессию',String(s.id),async confirm=>{await api('/api/monitor/kill',{method:'POST',body:{id:s.id,confirm}});await loadSection('monitor');},'Активная транзакция этой сессии будет отменена.');
  }
  if(id==='jobs'){
    if(action==='new-job')return newJob();
    const j=extra.jobs[Number(control.dataset.index)],op=action.replace('-job','');
    const apply=async confirm=>{await api(`/api/jobs/${j.id}`,{method:'POST',body:{action:op,confirm}});await loadSection('jobs');};
    if(op==='delete')return confirmAction('Удалить задание',j.name,apply);return apply();
  }
});

// Editor tabs and history are deliberately local to this browser.
const storage={read(key,fallback){try{return JSON.parse(localStorage.getItem(key))||fallback;}catch{return fallback;}},write(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}};
let queryTabs=storage.read('studio.tabs.v2',[]).filter(t=>typeof t.sql==='string').slice(0,20);
if(!queryTabs.length)queryTabs=[{id:crypto.randomUUID(),name:'Запрос 1',sql:window.sqlEditor?.getValue()||$('sql-editor').value}];
let activeQuery=queryTabs[0].id,changingTab=false;
const tabbar=document.createElement('div');tabbar.id='query-documents';tabbar.className='query-documents';document.querySelector('.editor').before(tabbar);
const toolbar=document.createElement('div');toolbar.className='query-options';toolbar.innerHTML=`${button('open-sql','↑ Открыть .sql')}${button('save-sql','↓ Сохранить .sql')}${button('query-history','История')}<label><input type="checkbox" id="query-transaction"> В транзакции</label><label><input type="checkbox" id="query-statistics"> IO / TIME</label><label>Тайм-аут <input id="query-timeout" type="number" min="1" max="600" value="60"> с</label>`;document.querySelector('.editor').before(toolbar);
const planButtons=document.createElement('div');planButtons.className='actions';planButtons.innerHTML=`${button('estimated-plan','Оценочный план')}${button('actual-plan','Запрос + план')}<button class="button danger" id="cancel-query" disabled>■ Отменить</button>`;document.querySelector('.editor-footer').prepend(planButtons);
const planPanel=document.createElement('section');planPanel.id='execution-plans';planPanel.className='panel subsection';planPanel.hidden=true;$('query-panel').append(planPanel);
function renderQueryTabs(){tabbar.innerHTML=queryTabs.map(t=>`<div class="query-document ${t.id===activeQuery?'active':''}"><button data-query="${t.id}">${esc(t.name)}</button><button data-close-query="${t.id}" aria-label="Закрыть запрос">×</button></div>`).join('')+button('new-query','＋');storage.write('studio.tabs.v2',queryTabs);}
function switchQuery(id){if(state.busy)throw new Error('Дождитесь завершения запроса или отмените его.');const t=queryTabs.find(t=>t.id===id);if(!t)return;activeQuery=id;changingTab=true;setEditorText(t.sql);changingTab=false;renderQueryTabs();}
function newQueryTab(text='',name){if(state.busy)throw new Error('Дождитесь завершения текущего запроса.');if(queryTabs.length>=20)throw new Error('Открыто 20 вкладок. Закройте ненужные.');const t={id:crypto.randomUUID(),name:name||`Запрос ${queryTabs.length+1}`,sql:text};queryTabs.push(t);switchQuery(t.id);}
$('sql-editor').addEventListener('input',()=>{if(changingTab)return;const t=queryTabs.find(t=>t.id===activeQuery);if(t){t.sql=window.sqlEditor?.getValue()||$('sql-editor').value;storage.write('studio.tabs.v2',queryTabs);}});
tabbar.onclick=safe(event=>{const q=event.target.closest('[data-query]'),close=event.target.closest('[data-close-query]');if(q)return switchQuery(q.dataset.query);if(close){if(state.busy)throw new Error('Сначала завершите запрос.');if(queryTabs.length===1)return;queryTabs=queryTabs.filter(t=>t.id!==close.dataset.closeQuery);switchQuery(queryTabs.some(t=>t.id===activeQuery)?activeQuery:queryTabs[0].id);}if(event.target.closest('[data-action="new-query"]'))newQueryTab();});
toolbar.onclick=safe(async event=>{
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action==='save-sql')return download(window.sqlEditor?.getValue()||$('sql-editor').value,'query.sql');
  if(action==='open-sql'){
    const input=document.createElement('input');input.type='file';input.accept='.sql,text/plain';input.onchange=safe(async()=>{const file=input.files[0];if(file.size>1024*1024)throw new Error('SQL-файл больше 1 МБ.');newQueryTab(await file.text(),file.name);});input.click();
  }
  if(action==='query-history'){
    const history=storage.read('studio.history.v2',[]);
    modal('История запросов',`<p class="modal-copy">Последние 50 успешных запросов сохранены только в этом браузере. SQL может содержать чувствительные данные.</p><div class="history-list">${history.map((h,i)=>`<button type="button" class="history-item" data-history="${i}"><strong>${esc(h.database)} · ${new Date(h.at).toLocaleString('ru-RU')}</strong><code>${esc(h.sql.slice(0,180))}</code></button>`).join('')||'История пуста'}</div>`,async()=>{storage.write('studio.history.v2',[]);},'Очистить историю',true,true);
    $('modal-body').querySelectorAll('[data-history]').forEach(b=>b.onclick=()=>{stageSQL(history[Number(b.dataset.history)].sql,'Из истории');$('modal').close();});
  }
});
planButtons.onclick=safe(async event=>{
  if(event.target.closest('#cancel-query')){await api(`/api/query/${state.queryId}/cancel`,{method:'POST'});return;}
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action&&!state.busy){state.planMode=action==='estimated-plan'?'estimated':'actual';await runQuery();}
});
document.addEventListener('query-completed',event=>{
  const {database,sql:query,result}=event.detail;
  const history=storage.read('studio.history.v2',[]);history.unshift({database,sql:query,at:Date.now()});storage.write('studio.history.v2',history.slice(0,50));
  const plans=result.recordsets.flatMap(set=>set.rows.flat().filter(v=>typeof v==='string'&&v.includes('<ShowPlanXML')));
  planPanel.hidden=!plans.length;
  planPanel.innerHTML=plans.map((xml,i)=>{
    const doc=new DOMParser().parseFromString(xml,'application/xml');
    const nodes=[...doc.getElementsByTagNameNS('*','RelOp')];
    return `<div class="panel-head"><h2>План ${i+1}</h2><button class="button" data-plan="${i}">↓ .sqlplan</button></div><div class="data-scroll">${grid(['Оператор','Логическая операция','Оценка строк','Стоимость поддерева'],nodes.map(n=>[n.getAttribute('PhysicalOp'),n.getAttribute('LogicalOp'),n.getAttribute('EstimateRows'),n.getAttribute('EstimatedTotalSubtreeCost')]))}</div>`;
  }).join('');
  planPanel.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>download(plans[Number(b.dataset.plan)],'query.sqlplan','application/xml'));
});
switchQuery(activeQuery);

function parseCSV(text,delimiter){
  const rows=[];let row=[],value='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else quoted=false;}else value+=c;}
    else if(c==='"'&&!value)quoted=true;
    else if(c===delimiter){row.push(value);value='';}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);rows.push(row);row=[];value='';}
    else value+=c;
  }
  if(quoted)throw new Error('В CSV не закрыта кавычка.');
  if(value||row.length){row.push(value);rows.push(row);}return rows;
}
function importCSV(){
  const table=state.table,database=state.database;
  modal('Импорт CSV',`<p class="modal-copy">Первая строка — имена столбцов. До 500 строк / 1 МБ за импорт. Все строки добавляются одной транзакцией. Столбцы IDENTITY не указывайте.</p><label class="field">CSV-файл<input type="file" id="csv-file" accept=".csv,text/csv" required></label>${selectField('delimiter','Разделитель',[{value:';',label:'Точка с запятой'},{value:',',label:'Запятая'},{value:'\t',label:'Табуляция'}])}${field('nullValue','Маркер NULL','\\N','text','Пустая ячейка остаётся пустой строкой.')}`,async form=>{
    const f=$('csv-file').files[0],v=formValues(form);if(!f||f.size>1024*1024)throw new Error('Выберите CSV до 1 МБ.');
    const [headers,...rows]=parseCSV(await f.text(),v.delimiter);
    if(!headers?.length||new Set(headers).size!==headers.length)throw new Error('Имена столбцов отсутствуют или повторяются.');
    if(rows.some(r=>r.length!==headers.length))throw new Error('Количество ячеек не совпадает с заголовком.');
    const records=rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]===v.nullValue?null:r[i]])));
    await api(`/api/databases/${encodeURIComponent(database)}/data/import`,{method:'POST',body:{schema:table.schema,name:table.name,records}});await loadRows();notice(`Импортировано ${records.length} записей.`);
  },'Импортировать');
}

// Query templates always stage editable SQL; they never execute it automatically.
const originalTemplate=template;
const templateSelect=$('query-template');
templateSelect.innerHTML='<option value="">Выбрать…</option><option value="select-builder">SELECT: фильтры и сортировка</option><option value="select-desc">Последние записи (DESC)</option><option value="paging">Постраничный вывод</option><option value="group">GROUP BY и COUNT</option><option value="join">JOIN двух таблиц</option><option value="insert">INSERT</option><option value="update">UPDATE с WHERE</option><option value="delete">DELETE с WHERE</option><option value="create">CREATE TABLE</option><option value="transaction">Транзакция TRY / CATCH</option>';
template=type=>{
  if(['select','select-builder','select-desc','paging','group','join'].includes(type))return selectBuilder(type);
  if(type==='transaction'){stageSQL('SET XACT_ABORT ON;\nBEGIN TRY\n    BEGIN TRANSACTION;\n\n    -- INSERT / UPDATE / DELETE\n\n    COMMIT TRANSACTION;\nEND TRY\nBEGIN CATCH\n    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\n    THROW;\nEND CATCH;','Транзакция');return;}
  originalTemplate(type);
};
$('query-template').onchange=safe(event=>{const value=event.target.value;event.target.value='';return template(value);});
$('select-template').onclick=safe(()=>selectBuilder('select-builder'));
async function selectBuilder(mode){
  if(!state.tables.length)throw new Error('Создайте таблицу или выберите базу с таблицами.');
  const tables=state.tables,database=state.database;
  const index=Math.max(0,tables.findIndex(t=>t.id===state.table?.id));
  const tableOptions=tables.map((t,i)=>({value:String(i),label:t.schema+'.'+t.name}));
  modal(mode==='join'?'Конструктор JOIN':mode==='group'?'Группировка данных':'SELECT: фильтр и сортировка',
    selectField('table','Таблица',tableOptions,String(index))+'<div id="select-builder-fields">Загрузка столбцов…</div>',async form=>{
    const v=formValues(form),table=tables[Number(v.table)],full=`${quote(table.schema)}.${quote(table.name)}`;
    const cols=new FormData(form).getAll('selectColumn');
    const literal=value=>"N'"+value.replaceAll("'","''")+"'";
    let text;
    if(mode==='join'){
      const other=tables[Number(v.joinTable)];
      if(!v.leftKey||!v.rightKey)throw new Error('Выберите столбцы связи.');
      text=`SELECT a.*, b.*\nFROM ${full} AS a\n${v.joinType==='LEFT'?'LEFT':'INNER'} JOIN ${quote(other.schema)}.${quote(other.name)} AS b\n    ON a.${quote(v.leftKey)} = b.${quote(v.rightKey)};`;
    }else if(mode==='group'){
      if(!v.groupColumn)throw new Error('Выберите столбец группировки.');
      text=`SELECT ${quote(v.groupColumn)}, COUNT_BIG(*) AS [Количество]\nFROM ${full}\nGROUP BY ${quote(v.groupColumn)}\nORDER BY [Количество] DESC;`;
    }else{
      const limit=Number(v.limit),offset=Number(v.offset);
      if(!Number.isInteger(limit)||limit<1||limit>100000)throw new Error('Число строк: 1–100000.');
      if(!Number.isInteger(offset)||offset<0)throw new Error('Смещение должно быть целым и неотрицательным.');
      const orders=[];
      for(let i=0;i<3;i++)if(v['sort'+i]&&!orders.some(o=>o.name===v['sort'+i]))orders.push({name:v['sort'+i],direction:v['direction'+i]==='DESC'?'DESC':'ASC'});
      if(offset&&!orders.length)throw new Error('Для смещения выберите сортировку.');
      text=`SELECT ${offset?'':`TOP (${limit}) `}${cols.length?cols.map(quote).join(', '):'*'}\nFROM ${full}`;
      if(v.whereColumn){const op=v.operator;const allowed=['=','<>','>','>=','<','<=','LIKE','IS NULL','IS NOT NULL'];if(!allowed.includes(op))throw new Error('Неверный оператор.');text+=`\nWHERE ${quote(v.whereColumn)} ${op}${op.startsWith('IS ')?'':' '+literal(v.whereValue)}`;}
      if(orders.length)text+='\nORDER BY '+orders.map(o=>`${quote(o.name)} ${o.direction}`).join(', ');
      if(offset)text+=`\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
      text+=';';
    }
    stageSQL(text,table.name+' · '+(mode==='group'?'GROUP BY':mode==='join'?'JOIN':'SELECT'));
  },'Открыть в редакторе',false,true);
  let revision=0;
  async function updateFields(){
    const current=++revision,table=tables[Number($('modal-body').querySelector('[name=table]').value)];
    const s=await api(`/api/databases/${encodeURIComponent(database)}/structure?${new URLSearchParams({schema:table.schema,name:table.name})}`);
    if(current!==revision||!$('select-builder-fields'))return;
    const columns=s.columns.map(c=>c.name),empty=[{value:'',label:'Не выбрано'},...columns];
    if(mode==='group'){$('select-builder-fields').innerHTML=selectField('groupColumn','Группировать по',columns);return;}
    if(mode==='join'){
      $('select-builder-fields').innerHTML=selectField('leftKey','Столбец первой таблицы',columns)+selectField('joinType','Тип JOIN',['INNER','LEFT'])+selectField('joinTable','Вторая таблица',tableOptions,String(index===0&&tables.length>1?1:0))+'<div id="join-right"></div>';
      let joinRevision=0;
      const updateRight=async()=>{const jr=++joinRevision,other=tables[Number($('modal-body').querySelector('[name=joinTable]').value)];const m=await api(`/api/databases/${encodeURIComponent(database)}/structure?${new URLSearchParams({schema:other.schema,name:other.name})}`);if(current===revision&&jr===joinRevision&&$('join-right'))$('join-right').innerHTML=selectField('rightKey','Столбец второй таблицы',m.columns.map(c=>c.name));};
      $('modal-body').querySelector('[name=joinTable]').onchange=safe(updateRight);await updateRight();return;
    }
    const defaultSort=s.columns.find(c=>c.primaryKey)?.name||columns[0];
    $('select-builder-fields').innerHTML=`<fieldset><legend>Выводимые столбцы (ничего не выбрано — все)</legend>${columns.map(c=>`<label class="check-inline"><input type="checkbox" name="selectColumn" value="${esc(c)}"> ${esc(c)}</label>`).join('')}</fieldset><div class="builder-grid">${selectField('whereColumn','Фильтр по столбцу',empty)}${selectField('operator','Условие',['=','<>','>','>=','<','<=','LIKE','IS NULL','IS NOT NULL'])}${field('whereValue','Значение (для LIKE: %текст%)')}</div><h3>Сортировка</h3>${[0,1,2].map(i=>`<div class="builder-sort">${selectField('sort'+i,i?'Затем по':'Сначала по',empty,i?'':defaultSort)}${selectField('direction'+i,'Порядок',[{value:'ASC',label:'ASC — по возрастанию'},{value:'DESC',label:'DESC — по убыванию'}],mode==='select-desc'?'DESC':'ASC')}</div>`).join('')}<div class="builder-sort">${field('limit','Максимум строк','100','number')}${field('offset','Пропустить строк',mode==='paging'?'100':'0','number')}</div><p class="muted">Запрос появится в редакторе. В режиме просмотра результатов действуют лимиты панели.</p>`;
  }
  $('modal-body').querySelector('[name=table]').onchange=safe(updateFields);await updateFields();
}
