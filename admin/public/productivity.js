// Workspaces extend the same database selection, dialogs and API as the rest of Studio.
let connectionProfiles = [];
const connectionTools=document.createElement('div');connectionTools.className='connection-tools';
connectionTools.innerHTML='<label class="sr-only" for="connection-select">Сервер</label><select id="connection-select"><option value="local">Docker · локальный</option></select><button class="button" id="manage-connections">Подключения</button>';
document.querySelector('.connection').before(connectionTools);
const environments={development:'DEV',test:'TEST',production:'PRODUCTION'};
function connectionBadge(){
  const c=connectionProfiles.find(c=>c.id===state.connection);if(!c)return;
  $('connection-select').value=c.id;document.querySelector('.local-tag').textContent=environments[c.environment];
  document.querySelector('.connection').dataset.environment=c.environment;
  document.querySelector('.connection > div').firstChild.textContent=c.name;
  document.querySelector('.user-badge').innerHTML=`${esc(c.user)} <span>${esc(environments[c.environment])}</span>`;
  $('footer-status').textContent=`${c.name} · ${c.server}:${c.port}`;
  document.querySelector('.query-warning').textContent=`SQL выполняется на «${c.name}» от имени ${c.user}. Изменения применяются сразу. Для UPDATE и DELETE проверяйте WHERE.`;
}
async function refreshConnections(){connectionProfiles=await api('/api/connections');$('connection-select').innerHTML=connectionProfiles.map(c=>`<option value="${c.id}">${esc(c.name)} · ${environments[c.environment]}</option>`).join('');connectionBadge();}
async function switchConnection(id){
  if(state.busy||$('modal').open){$('connection-select').value=state.connection;throw new Error('Завершите текущий запрос или закройте форму перед сменой сервера.');}
  state.connection=id;state.database=null;state.table=null;state.tables=[];state.queryParameters=undefined;state.generation++;
  window.sqlEditor?.setSchema({});$('tables-list').replaceChildren();$('table-detail').hidden=true;$('database-title').textContent='Подключение…';$('database-meta').textContent='';
  for(const id of ['new-table','run-query','delete-database'])$(id).disabled=true;
  document.dispatchEvent(new CustomEvent('database-changing'));connectionBadge();
  await loadDatabases();document.dispatchEvent(new CustomEvent('connection-changed'));
}
$('connection-select').onchange=safe(e=>switchConnection(e.target.value));
$('manage-connections').onclick=()=>{
  modal('Подключения к серверам',`<div id="connection-list">${connectionProfiles.map(c=>`<div class="object-row"><div><strong>${esc(c.name)}</strong><small>${esc(c.user+' @ '+c.server+':'+c.port)} · ${environments[c.environment]}</small></div>${c.id!=='local'?`<button type="button" class="button danger" data-remove-connection="${c.id}">Удалить</button>`:''}</div>`).join('')}</div><hr><h3>Новое подключение</h3>${field('name','Название')}${field('server','Адрес сервера','host.docker.internal')}${field('port','Порт','1433','number')}${field('user','SQL-логин','sa')}${field('password','Пароль','','password')}${selectField('environment','Окружение',[{value:'development',label:'Разработка'},{value:'test',label:'Тестирование'},{value:'production',label:'Рабочий сервер'}],'development')}<label class="check-inline"><input type="checkbox" name="trust"> Доверять сертификату сервера</label>${field('backupPath','Общий каталог бекапов на SQL Server (необязательно)','','text','Для внешнего сервера смонтируйте этот же каталог в /backups/<ID подключения> контейнера admin. Иначе локальное скачивание недоступно.')}<button class="button" type="button" id="test-connection">Проверить соединение</button><p id="test-connection-result" role="status"></p>`,async form=>{
    const v=formValues(form);await api('/api/connections',{method:'POST',body:{...v,port:Number(v.port),trustServerCertificate:v.trust==='on'}});await refreshConnections();notice('Подключение сохранено. Выберите его в списке серверов.');
  },'Сохранить',false,true);
  $('test-connection').onclick=safe(async()=>{const b=$('test-connection');b.disabled=true;try{const v=formValues($('modal-form'));const r=await api('/api/connections/test',{method:'POST',body:{...v,port:Number(v.port),trustServerCertificate:v.trust==='on'}});$('test-connection-result').textContent='Подключено: '+r.name;}catch(e){$('test-connection-result').textContent=e.message;}finally{b.disabled=false;}});
  $('connection-list').onclick=safe(async e=>{const id=e.target.closest('[data-remove-connection]')?.dataset.removeConnection;if(!id)return;const c=connectionProfiles.find(c=>c.id===id);$('modal').close();confirmAction('Удалить подключение',c.name,async confirm=>{await api('/api/connections/'+id,{method:'DELETE',body:{confirm}});if(state.connection===id){state.connection='local';state.database=null;await loadDatabases();}await refreshConnections();},'Удаляется сохранённое подключение. Базы на сервере сохраняются.');});
};
document.addEventListener('database-changed',connectionBadge);
refreshConnections().catch(e=>notice(e.message,true));

