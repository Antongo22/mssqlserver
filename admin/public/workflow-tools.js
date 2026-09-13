const procedureResults=addWorkspace('procedure-results','Результат процедуры');
const workflowRenderObjects=renderObjects;
renderObjects=()=>{workflowRenderObjects();$('object-list').querySelectorAll('[data-action="object-details"]').forEach(b=>{const o=extra.objects[Number(b.dataset.index)];if(o.type==='P'){const run=document.createElement('button');run.className='button';run.textContent='Выполнить…';run.onclick=safe(()=>runProcedureForm(o));b.after(run);}});};
async function runProcedureForm(o){
  requireCleanGrid();const database=state.database,connection=state.connection,generation=state.generation;
  const d=await api(`${dbPath()}/objects/${o.id}/details`);if(generation!==state.generation)return;
  let runningId=null;const abort=new AbortController();
  modal('Выполнить '+o.schema+'.'+o.name,`<p class="muted">Процедура может изменять данные. «По умолчанию» пропускает параметр при вызове; OUTPUT возвращается для явно переданных параметров. Табличные и пользовательские типы задаются через SQL-редактор.</p>${d.parameters.filter(p=>p.id>0).map((p,i)=>`<div class="procedure-parameter"><strong>${esc(p.name)} · ${esc(p.sqlType)}${p.output?' OUTPUT':''}</strong>${selectField('mode'+i,'Режим',[{value:'default',label:'По умолчанию'},{value:'value',label:'Значение'},{value:'null',label:'NULL'}],p.output?'null':'default')}${field('value'+i,'Значение')}</div>`).join('')}<button type="button" class="button danger" id="procedure-cancel" disabled>Отменить выполнение</button>`,async form=>{
    const values=formValues(form),parameters=Object.fromEntries(d.parameters.filter(p=>p.id>0).map((p,i)=>[p.name,{mode:values['mode'+i],value:values['value'+i]}]));runningId=crypto.randomUUID();$('procedure-cancel').disabled=false;
    try{const r=await api(`/api/databases/${encodeURIComponent(database)}/procedures/${o.id}/execute`,{method:'POST',headers:{'X-Studio-Connection':connection},body:{id:runningId,parameters},signal:abort.signal});
      procedureResults.innerHTML=`<h2>${esc(o.schema+'.'+o.name)}</h2><p>${esc(database)} · ${esc(connectionProfiles.find(c=>c.id===connection)?.name||connection)}</p><p>Код возврата: <strong>${esc(r.returnValue)}</strong></p>${catalogSection('OUTPUT',['Параметр','Значение'],Object.entries(r.output))}${r.recordsets.map((set,i)=>catalogSection('Результат '+(i+1),set.columns,set.rows)).join('')}<pre class="sql-preview">${esc(r.messages.join('\n'))}</pre>${r.truncated?'<p class="query-warning">Результат сокращён по лимитам редактора.</p>':''}`;
      tab('procedure-results');notice('Процедура выполнена.');document.dispatchEvent(new CustomEvent('completion-refresh'));
    }finally{runningId=null;const b=$('procedure-cancel');if(b)b.disabled=true;}
  },'Выполнить',false,true);
  $('modal-body').querySelectorAll('.procedure-parameter').forEach(row=>{const mode=row.querySelector('select'),input=row.querySelector('input');mode.onchange=()=>{input.disabled=mode.value!=='value';};mode.onchange();});
  $('procedure-cancel').onclick=safe(async()=>{if(runningId)await api('/api/query/'+runningId+'/cancel',{method:'POST',headers:{'X-Studio-Connection':connection}});});
  $('modal').addEventListener('close',()=>{abort.abort();},{once:true});
}
const inspectIndex=showIndexDetails;
showIndexDetails=i=>{inspectIndex(i);const b=document.createElement('button');b.type='button';b.className='button';b.textContent='Диагностика индекса';$('modal-body').append(b);const target=document.createElement('section');$('modal-body').append(target);const database=state.database,connection=state.connection;
  b.onclick=async()=>{b.disabled=true;target.textContent='Сбор статистики…';try{const r=await api(`/api/databases/${encodeURIComponent(database)}/index-diagnostics?${new URLSearchParams({objectId:i.objectId,indexId:i.indexId})}`,{headers:{'X-Studio-Connection':connection}});if(!target.isConnected)return;
    target.innerHTML=catalogSection('Размер и использование',['Показатель','Значение'],[['Строк',r.size.rows],['Размер, МБ',r.size.sizeMB],['Страниц',r.size.pages],['Seeks',r.usage?.seeks??'Нет сведений'],['Scans',r.usage?.scans??'Нет сведений'],['Lookups',r.usage?.lookups??'Нет сведений'],['Updates',r.usage?.updates??'Нет сведений'],['Последний seek',r.usage?.lastSeek||'—'],['Последний scan',r.usage?.lastScan||'—'],['Последнее изменение',r.usage?.lastUpdate||'—'],['Сервер запущен',new Date(r.startedAt).toLocaleString('ru-RU')]])+catalogSection('Фрагментация B-tree · LIMITED',['Секция','Страниц','Фрагментация, %'],r.fragmentation.map(p=>[p.partitionNumber,p.pages,p.fragmentation?.toFixed(2)]))+'<p class="muted">Счётчики сбрасываются при перезапусках и других событиях. Нулевое использование само по себе не означает, что индекс лишний. Для columnstore и специальных индексов фрагментация B-tree не рассчитывается.</p>';
    const candidates=r.fragmentation.filter(p=>Number(p.pages)>=1000&&p.fragmentation>=10);if(candidates.length)target.innerHTML+='<p class="query-warning">Есть крупные фрагментированные секции: проверьте планы и нагрузку перед обслуживанием. Автоматические изменения не выполняются.</p>';
  }catch(e){target.textContent=e.message;}finally{b.disabled=false;}};
};
// FK selection fills the existing row form, including every column of a composite key.
const rowFormEdit=editRow;
editRow=(...args)=>{rowFormEdit(...args);const table=state.table,generation=state.generation,body=$('modal-body'),marker=crypto.randomUUID();body.dataset.fkPicker=marker;$('modal').addEventListener('close',()=>{if(body.dataset.fkPicker===marker)delete body.dataset.fkPicker;},{once:true});
  api(`${dbPath()}/diagram`).then(model=>{
    if(generation!==state.generation||body.dataset.fkPicker!==marker||!$('modal').open)return;
    const relations=model.foreignKeys.filter(f=>f.childTableId===table.id),section=document.createElement('section');section.innerHTML='<h3>Выбрать связанную запись</h3>';if(!relations.length)return;body.append(section);
    for(const fk of relations){const parent=model.tables.find(t=>t.id===fk.parentTableId),child=model.tables.find(t=>t.id===fk.childTableId);const mappings=fk.columns.map(pair=>({local:child.columns.find(c=>c.id===pair.childColumnId).name,remote:parent.columns.find(c=>c.id===pair.parentColumnId).name}));if(mappings.some(m=>!state.columns.find(c=>c.name===m.local)?.writable))continue;
      const b=document.createElement('button');b.className='button';b.type='button';b.textContent=fk.name+' → '+parent.schema+'.'+parent.name;b.onclick=safe(()=>pickForeignRow(parent,mappings,section,marker));section.append(b);
    }
  }).catch(e=>{if($('modal').open&&body.dataset.fkPicker===marker)notice(e.message,true);});
};
async function pickForeignRow(parent,mappings,section,marker){
  section.querySelector('.fk-record-picker')?.remove();const pane=document.createElement('div');pane.className='fk-record-picker';pane.innerHTML='<h4>'+esc(parent.schema+'.'+parent.name)+'</h4><div class="data-tools"><select aria-label="Поле поиска"></select><input placeholder="Содержит…" aria-label="Поиск записи"><button type="button" class="button" data-find>Найти</button><button type="button" class="button" data-prev>←</button><button type="button" class="button" data-next>→</button><button type="button" class="button" data-close>Закрыть выбор</button></div><div class="data-scroll" data-rows></div>';section.append(pane);
  const database=state.database,connection=state.connection;let page=0,revision=0;
  const current=()=>pane.isConnected&&$('modal').open&&$('modal-body').dataset.fkPicker===marker;
  async function load(){const version=++revision;const params=new URLSearchParams({schema:parent.schema,name:parent.name,page,pageSize:25,filterColumn:pane.querySelector('select').value||'',filter:pane.querySelector('input').value});const r=await api(`/api/databases/${encodeURIComponent(database)}/data?${params}`,{headers:{'X-Studio-Connection':connection}});if(!current()||version!==revision)return;
    if(!pane.querySelector('select').children.length)pane.querySelector('select').innerHTML=r.columns.map(c=>`<option>${esc(c.name)}</option>`).join('');
    pane.querySelector('[data-prev]').disabled=page===0;pane.querySelector('[data-next]').disabled=!r.hasMore;
    const rows=pane.querySelector('[data-rows]');rows.innerHTML=r.rows.map((row,i)=>`<button type="button" class="history-item" data-pick="${i}">${r.columns.map((c,j)=>`<span><strong>${esc(c.name)}:</strong> ${esc(row.values[j]===null?'NULL':row.values[j])}</span>`).join(' · ')}</button>`).join('')||'<p>Записи не найдены.</p>';
    rows.onclick=e=>{const b=e.target.closest('[data-pick]');if(!b||!current())return;const row=r.rows[Number(b.dataset.pick)];for(const m of mappings){const index=state.columns.findIndex(c=>c.name===m.local),value=row.values[r.columns.findIndex(c=>c.name===m.remote)],mode=$('modal-body').querySelector(`[data-mode="${index}"]`),input=$('modal-body').querySelector(`[data-value="${index}"]`);mode.value=value===null?'null':'value';mode.onchange();input.value=value??'';}pane.remove();};
  }
  pane.querySelector('[data-find]').onclick=safe(()=>{page=0;return load();});pane.querySelector('[data-prev]').onclick=safe(()=>{page--;return load();});pane.querySelector('[data-next]').onclick=safe(()=>{page++;return load();});pane.querySelector('[data-close]').onclick=()=>pane.remove();await load();
}
