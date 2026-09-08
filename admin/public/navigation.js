const navigationKey=()=>`studio.navigation.${state.connection}.${state.database}`;
const navigationState=()=>storage.read(navigationKey(),{pinned:[],recent:[]});
function rememberObject(object){const n=navigationState();n.recent=[object,...n.recent.filter(x=>x.schema!==object.schema||x.name!==object.name||x.type!==object.type)].slice(0,15);storage.write(navigationKey(),n);renderNavigation();}
const quickButton=document.createElement('button');quickButton.id='quick-search';quickButton.className='button';quickButton.textContent='Поиск · ⌘ / Ctrl K';document.querySelector('.topbar-actions').prepend(quickButton);
const navigationBox=document.createElement('div');navigationBox.className='navigation-box';$('tables-list').before(navigationBox);
function renderNavigation(){
  const n=navigationState();navigationBox.innerHTML=`<div class="navigation-group"><span>Закреплённые</span>${n.pinned.map((x,i)=>`<button class="chip" data-pinned="${i}">★ ${esc(x.schema+'.'+x.name)}</button>`).join('')||'<small>Закрепляйте таблицы кнопкой ☆.</small>'}</div><div class="navigation-group"><span>Недавние</span>${n.recent.slice(0,7).map((x,i)=>`<button class="chip" data-recent="${i}">${esc(x.schema+'.'+x.name)}</button>`).join('')}</div>`;
  navigationBox.onclick=safe(e=>{const p=e.target.closest('[data-pinned]'),r=e.target.closest('[data-recent]');if(p)return navigateObject(n.pinned[Number(p.dataset.pinned)]);if(r)return navigateObject(n.recent[Number(r.dataset.recent)]);});
  const pin=$('pin-table');if(pin&&state.table)pin.textContent=n.pinned.some(t=>t.schema===state.table.schema&&t.name===state.table.name)?'★ Открепить':'☆ Закрепить';
}
const pinButton=document.createElement('button');pinButton.id='pin-table';pinButton.className='button';pinButton.textContent='☆ Закрепить';$('table-detail').querySelector('.actions').prepend(pinButton);
pinButton.onclick=()=>{if(!state.table)return;const n=navigationState(),t={schema:state.table.schema,name:state.table.name,type:'U'},found=n.pinned.some(x=>x.schema===t.schema&&x.name===t.name);n.pinned=found?n.pinned.filter(x=>x.schema!==t.schema||x.name!==t.name):[...n.pinned,t].slice(-50);storage.write(navigationKey(),n);renderNavigation();};
async function navigateObject(object){
  requireCleanGrid();if(object.type==='U'){
    const table=state.tables.find(t=>t.schema===object.schema&&t.name===object.name);if(!table)throw new Error('Таблица больше не существует. Обновите список баз.');
    tab('tables');await openTable(table);if(object.column)await showStructure();
  }else{
    const objects=await api(`${dbPath()}/objects`),o=objects.objects.find(o=>o.schema===object.schema&&o.name===object.name);if(!o)throw new Error('Объект не найден.');
    const definition=await api(`${dbPath()}/definition/${o.id}`);if(!definition.definition)throw new Error('Определение недоступно.');stageSQL(definition.definition,object.name);rememberObject(object);
  }
}
quickButton.onclick=()=>{
  if(!state.database)return;if($('modal').open||window.studioHasDrafts()){notice('Закройте форму и сохраните изменения ячеек перед поиском.',true);return;}
  const database=state.database,connection=state.connection;let version=0,timer;
  modal('Поиск по базе',`<label class="field">${esc(database)}<input id="object-finder" type="search" placeholder="Таблица, столбец или текст SQL…" autocomplete="off"></label><p class="muted">Поиск по именам объектов, столбцам и определениям SQL. Данные строк не сканируются.</p><div id="finder-results"></div>`,async()=>{},'Закрыть',false,true);
  $('object-finder').oninput=()=>{clearTimeout(timer);const current=++version,q=$('object-finder').value.trim(),holder=$('finder-results');if(q.length<2){holder.textContent='Введите хотя бы 2 символа.';return;}holder.textContent='Поиск…';timer=setTimeout(async()=>{try{
    const r=await api(`/api/databases/${encodeURIComponent(database)}/search?q=${encodeURIComponent(q)}`,{headers:{'X-Studio-Connection':connection}});if(current!==version||!holder.isConnected)return;
    holder.innerHTML=r.results.map((o,i)=>`<button type="button" class="history-item" data-found="${i}"><strong>${esc(o.schema+'.'+o.name)}${o.column?' · '+esc(o.column):''}</strong><small>${o.hit==='DEFINITION'?'В SQL-определении':o.hit==='COLUMN'?'Столбец':'Объект'}</small>${o.snippet?'<code>'+esc(o.snippet)+'</code>':''}</button>`).join('')||'Ничего не найдено.';
    if(r.truncated)holder.append(document.createTextNode('Показаны первые 200 совпадений. Уточните поиск.'));
    holder.onclick=safe(async e=>{const b=e.target.closest('[data-found]');if(!b)return;$('modal').close();await navigateObject(r.results[Number(b.dataset.found)]);});
  }catch(e){if(holder.isConnected)holder.textContent=e.message;}},250);};
  $('object-finder').focus();
};
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();quickButton.click();}});
document.addEventListener('table-opened',()=>{if(state.table)rememberObject({schema:state.table.schema,name:state.table.name,type:'U'});saveWorkspace();});
document.addEventListener('database-changed',()=>{renderNavigation();saveWorkspace();initialWorkspace=false;});
let restoringWorkspace=false,initialWorkspace=true;
function saveWorkspace(){if(!restoringWorkspace&&!initialWorkspace&&state.database)storage.write('studio.workspace.v1',{connection:state.connection,database:state.database,table:state.table?{schema:state.table.schema,name:state.table.name}:null});}
// Restoration is explicit: opening the panel never silently reconnects to production.
const restoreButton=document.createElement('button');restoreButton.className='button';restoreButton.textContent='Вернуть рабочее место';restoreButton.id='restore-workspace';connectionTools.append(restoreButton);
restoreButton.onclick=safe(async()=>{const saved=storage.read('studio.workspace.v1',null);if(!saved)throw new Error('Нет сохранённого рабочего места.');requireCleanGrid();restoringWorkspace=true;try{if(state.connection!==saved.connection)await switchConnection(saved.connection);await loadDatabases(saved.database);if(saved.table){const t=state.tables.find(t=>t.schema===saved.table.schema&&t.name===saved.table.name);if(t){tab('tables');await openTable(t);}}}finally{restoringWorkspace=false;}});
renderNavigation();
document.addEventListener('object-opened',e=>rememberObject({schema:e.detail.schema,name:e.detail.name,type:e.detail.type}));
$('modal-body').addEventListener('click',e=>{
  const b=e.target.closest('[data-edit-connection]');if(!b)return;
  const c=connectionProfiles.find(c=>c.id===b.dataset.editConnection);$('modal').close();
  modal('Изменить подключение',field('name','Название',c.name)+selectField('environment','Окружение',[{value:'development',label:'Разработка'},{value:'test',label:'Тестирование'},{value:'production',label:'Рабочий сервер'}],c.environment)+(c.id==='local'?'<p class="muted">Адрес и учётные данные встроенного сервера задаются в Compose.</p>':field('server','Адрес',c.server)+field('port','Порт',String(c.port),'number')+field('user','Логин',c.user)+field('password','Новый пароль (пусто — сохранить текущий)','','password')+field('backupPath','Общий каталог бекапов',c.backupPath||'')+`<label class="check-inline"><input type="checkbox" name="trust" ${c.trustServerCertificate?'checked':''}> Доверять сертификату</label>`),async form=>{
    const v=formValues(form);await api('/api/connections/'+c.id,{method:'PATCH',body:{...v,...(c.id==='local'?{}:{port:Number(v.port),trustServerCertificate:v.trust==='on'})}});await refreshConnections();notice('Подключение обновлено. Настройки используются новыми запросами.');
  },'Сохранить',false,true);
});