let completionRevision=0;
async function refreshCompletion(){
  const generation=state.generation,version=++completionRevision;
  if(!state.database)return;
  try{const [schema,model]=await Promise.all([api(`${dbPath()}/completion`),api(`${dbPath()}/diagram`)]);if(generation===state.generation&&version===completionRevision){window.sqlEditor?.setSchema(schema);window.sqlEditor?.setRelations(model);}}
  catch{ /* Database may have been removed by the query. */ }
}
document.addEventListener('database-changing',()=>{completionRevision++;window.sqlEditor?.setSchema({});window.sqlEditor?.setRelations(null);});
document.addEventListener('completion-refresh',refreshCompletion);
document.addEventListener('query-completed',refreshCompletion);

// Preview is part of the existing form: first submit shows SQL/dependencies, next applies.
const realApi=api;
api=async(path,options={})=>{
  if(options.method==='POST'&&/\/structure$/.test(path)&&options.body&&!options.body.preview){
    const body=options.body,signature=JSON.stringify({path,body,connection:state.connection}),form=$('modal-form');
    if(form.dataset.structurePreview!==signature){
      const result=await realApi(path,{...options,body:{...body,preview:true}});
      if(!$('modal').open){
        modal('Предпросмотр изменения',previewHTML(result),async()=>{await realApi(path,options);await loadRows();await showStructure();notice('Структура обновлена.');},'Применить',result.destructive,true);return {preview:true};
      }
      $('structure-preview')?.remove();const section=document.createElement('section');section.id='structure-preview';section.innerHTML=previewHTML(result);$('modal-body').append(section);form.dataset.structurePreview=signature;$('modal-submit').textContent='Применить изменения';
      throw Object.assign(new Error('SQL подготовлен. Проверьте его ниже.'), {preview:true});
    }
    delete form.dataset.structurePreview;
  }
  return realApi(path,options);
};
function previewHTML(r){return `<h3>SQL изменения</h3><pre class="sql-preview">${esc(r.sql)}</pre><h3>Зависимые объекты</h3>${r.dependencies.length?grid(['Схема','Объект','Вид'],r.dependencies.map(d=>[d.schema,d.name,d.kind])):'<p class="muted">Зависимости в системном каталоге не найдены.</p>'}<p class="muted">Список относится ко всей таблице. Динамический SQL и внешние приложения могут не отражаться в каталоге.${r.destructive?' Операция может удалить данные или изменить их тип.':''}</p>`;}
$('modal').addEventListener('close',()=>{delete $('modal-form').dataset.structurePreview;});

