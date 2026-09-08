const cellDrafts=new Map();let cellEditor=null;
window.studioHasDrafts=()=>cellDrafts.size>0||!!cellEditor;
function requireCleanGrid(){if(window.studioHasDrafts())throw new Error('Сначала сохраните или отмените изменения ячеек.');}
// Block navigation before it changes selection; drafts cannot silently land in another table.
const gridOpen=openTable,gridLoad=loadRows,gridDatabase=selectDatabase,gridConnection=switchConnection,gridTab=tab,gridQuery=runQuery;
openTable=async(...args)=>{requireCleanGrid();await gridOpen(...args);document.dispatchEvent(new CustomEvent('table-opened'));};
loadRows=async(...args)=>{requireCleanGrid();return gridLoad(...args);};
selectDatabase=async(...args)=>{requireCleanGrid();return gridDatabase(...args);};
switchConnection=async(...args)=>{requireCleanGrid();return gridConnection(...args);};
tab=(...args)=>{if(window.studioHasDrafts()){notice('Сначала сохраните или отмените изменения ячеек.',true);return;}return gridTab(...args);};
runQuery=async(...args)=>{if(window.studioHasDrafts()){notice('Сначала сохраните или отмените изменения ячеек.',true);return;}return gridQuery(...args);};
$('run-query').onclick=runQuery;
const gridEdit=editRow,gridDelete=deleteRow;
editRow=(...args)=>{requireCleanGrid();return gridEdit(...args);};deleteRow=(...args)=>{requireCleanGrid();return gridDelete(...args);};
window.addEventListener('beforeunload',e=>{if(window.studioHasDrafts()){e.preventDefault();e.returnValue='';}});
const gridRender=showTableData;
showTableData=()=>{
  gridRender();const data=state.data;if(!data?.columns)return;
  const toolbar=document.createElement('div');toolbar.className='data-tools';toolbar.id='cell-toolbar';toolbar.innerHTML='<span class="muted">Двойной щелчок — изменить · вставка TSV из Excel · \\N = NULL</span><button class="button primary" id="cell-save" disabled>Проверить изменения</button><button class="button" id="cell-discard" disabled>Отменить</button>';
  $('table-content').prepend(toolbar);
  $('table-content').querySelectorAll('tbody tr').forEach((tr,r)=>{
    if(!data.rows[r])return;
    const link=document.createElement('button');link.className='button';link.textContent='Связи';link.onclick=safe(()=>rowRelations(r));tr.children[0].append(link);
    [...tr.children].slice(1).forEach((td,c)=>{
      td.dataset.row=r;td.dataset.col=c;td.tabIndex=0;
      if(data.editable&&data.columns[c].writable){td.classList.add('editable-cell');td.ondblclick=()=>editCell(td);td.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();editCell(td);}};td.onpaste=e=>pasteCells(e,td);}
    });
  });
  $('cell-discard').onclick=()=>{cellEditor?.remove();cellEditor=null;cellDrafts.clear();showTableData();};
  $('cell-save').onclick=()=>{
    cellEditor?.blur();if(!cellDrafts.size)return;
    const database=state.database,connection=state.connection,table=state.table;
    const changes=[...cellDrafts].map(([r,values])=>({keys:rowKeys(data.rows[r]),token:data.rows[r].token,values:Object.fromEntries(values)}));
    const preview=[...cellDrafts].flatMap(([r,values])=>[...values].map(([name,value])=>[JSON.stringify(rowKeys(data.rows[r])),name,data.rows[r].values[data.columns.findIndex(c=>c.name===name)],value]));
    modal('Сохранить изменения ячеек',`<p class="muted">${esc(table.schema+'.'+table.name)} · ${changes.length} строк. Весь пакет сохраняется одной транзакцией.</p><div class="data-scroll">${grid(['Ключ','Столбец','Было','Станет'],preview)}</div>`,async()=>{
      await api(`/api/databases/${encodeURIComponent(database)}/data/batch`,{method:'PATCH',headers:{'X-Studio-Connection':connection},body:{schema:table.schema,name:table.name,changes}});cellDrafts.clear();await loadRows();notice('Изменения сохранены.');
    },'Сохранить',false,true);
  };
};
$('show-data').onclick=()=>{if(!window.studioHasDrafts())showTableData();};
const previousStructure=showStructure;showStructure=async()=>{requireCleanGrid();return previousStructure();};$('show-structure').onclick=safe(showStructure);
function draftCell(r,c,value){
  const name=state.columns[c].name,original=state.data.rows[r].values[c];
  if(!cellDrafts.has(r))cellDrafts.set(r,new Map());const draft=cellDrafts.get(r);
  if(value===original)draft.delete(name);else draft.set(name,value);if(!draft.size)cellDrafts.delete(r);
  const td=$('table-content').querySelector(`[data-row="${r}"][data-col="${c}"]`);td.textContent=value===null?'NULL':value;td.classList.toggle('cell-dirty',value!==original);td.classList.toggle('null',value===null);
  $('cell-save').disabled=$('cell-discard').disabled=!cellDrafts.size;$('cell-save').textContent=`Проверить изменения (${cellDrafts.size} строк)`;
}
function editCell(td){
  if(cellEditor)return;const r=Number(td.dataset.row),c=Number(td.dataset.col),name=state.columns[c].name;
  const value=cellDrafts.get(r)?.has(name)?cellDrafts.get(r).get(name):state.data.rows[r].values[c];
  const input=document.createElement('textarea');input.className='cell-input';input.value=value===null?'\\N':value;input.setAttribute('aria-label','Значение '+name);cellEditor=input;td.replaceChildren(input);input.focus();
  let cancel=false;input.onkeydown=e=>{if(e.key==='Escape'){cancel=true;input.blur();}if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();input.blur();}};
  input.onblur=()=>{cellEditor=null;draftCell(r,c,cancel?value:input.value==='\\N'?null:input.value);};
}
function pasteCells(event,td){
  if(cellEditor)return;event.preventDefault();
  try{
    const rows=parseCSV(event.clipboardData.getData('text/plain'),'\t'),r=Number(td.dataset.row),c=Number(td.dataset.col);
    if(!rows.length||r+rows.length>state.data.rows.length)throw new Error('Диапазон выходит за текущую страницу.');
    for(const row of rows)if(!row.length||row.length!==rows[0].length||c+row.length>state.columns.length||row.some((_,i)=>!state.columns[c+i].writable))throw new Error('Диапазон должен быть прямоугольным и состоять из редактируемых столбцов.');
    rows.forEach((row,i)=>row.forEach((value,j)=>draftCell(r+i,c+j,value==='\\N'?null:value)));
  }catch(e){notice(e.message,true);}
}
async function rowRelations(index){
  requireCleanGrid();const table=state.table,record=state.data.rows[index],columns=state.columns,generation=state.generation;
  const model=await api(`${dbPath()}/diagram`);if(state.table!==table||generation!==state.generation)return;
  const relations=model.foreignKeys.flatMap(f=>['parent','children'].filter(direction=>direction==='parent'?f.childTableId===table.id:f.parentTableId===table.id).map(direction=>({f,direction})));
  modal('Связанные записи',`<p class="muted">${esc(table.schema+'.'+table.name)} · ${esc(JSON.stringify(rowKeys(record)))}</p><div id="row-relations">${relations.map(({f,direction},i)=>`<button type="button" class="history-item" data-relation="${i}"><strong>${esc(f.name)}</strong><small>${direction==='parent'?'Открыть родителя':'Показать дочерние записи'}${f.disabled?' · FK отключён':''}</small></button>`).join('')||'У этой таблицы нет объявленных FK.'}</div>`,async()=>{},'Закрыть');
  $('row-relations').onclick=safe(async e=>{
    const b=e.target.closest('[data-relation]');if(!b)return;const {f,direction}=relations[Number(b.dataset.relation)],parent=direction==='parent';
    const source=model.tables.find(t=>t.id===table.id),target=model.tables.find(t=>t.id===(parent?f.parentTableId:f.childTableId));
    const exact=Object.fromEntries(f.columns.map(pair=>{const sourceName=source.columns.find(c=>c.id===(parent?pair.childColumnId:pair.parentColumnId)).name,targetName=target.columns.find(c=>c.id===(parent?pair.parentColumnId:pair.childColumnId)).name;return [targetName,record.values[columns.findIndex(c=>c.name===sourceName)]];}));
    if(Object.values(exact).some(v=>v===null)){notice('NULL не образует ссылку FK. Связанных записей по этому ключу нет.');return;}
    $('modal').close();await openTable(state.tables.find(t=>t.id===target.id)||target);extra.exact=exact;extra.page=0;await loadRows();notice('Точный фильтр по связи '+f.name+'. «Сбросить» показывает все записи.');
  });
}
// Existing row actions must not mutate the server while a cell batch is pending.
$('table-content').addEventListener('click',e=>{if(window.studioHasDrafts()&&e.target.closest('[data-action],#page-size')){e.stopImmediatePropagation();e.preventDefault();notice('Сначала сохраните или отмените изменения ячеек.',true);}},true);
$('table-content').addEventListener('change',e=>{if(window.studioHasDrafts()&&e.target.id==='page-size'){e.stopImmediatePropagation();e.preventDefault();e.target.value=extra.pageSize;}},true);
