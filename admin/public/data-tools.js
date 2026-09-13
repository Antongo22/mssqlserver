const dataToolsRender=showTableData;
showTableData=()=>{dataToolsRender();if(!state.data?.columns)return;const box=document.createElement('div');box.className='data-tools';box.innerHTML='<button class="button" id="advanced-filters">Фильтры и сортировка</button><button class="button" id="full-export">Экспорт всех строк…</button><span class="muted">'+(extra.filters?'Расширенный фильтр включён. ':'')+(extra.sorts?.length?'Сортировка: '+extra.sorts.map(s=>esc(s.column)+' '+s.direction).join(', '):'')+'</span>';$('table-content').prepend(box);$('advanced-filters').onclick=safe(openFilters);$('full-export').onclick=safe(exportAllRows);};
$('show-data').onclick=()=>{if(!window.studioHasDrafts())showTableData();};
function openFilters(){
  requireCleanGrid();const columns=state.columns.map(c=>c.name);
  modal('Фильтры и сортировка','<p class="muted">Группы AND / OR, до 4 уровней. В списках IN вводите каждое значение с новой строки; для BETWEEN — две строки.</p><div id="filter-builder"></div><h3>Сортировка (по приоритету)</h3><div id="sort-builder"></div><button type="button" class="button" id="sort-add">＋ Столбец сортировки</button>',async()=>{
    const readGroup=el=>{const rules=[...el.querySelector('.filter-items').children].map(row=>row.classList.contains('filter-group')?readGroup(row):{column:row.querySelector('[data-column]').value,op:row.querySelector('[data-op]').value,...(['IN','NOT IN','BETWEEN'].includes(row.querySelector('[data-op]').value)?{values:row.querySelector('textarea').value.split('\n')}:{value:row.querySelector('textarea').value})});return {logic:el.querySelector('[data-logic]').value,rules};};
    const filters=readGroup($('filter-builder').firstElementChild),sorts=[...$('sort-builder').children].map(row=>({column:row.querySelector('[data-sort-column]').value,direction:row.querySelector('[data-direction]').value}));
    extra.filters=filters.rules.length?filters:null;extra.sorts=sorts;extra.page=0;await loadRows();
  },'Применить',false,true);
  const select=(attr,values,value)=>`<select ${attr}>${values.map(v=>`<option ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select>`;
  function group(data={logic:'AND',rules:[]},depth=0){
    const el=document.createElement('fieldset');el.className='filter-group';el.innerHTML=`<legend>Группа ${depth+1}</legend><div class="data-tools">${select('data-logic aria-label="Логика группы"',['AND','OR'],data.logic)}<button type="button" class="button" data-add-rule>＋ Условие</button>${depth<3?'<button type="button" class="button" data-add-group>＋ Группа</button>':''}${depth?'<button type="button" class="button" data-remove-group>Удалить группу</button>':''}</div><div class="filter-items"></div>`;
    const items=el.querySelector('.filter-items');
    function rule(d={column:columns[0],op:'=',value:''}){const row=document.createElement('div');row.className='filter-rule';row.innerHTML=select('data-column aria-label="Столбец"',columns,d.column)+select('data-op aria-label="Условие"',['=','<>','>','>=','<','<=','CONTAINS','IN','NOT IN','BETWEEN','IS NULL','IS NOT NULL'],d.op)+`<textarea rows="2" aria-label="Значение">${esc(d.values?d.values.join('\n'):d.value||'')}</textarea><button type="button" class="button" aria-label="Удалить условие">×</button>`;row.querySelector('button').onclick=()=>row.remove();const update=()=>{row.querySelector('textarea').disabled=row.querySelector('[data-op]').value.includes('NULL');};row.querySelector('[data-op]').onchange=update;update();items.append(row);}
    el.querySelector('[data-add-rule]').onclick=()=>rule();const add=el.querySelector('[data-add-group]');if(add)add.onclick=()=>items.append(group(undefined,depth+1));const remove=el.querySelector('[data-remove-group]');if(remove)remove.onclick=()=>el.remove();for(const d of data.rules)if(d.rules)items.append(group(d,depth+1));else rule(d);return el;
  }
  $('filter-builder').append(group(extra.filters||undefined));
  function sort(d={column:columns[0],direction:'ASC'}){if($('sort-builder').children.length>=8)return;const row=document.createElement('div');row.className='data-tools';row.innerHTML=select('data-sort-column aria-label="Столбец сортировки"',columns,d.column)+select('data-direction aria-label="Направление"',['ASC','DESC'],d.direction)+'<button type="button" class="button">×</button>';row.querySelector('button').onclick=()=>row.remove();$('sort-builder').append(row);}
  for(const s of extra.sorts||[])sort(s);$('sort-add').onclick=()=>sort();
}
function exportAllRows(){
  requireCleanGrid();const table=state.table,database=state.database,connection=state.connection;
  const params=new URLSearchParams({schema:table.schema,name:table.name,filter:extra.filter,filterColumn:extra.filterColumn,sort:extra.sort,direction:extra.direction,exact:JSON.stringify(extra.exact||{}),filters:JSON.stringify(extra.filters||null),sorts:JSON.stringify(extra.sorts||[])});
  const controller=new AbortController();let active=false,finished=false;
  modal('Полный экспорт CSV','<p class="muted">Все строки с текущими фильтрами и сортировкой. NULL записывается как \\N. Формулы Excel экранируются. При поддержке браузером файл пишется прямо на диск; иначе скачивание ограничено 128 МБ.</p><button type="button" class="button primary" id="export-start">Начать экспорт</button><p id="export-progress" role="status">Готов к запуску</p>',async()=>{},'Закрыть / отменить',false,true);
  $('modal').addEventListener('close',()=>controller.abort(),{once:true});
  $('export-start').onclick=async()=>{
    if(active||finished)return;active=true;const progress=$('export-progress'),start=$('export-start');start.disabled=true;let sink;
    try{
      if(window.showSaveFilePicker){const file=await window.showSaveFilePicker({suggestedName:table.name+'.csv',types:[{description:'CSV',accept:{'text/csv':['.csv']}}]});sink=await file.createWritable();}
      const response=await fetch(`/api/databases/${encodeURIComponent(database)}/data/export?${params}`,{headers:{'X-Admin-Request':'1','X-Studio-Connection':connection},signal:controller.signal});if(!response.ok)throw new Error((await response.json()).error);
      const reader=response.body.getReader(),decoder=new TextDecoder(),chunks=[];let pending='',bytes=0,done=false;
      while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});let newline;
        while((newline=pending.indexOf('\n'))>=0){const item=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);if(item.error)throw new Error(item.error);if(item.csv){bytes+=new Blob([item.csv]).size;if(sink)await sink.write(item.csv);else{if(bytes>128*1024*1024)throw new Error('Файл больше 128 МБ. Используйте браузер с прямым сохранением на диск или сузьте фильтр.');chunks.push(item.csv);}}if(item.done)done=true;progress.textContent=`${item.rows.toLocaleString('ru-RU')} строк · ${(bytes/1048576).toFixed(1)} МБ`;}
      }
      if(!done||controller.signal.aborted)throw new Error('Экспорт прерван. Файл не сохранён.');
      if(sink){await sink.close();sink=null;}else{const blob=new Blob(chunks,{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=table.name+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      finished=true;progress.textContent+=' · Готово';
    }catch(e){controller.abort();if(sink)await sink.abort().catch(()=>{});progress.textContent=e.name==='AbortError'?'Экспорт отменён':e.message;}finally{active=false;}
  };
}