function addWorkspace(id,label){const b=document.createElement('button');b.id=id+'-tab';b.className='tab';b.setAttribute('role','tab');b.setAttribute('aria-selected','false');b.setAttribute('aria-controls',id+'-panel');b.textContent=label;document.querySelector('.tabs').append(b);const p=document.createElement('section');p.id=id+'-panel';p.hidden=true;p.setAttribute('role','tabpanel');p.setAttribute('aria-labelledby',b.id);document.querySelector('.workspace').append(p);b.onclick=()=>tab(id);return p;}
const comparePanel=addWorkspace('compare','Сравнение схем');
async function initCompare(){
  const choices=connectionProfiles.map(c=>({value:c.id,label:c.name}));
  comparePanel.innerHTML=`<div class="section-toolbar"><div><h2>Сравнение схем</h2><p class="muted">Перенести структуру источника в приёмник · данные не копируются</p></div></div><form id="compare-form" class="panel tools-form"><div class="tools-columns">${['source','target'].map((side,i)=>`<div><h3>${i?'Приёмник':'Источник'}</h3>${selectField(side+'Connection','Сервер',choices,state.connection)}${selectField(side+'Database','База',[],state.database)}</div>`).join('')}</div><button class="button primary">Сравнить</button></form><div id="compare-result"></div>`;
  const form=$('compare-form');
  async function databases(side){const id=form.elements[side+'Connection'].value;const r=await api('/api/databases',{headers:{'X-Studio-Connection':id}});if(!form.isConnected||form.elements[side+'Connection'].value!==id)return;const list=r.databases.filter(d=>d.state==='ONLINE');form.elements[side+'Database'].innerHTML=list.map(d=>`<option ${d.name===state.database?'selected':''}>${esc(d.name)}</option>`).join('');}
  for(const side of ['source','target'])form.elements[side+'Connection'].onchange=safe(()=>databases(side));
  await Promise.all(['source','target'].map(databases));
  form.onsubmit=safe(async e=>{e.preventDefault();const b=form.querySelector('button');b.disabled=true;try{const values=formValues(form);const r=await api('/api/schema-compare',{method:'POST',body:values});if(!form.isConnected)return;
    $('compare-result').innerHTML=`<h3>${r.changes.length} различий</h3>${r.warnings.map(w=>`<p class="query-warning">${esc(w)}</p>`).join('')}<div class="panel">${r.changes.map(c=>`<details class="diff-item"><summary>${esc(c.kind)} · ${esc(c.object)}</summary><div class="tools-columns"><pre class="sql-preview">${esc(c.before||'Отсутствует в приёмнике')}</pre><pre class="sql-preview">${esc(c.after||'Отсутствует в источнике')}</pre></div></details>`).join('')||'<p>Сравниваемые объекты совпадают.</p>'}</div><h3>SQL переноса</h3><p class="muted">Объекты только в приёмнике сохраняются. Предупреждения требуют ручной доработки скрипта.</p><pre class="sql-preview">${esc(r.sql)}</pre><button class="button primary" id="compare-stage">Открыть SQL в приёмнике</button> <button class="button" id="compare-download">↓ .sql</button>`;
    $('compare-download').onclick=()=>download(r.sql,'schema-migration.sql');$('compare-stage').onclick=safe(async()=>{if(state.connection!==values.targetConnection)await switchConnection(values.targetConnection);await loadDatabases(values.targetDatabase);stageSQL(r.sql,'Миграция схемы');});
  }finally{b.disabled=false;}});
}
document.addEventListener('workspace-tab-changed',safe(async e=>{if(e.detail==='compare')await initCompare();}));

