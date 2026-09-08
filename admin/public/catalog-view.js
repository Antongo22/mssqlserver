const catalogKinds={V:'Представления',P:'Процедуры',FN:'Скалярные функции',IF:'Табличные функции (inline)',TF:'Табличные функции',TR:'Триггеры',SO:'Последовательности',SN:'Синонимы',IX:'Индексы'};
loadObjects=async generation=>{
  const [data,indexes]=await Promise.all([api(`${dbPath()}/objects`),api(`${dbPath()}/indexes`)]);if(generation!==state.generation)return;
  extra.objects=data.objects;extra.catalogIndexes=indexes.indexes;
  $('objects-panel').innerHTML=`<div class="section-toolbar"><div><h2>Объекты базы</h2><p class="muted">Индексы, процедуры, представления, функции, триггеры, последовательности и синонимы</p></div><div class="actions">${button('new-object','＋ Объект')}${button('new-schema','＋ Схема')}${button('reload','↻')}</div></div><div class="panel"><div class="data-tools"><input id="object-search" type="search" placeholder="Имя объекта, таблицы или столбца индекса" aria-label="Поиск объектов"><select id="object-kind" aria-label="Тип объекта"><option value="">Все типы</option>${Object.entries(catalogKinds).map(([type,label])=>`<option value="${type}">${label}</option>`).join('')}</select><span id="object-count" class="muted"></span></div><div id="object-list"></div></div><p class="muted">Схемы: ${data.schemas.map(s=>esc(s.name)).join(', ')}</p>`;
  renderObjects();$('object-search').oninput=renderObjects;$('object-kind').onchange=renderObjects;
};
renderObjects=()=>{
  const search=$('object-search').value.toLowerCase(),kind=$('object-kind').value;
  const all=[...extra.objects.map((o,index)=>({...o,index})),...extra.catalogIndexes.map((o,index)=>({...o,type:'IX',index}))];
  const list=all.filter(o=>(!kind||o.type===kind)&&[o.schema,o.name,o.table,catalogKinds[o.type],...(o.columns||[]).map(c=>c.name)].join(' ').toLowerCase().includes(search));
  $('object-count').textContent=`${list.length} из ${all.length}`;
  $('object-list').innerHTML=list.map(o=>`<div class="object-row"><div><strong>${esc(o.schema+'.'+o.name)}</strong><small>${esc(catalogKinds[o.type]||o.kind)}${o.type==='IX'?' · '+esc(o.schema+'.'+o.table)+' · '+esc(o.kind)+(o.disabled?' · ОТКЛЮЧЁН':''):''}</small></div><div class="actions">${button(o.type==='IX'?'index-details':'object-details','Просмотр',`data-index="${o.index}"`)}${['P','V','FN','IF','TF','TR'].includes(o.type)?button('definition','SQL',`data-index="${o.index}"`):''}${o.type!=='IX'?button('drop-object','Удалить',`data-index="${o.index}"`):''}</div></div>`).join('')||blank('Нет объектов, соответствующих фильтру.');
};
const originalObjectClick=$('objects-panel').onclick;
$('objects-panel').onclick=safe(async e=>{
  const control=e.target.closest('[data-action]');if(!control)return;
  if(control.dataset.action==='object-details')return showObjectDetails(extra.objects[Number(control.dataset.index)]);
  if(control.dataset.action==='index-details')return showIndexDetails(extra.catalogIndexes[Number(control.dataset.index)]);
  return originalObjectClick(e);
});
function catalogSection(title,columns,rows){return `<h3>${esc(title)}</h3>${rows.length?`<div class="data-scroll">${grid(columns,rows)}</div>`:'<p class="muted">Нет сведений в доступном каталоге.</p>'}`;}
const catalogYes=value=>value===null||value===undefined?'—':value?'Да':'Нет';
async function showObjectDetails(object){
  requireCleanGrid();const generation=state.generation;
  const d=await api(`${dbPath()}/objects/${object.id}/details`);if(generation!==state.generation)return;
  let content=catalogSection('Свойства',['Свойство','Значение'],[['Тип',catalogKinds[d.type]||d.kind],['Создан',new Date(d.createdAt).toLocaleString('ru-RU')],['Изменён',new Date(d.modifiedAt).toLocaleString('ru-RU')],...(d.parentName?[['Родитель',d.parentSchema+'.'+d.parentName]]:[])]);
  if(['P','FN','IF','TF'].includes(d.type))content+=catalogSection('Параметры и возвращаемое значение',['Имя','Тип','Направление','READONLY'],d.parameters.map(p=>[p.id===0?'Возвращаемое значение':p.name,p.sqlType,p.id===0?'RETURN':p.output?'IN / OUT':'IN',catalogYes(p.readOnly)]))+'<p class="muted">Значения параметров по умолчанию для T-SQL смотрите в SQL-определении.</p>';
  if(d.columns.length)content+=catalogSection('Столбцы результата / объекта',['Имя','Тип','NULL'],d.columns.map(c=>[c.name,c.sqlType,catalogYes(c.nullable)]));
  if(d.trigger)content+=catalogSection('Триггер',['Свойство','Значение'],[['Отключён',catalogYes(d.trigger.disabled)],['Режим',d.trigger.insteadOf?'INSTEAD OF':'AFTER'],['События',d.events.map(e=>e.event).join(', ')],['NOT FOR REPLICATION',catalogYes(d.trigger.notForReplication)]]);
  if(d.sequence)content+=catalogSection('Последовательность',['Свойство','Значение'],[['Тип',d.sequence.typeName],['Начало',d.sequence.startValue],['Текущее значение',d.sequence.currentValue],['Шаг',d.sequence.increment],['Минимум',d.sequence.minimum],['Максимум',d.sequence.maximum],['Циклическая',catalogYes(d.sequence.cycling)],['Кэш',d.sequence.cached?(d.sequence.cacheSize||'Автоматический'):'Нет']]);
  if(d.synonym)content+=catalogSection('Синоним',['Свойство','Значение'],[['Целевой объект',d.synonym.target]]);
  content+=catalogSection('Ссылается на',['Сервер','База','Схема','Объект'],d.dependencies.map(x=>[x.server||'Текущий',x.database||'Текущая',x.schema||'—',x.name]));
  content+=catalogSection('Зависимые объекты в этой базе',['Схема','Объект'],d.dependents.map(x=>[x.schema,x.name]));
  content+='<p class="muted">Сведения зависят от прав текущего логина. Динамические и внешние ссылки могут отсутствовать.</p>';
  if(d.definition)content+=`<h3>SQL-определение</h3><pre class="sql-preview catalog-sql">${esc(d.definition)}</pre><button type="button" class="button" id="catalog-open-sql">Открыть SQL в редакторе</button>`;
  else if(['P','V','FN','IF','TF','TR'].includes(d.type))content+=`<p class="query-warning">${d.encrypted?'Определение зашифровано.':'SQL-определение недоступно текущему логину.'}</p>`;
  modal(d.schema+'.'+d.name,content,async()=>{},'Закрыть',false,true);
  if(d.definition)$('catalog-open-sql').onclick=()=>{$('modal').close();stageSQL(d.definition,d.name);};
  document.dispatchEvent(new CustomEvent('object-opened',{detail:object}));
}
function showIndexDetails(i){
  requireCleanGrid();const columnstore=[5,6].includes(i.typeId);
  const content=catalogSection('Свойства индекса',['Свойство','Значение'],[['Таблица / представление',i.schema+'.'+i.table],['Тип',i.kind],['UNIQUE',catalogYes(i.unique)],['PRIMARY KEY',catalogYes(i.primaryKey)],['Ограничение UNIQUE',catalogYes(i.uniqueConstraint)],['Отключён',catalogYes(i.disabled)],['Гипотетический',catalogYes(i.hypothetical)],['FILLFACTOR',i.fillFactor||'0 (настройка по умолчанию)'],['Размещение',i.dataSpace||'—'],['Тип размещения',i.dataSpaceKind||'—'],['Блокировки строк',catalogYes(i.allowRowLocks)],['Блокировки страниц',catalogYes(i.allowPageLocks)]])+catalogSection('Столбцы индекса',['Столбец','Роль','Порядок ключа','Сортировка','Ключ секционирования'],[...i.columns].sort((a,b)=>(a.keyOrdinal||10000+a.position)-(b.keyOrdinal||10000+b.position)).map(c=>[c.name,columnstore?'COLUMNSTORE':c.included?'INCLUDE':c.keyOrdinal?'KEY':'Служебный',c.keyOrdinal||'—',c.keyOrdinal?(c.descending?'DESC':'ASC'):'—',c.partitionOrdinal||'—']))+`<h3>Фильтр</h3><pre class="sql-preview">${esc(i.hasFilter?(i.filter||'Текст фильтра недоступен текущему логину.'):'Без фильтра')}</pre><p class="muted">Показаны столбцы из системного каталога. Неявно добавленные столбцы кластерного ключа могут отсутствовать.</p>`;
  modal(i.schema+'.'+i.table+' · '+i.name,content,async()=>{},'Закрыть',false,true);
}
const originalStructureAction=structureAction;
structureAction=async(action,dataset={})=>{
  if(action==='inspectIndexes'){
    requireCleanGrid();const table=state.table,generation=state.generation;
    const r=await api(`${dbPath()}/indexes?objectId=${table.id}`);if(table!==state.table||generation!==state.generation)return;
    modal('Индексы · '+table.schema+'.'+table.name,r.indexes.map((i,n)=>`<button type="button" class="history-item" data-inspect-index="${n}"><strong>${esc(i.name)}</strong><small>${esc(i.kind)}${i.disabled?' · ОТКЛЮЧЁН':''}</small></button>`).join('')||'<p>Индексов нет.</p>',async()=>{},'Закрыть',false,true);
    $('modal-body').onclick=safe(e=>{const b=e.target.closest('[data-inspect-index]');if(!b)return;$('modal').close();showIndexDetails(r.indexes[Number(b.dataset.inspectIndex)]);});
    $('modal').addEventListener('close',()=>{$('modal-body').onclick=null;},{once:true});return;
  }
  return originalStructureAction(action,dataset);
};
