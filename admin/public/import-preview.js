importCSV=()=>{
  const table=state.table,database=state.database,connection=state.connection,columns=state.columns.filter(c=>c.writable);
  let sheets=[],rows=[],records=[],revision=0,validated=false;
  modal('Импорт CSV / Excel',`<p class="modal-copy">${esc(table.schema+'.'+table.name)} · до 500 строк. Сопоставьте столбцы и проверьте данные перед импортом.</p><label class="field">Файл<input id="import-file" type="file" accept=".csv,.xlsx" required></label>${selectField('delimiter','Разделитель CSV',[{value:';',label:'Точка с запятой'},{value:',',label:'Запятая'},{value:'\t',label:'Табуляция'}])}${field('nullValue','Маркер NULL','\\N')}<label class="field">Лист Excel<select id="import-sheet"><option>CSV</option></select></label><div id="import-mapping"></div><div id="import-sample" class="data-scroll"></div><button type="button" class="button" id="import-validate" disabled>Проверить значения</button><p id="import-validation" role="status"></p><p class="muted">Типы берутся из целевой таблицы. Формулы XLSX не вычисляются: используется сохранённый результат. Excel уже округляет числа длиннее 15 цифр — для точных BIGINT/DECIMAL используйте текстовые ячейки или CSV. Проверка FK, UNIQUE, CHECK и триггеров выполняется при вставке; весь импорт — одна транзакция.</p>`,async()=>{
    if(!validated)throw new Error('Сначала выполните проверку значений.');
    await api(`/api/databases/${encodeURIComponent(database)}/data/import`,{method:'POST',headers:{'X-Studio-Connection':connection},body:{schema:table.schema,name:table.name,records}});await loadRows();notice(`Импортировано ${records.length} строк.`);
  },'Импортировать',false,true);
  const session=crypto.randomUUID();$('modal-body').dataset.importSession=session;
  const isCurrent=()=>$('modal').open&&$('modal-body').dataset.importSession===session;
  $('modal-submit').disabled=true;
  const invalidate=()=>{revision++;validated=false;$('modal-submit').disabled=true;$('import-validation').textContent='Данные ещё не проверены.';};
  function mapping(){
    invalidate();const [headers,...data]=rows;
    if(!headers?.length||!data.length||data.length>500||headers.length>100)throw new Error('Нужны заголовки и 1–500 строк данных, до 100 столбцов.');
    if(data.some(r=>r.length!==headers.length))throw new Error('Количество ячеек не совпадает с заголовками.');
    $('import-mapping').innerHTML=`<h3>Сопоставление столбцов</h3>${headers.map((h,i)=>`<label class="mapping-row"><span>${esc(h||'Столбец '+(i+1))}</span><select data-import-column="${i}"><option value="">Пропустить</option>${columns.map(c=>`<option value="${esc(c.name)}" ${c.name.toLowerCase()===h.toLowerCase()?'selected':''}>${esc(c.name+' · '+c.sqlType+(c.nullable?' · NULL':''))}</option>`).join('')}</select></label>`).join('')}`;
    $('import-sample').innerHTML=grid(headers,data.slice(0,20));$('import-validate').disabled=false;
    $('import-mapping').onchange=invalidate;
  }
  async function read(){
    invalidate();$('import-validate').disabled=true;$('import-mapping').replaceChildren();$('import-sample').replaceChildren();
    const file=$('import-file').files[0],version=revision;if(!file)return;
    if(file.size>5*1024*1024)throw new Error('Файл больше 5 МБ.');
    if(/\.xlsx$/i.test(file.name)){
      const response=await fetch('/api/import-file',{method:'POST',headers:{'X-Admin-Request':'1','X-Studio-Connection':connection,'Content-Type':'application/octet-stream'},body:file});const r=await response.json();if(!response.ok)throw new Error(r.error);if(version!==revision||!isCurrent())return;sheets=r.sheets;
      $('import-sheet').innerHTML=sheets.map((s,i)=>`<option value="${i}">${esc(s.name)}</option>`).join('');rows=sheets[0]?.rows||[];
    }else{const text=await file.text();if(version!==revision||!isCurrent())return;rows=parseCSV(text,$('modal-form').elements.delimiter.value);$('import-sheet').innerHTML='<option>CSV</option>';sheets=[];}
    mapping();
  }
  const showError=fn=>async()=>{try{await fn();}catch(e){if(isCurrent()&&$('import-validation'))$('import-validation').textContent=e.message;}};
  $('import-file').onchange=showError(read);$('modal-form').elements.delimiter.onchange=showError(read);$('modal-form').elements.nullValue.oninput=invalidate;
  $('import-sheet').onchange=showError(()=>{rows=sheets[Number($('import-sheet').value)]?.rows||[];mapping();});
  $('import-validate').onclick=showError(async()=>{
    invalidate();const version=revision,marker=$('modal-form').elements.nullValue.value;
    const mapping=[...$('import-mapping').querySelectorAll('select')].map((s,i)=>({name:s.value,index:i})).filter(x=>x.name);
    if(!mapping.length||new Set(mapping.map(x=>x.name)).size!==mapping.length)throw new Error('Выберите разные целевые столбцы.');
    records=rows.slice(1).map(row=>Object.fromEntries(mapping.map(m=>[m.name,row[m.index]===marker?null:row[m.index]])));
    $('import-validation').textContent='Проверяем типы, длину и NULL…';
    const r=await api(`/api/databases/${encodeURIComponent(database)}/data/import/preview`,{method:'POST',headers:{'X-Studio-Connection':connection},body:{schema:table.schema,name:table.name,records}});
    if(version!==revision||!isCurrent())return;validated=r.valid;$('modal-submit').disabled=!validated;
    $('import-validation').textContent=r.valid?`${r.rows} строк готовы к импорту.`:r.errors.map(e=>`Строка ${e.row}, ${e.column}: ${e.error}`).join('\n');
  });
};