// Scheduled copies continue on the backend while this page is closed.
const schedulePanel=addWorkspace('schedules','Расписание копий');
async function loadSchedules(){
  const generation=state.generation,connection=state.connection,r=await api('/api/backup-schedules');if(connection!==state.connection||generation!==state.generation)return;
  schedulePanel.innerHTML=`<div class="section-toolbar"><div><h2>Бекапы по расписанию</h2><p class="muted">COPY_ONLY + CHECKSUM + VERIFYONLY · при закрытом браузере</p></div><div class="actions"><button class="button primary" id="schedule-new">＋ Расписание</button><button class="button" id="schedule-refresh">↻ Обновить</button></div></div><div class="panel">${r.schedules.map(s=>`<div class="object-row"><div><strong>${esc(s.database)}</strong><small>Каждые ${s.minutes} мин · хранить ${s.retentionDays} дней · ${s.restoreCheck?'проверка восстановлением':'VERIFYONLY'}<br>${s.running?'Выполняется':s.enabled?'Следующий запуск: '+new Date(s.nextRun).toLocaleString('ru-RU'):'Приостановлено'}</small></div><div class="actions"><button class="button" data-schedule="${s.id}" data-op="run" ${s.running?'disabled':''}>Запустить</button><button class="button" data-schedule="${s.id}" data-op="${s.enabled?'disable':'enable'}">${s.enabled?'Пауза':'Включить'}</button><button class="button danger" data-schedule="${s.id}" data-op="delete">Удалить</button></div></div>`).join('')||blank('Расписаний пока нет.')}</div><h3>История запусков</h3><div class="panel data-scroll">${grid(['База','Начало','Результат','Файл / ошибка'],r.history.map(h=>[h.database,new Date(h.started).toLocaleString('ru-RU'),h.success?(h.restoreCheck?'Восстановление проверено':'VERIFYONLY успешно'):'Ошибка',h.error||h.file]))}</div>`;
  $('schedule-refresh').onclick=safe(loadSchedules);
  $('schedule-new').onclick=()=>modal('Новое расписание',selectField('database','База',state.databases.filter(d=>d.id>4&&d.state==='ONLINE').map(d=>d.name),state.database)+field('minutes','Интервал, минуты','1440','number')+field('retentionDays','Хранить, дней','7','number')+'<label class="check-inline"><input name="restoreCheck" type="checkbox" checked> Проверять восстановлением во временную базу и DBCC CHECKDB</label><p class="muted">Временная база удаляется после проверки. Последняя успешная копия сохраняется; срок хранения применяется только к файлам этого расписания.</p>',async form=>{const v=formValues(form);await api('/api/backup-schedules',{method:'POST',body:{...v,minutes:Number(v.minutes),retentionDays:Number(v.retentionDays),restoreCheck:v.restoreCheck==='on'}});await loadSchedules();},'Создать');
  schedulePanel.onclick=safe(async e=>{const b=e.target.closest('[data-schedule]');if(!b)return;const s=r.schedules.find(s=>s.id===b.dataset.schedule),action=b.dataset.op;const apply=async confirm=>{b.disabled=true;try{await api('/api/backup-schedules/'+s.id,{method:'POST',body:{action,confirm}});await loadSchedules();}finally{b.disabled=false;}};if(action==='delete')confirmAction('Удалить расписание',s.database,apply,'Файлы резервных копий сохраняются.');else await apply();});
}
document.addEventListener('workspace-tab-changed',safe(async e=>{if(e.detail==='schedules')await loadSchedules();}));
document.addEventListener('database-changed',safe(async()=>{if(!schedulePanel.hidden)await loadSchedules();if(!comparePanel.hidden)await initCompare();}));

