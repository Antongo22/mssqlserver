importCSV=()=>{
  const table=state.table,database=state.database,connection=state.connection,columns=state.columns.filter(c=>c.writable);
  const MAX_ROWS=10000,CHUNK=500;
  let sheets=[],rows=[],records=[],revision=0,validated=false;
  modal('Импорт CSV / Excel',`<p class="modal-copy">${esc(table.schema+'.'+table.name)} · до ${MAX_ROWS.toLocaleString('ru-RU')} строк. Файлы больше 500 строк импортируются чанками по ${CHUNK}; каждый чанк — отдельная транзакция.</p><label class="field">Файл<input id="import-file" type="file" accept=".csv,.xlsx" required></label>${selectField('delimiter','Разделитель CSV',[{value:';',label:'Точка с запятой'},{value:',',label:'Запятая'},{value:'\t',label:'Табуляция'}])}${field('nullValue','Маркер NULL','\\N')}<label class="field">Лист Excel<select id="import-sheet"><option>CSV</option></select></label><div id="import-mapping"></div><div id="import-sample" class="data-scroll"></div><button type="button" class="button" id="import-validate" disabled>Проверить значения</button><p id="import-validation" role="status"></p><p class="muted">Типы берутся из целевой таблицы. Формулы XLSX не вычисляются: используется сохранённый результат. Excel уже округляет числа длиннее 15 цифр — для точных BIGINT/DECIMAL используйте текстовые ячейки или CSV. Проверка FK, UNIQUE, CHECK и триггеров выполняется при вставке.</p>`,async()=>{
    if(!validated)throw new Error('Сначала выполните проверку значений.');
    const status=$('import-validation');
    status.textContent=`Импорт 0 / ${records.length}…`;
    const inserted=await importRecordChunks({database,connection,schema:table.schema,name:table.name,records,onProgress:(done,total)=>{$('import-validation').textContent=`Импорт ${done.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}…`;}});
    await loadRows();notice(`Импортировано ${inserted.toLocaleString('ru-RU')} строк${inserted>CHUNK?` (${Math.ceil(inserted/CHUNK)} транзакций)`:''}.`);
  },'Импортировать',false,true);
  const session=crypto.randomUUID();$('modal-body').dataset.importSession=session;
  const isCurrent=()=>$('modal').open&&$('modal-body').dataset.importSession===session;
  $('modal-submit').disabled=true;
  const invalidate=()=>{revision++;validated=false;$('modal-submit').disabled=true;$('import-validation').textContent='Данные ещё не проверены.';};
  function mapping(){
    invalidate();const [headers,...data]=rows;
    if(!headers?.length||!data.length||data.length>MAX_ROWS||headers.length>100)throw new Error(`Нужны заголовки и 1–${MAX_ROWS.toLocaleString('ru-RU')} строк данных, до 100 столбцов.`);
    if(data.some(r=>r.length!==headers.length))throw new Error('Количество ячеек не совпадает с заголовками.');
    $('import-mapping').innerHTML=`<h3>Сопоставление столбцов</h3>${headers.map((h,i)=>`<label class="mapping-row"><span>${esc(h||'Столбец '+(i+1))}</span><select data-import-column="${i}"><option value="">Пропустить</option>${columns.map(c=>`<option value="${esc(c.name)}" ${c.name.toLowerCase()===h.toLowerCase()?'selected':''}>${esc(c.name+' · '+c.sqlType+(c.nullable?' · NULL':''))}</option>`).join('')}</select></label>`).join('')}`;
    $('import-sample').innerHTML=`<p class="muted">${data.length.toLocaleString('ru-RU')} строк · показаны первые 20</p>`+grid(headers,data.slice(0,20));$('import-validate').disabled=false;
    $('import-mapping').onchange=invalidate;
  }
  async function read(){
    invalidate();$('import-validate').disabled=true;$('import-mapping').replaceChildren();$('import-sample').replaceChildren();
    const file=$('import-file').files[0],version=revision;if(!file)return;
    if(file.size>15*1024*1024)throw new Error('Файл больше 15 МБ.');
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
    $('import-validation').textContent=`Проверяем типы, длину и NULL… 0 / ${records.length}`;
    const r=await validateImportChunks({database,connection,schema:table.schema,name:table.name,records,onProgress:(done,total)=>{$('import-validation').textContent=`Проверяем… ${done.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')}`;}});
    if(version!==revision||!isCurrent())return;validated=r.valid;$('modal-submit').disabled=!validated;
    $('import-validation').textContent=r.valid?`${r.rows.toLocaleString('ru-RU')} строк готовы к импорту${r.rows>CHUNK?` · ${Math.ceil(r.rows/CHUNK)} транзакций`:''}.`:r.errors.map(e=>`Строка ${e.row}, ${e.column}: ${e.error}`).join('\n');
  });
};