// Favorites persist SQL and parameter definitions, never entered values.
const favoriteButtons=document.createElement('div');favoriteButtons.className='query-options';favoriteButtons.innerHTML='<button class="button" id="favorite-save">☆ Сохранить запрос</button><button class="button" id="favorite-list">★ Избранное</button><span id="parameter-status" class="muted"></span>';document.querySelector('.editor').before(favoriteButtons);
const parameterTypes=['NVARCHAR(MAX)','INT','BIGINT','DECIMAL(38,10)','BIT','DATE','DATETIME2','UNIQUEIDENTIFIER'];
const favorites=()=>storage.read('studio.favorites.v1',[]);
$('favorite-save').onclick=()=>{
  const text=window.sqlEditor?.getValue()||$('sql-editor').value;
  modal('Сохранить запрос',field('name','Название')+'<p class="muted">Параметры укажите явно: @CustomerId, @DateFrom. Для каждого выберите SQL-тип. Значения при выполнении не сохраняются.</p><div id="favorite-parameters"></div><button class="button" type="button" id="favorite-add-param">＋ Параметр</button>',async form=>{
    const params=[...$('favorite-parameters').children].map(r=>({name:r.querySelector('input').value.replace(/^@/,''),type:r.querySelector('select').value}));if(params.some(p=>!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(p.name))||new Set(params.map(p=>p.name.toLowerCase())).size!==params.length)throw new Error('Укажите разные корректные имена параметров.');
    const name=formValues(form).name.trim();if(!name)throw new Error('Введите название.');const list=favorites();if(list.length>=100)throw new Error('Удалите ненужные запросы: максимум 100.');list.push({id:crypto.randomUUID(),name,sql:text,parameters:params});storage.write('studio.favorites.v1',list);notice('Запрос сохранён в избранное.');
  },'Сохранить');
  $('favorite-add-param').onclick=()=>{if($('favorite-parameters').children.length>=30)return;const r=document.createElement('div');r.className='parameter-row';r.innerHTML=`<input placeholder="Имя параметра" aria-label="Имя параметра"><select aria-label="Тип параметра">${parameterTypes.map(t=>`<option>${t}</option>`).join('')}</select><button type="button" class="icon-button" aria-label="Удалить параметр">×</button>`;r.querySelector('button').onclick=()=>r.remove();$('favorite-parameters').append(r);};
};
$('favorite-list').onclick=()=>{
  const list=favorites();modal('Избранные запросы',`<div id="favorites-list">${list.map(f=>`<div class="object-row"><button type="button" class="history-item" data-favorite="${f.id}"><strong>${esc(f.name)}</strong><code>${esc(f.sql.slice(0,180))}</code></button><button class="button danger" type="button" data-delete-favorite="${f.id}">Удалить</button></div>`).join('')||'Избранное пока пусто.'}</div>`,async()=>{},'Закрыть',false,true);
  $('favorites-list').onclick=e=>{const remove=e.target.closest('[data-delete-favorite]'),b=e.target.closest('[data-favorite]');if(remove){storage.write('studio.favorites.v1',favorites().filter(f=>f.id!==remove.dataset.deleteFavorite));remove.closest('.object-row').remove();return;}if(!b)return;const f=list.find(f=>f.id===b.dataset.favorite);$('modal').close();openFavorite(f);};
};
function openFavorite(f){
  if(!f.parameters.length){stageSQL(f.sql,f.name);state.queryParameters=undefined;return;}
  modal('Параметры: '+f.name,`<p class="muted">Сервер: ${esc(connectionProfiles.find(c=>c.id===state.connection)?.name||state.connection)} · база ${esc(state.database)}</p>${f.parameters.map((p,i)=>field('p'+i,'@'+p.name+' · '+p.type)+`<label class="check-inline"><input type="checkbox" name="null${i}"> NULL</label>`).join('')}`,async form=>{
    const values=formValues(form);stageSQL(f.sql,f.name);state.queryParameters=f.parameters.map((p,i)=>({...p,value:values['null'+i]==='on'?null:values['p'+i]}));$('parameter-status').textContent=`Параметры: ${state.queryParameters.map(p=>'@'+p.name).join(', ')} · значения заданы`;notice('Запрос и параметры готовы. Нажмите «Выполнить».');
  },'Открыть в редакторе',false,true);
}
$('sql-editor').addEventListener('input',()=>{state.queryParameters=undefined;$('parameter-status').textContent='';});
document.addEventListener('database-changing',()=>{state.queryParameters=undefined;$('parameter-status').textContent='';});
