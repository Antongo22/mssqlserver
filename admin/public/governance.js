window.blockingTreeHTML=rows=>`<section class="panel blocking-section"><h3>Дерево блокировок</h3><p class="muted">Сверху — блокирующая сессия, ниже — ожидающие её. Для спящих сессий показан последний запрос.</p>${rows?.length?rows.map(s=>`<div class="blocking-node" style="margin-left:${Math.min(s.depth,20)*18}px"><details><summary><strong>${s.depth?'↳ ':''}Сессия ${s.id}</strong> · ${esc(s.login||s.status)} · ${esc(s.database||'—')}${s.blockedBy?' · ждёт '+s.blockedBy:''}${s.wait?' · '+esc(s.wait)+' · '+(s.waitMs||0)+' мс':''}${s.cycle?' · цикл в снимке':''}</summary><p>${esc(s.program||'')} · открытых транзакций: ${s.openTransactions??'—'}</p><pre class="sql-preview">${esc(s.sqlText||'SQL недоступен')}</pre></details></div>`).join(''):'<p>Заблокированных сессий нет.</p>'}</section>`;

// A separate dialog preserves the underlying form and its SQL preview.
window.confirmProduction=(confirmation,path,options)=>new Promise((resolve,reject)=>{
  const dialog=document.createElement('dialog');dialog.className='production-dialog';
  let body;try{body=JSON.parse(options.body||'{}');}catch{body={};}
  const redact=(key,value)=>/password|secret/i.test(key)?'[скрыто]':value;
  dialog.innerHTML=`<form method="dialog"><h2>Операция на PRODUCTION</h2><p><strong>${esc(confirmation.name)}</strong> · ${esc(confirmation.server)}:${confirmation.port}<br>База: ${esc(confirmation.database)}</p><p class="muted">${esc(options.method||'GET')} ${esc(path)}</p><pre class="sql-preview">${esc(body.sql||JSON.stringify(body,redact,2))}</pre><label class="field">Введите название подключения: ${esc(confirmation.name)}<input name="confirmation" autocomplete="off" required></label><div class="actions"><button type="button" class="button" id="production-cancel">Отмена</button><button class="button danger" type="submit" disabled>Подтвердить и выполнить</button></div></form>`;
  document.body.append(dialog);const input=dialog.querySelector('input'),submit=dialog.querySelector('[type=submit]');let accepted=false;
  input.oninput=()=>{submit.disabled=input.value!==confirmation.name;};
  dialog.querySelector('form').onsubmit=e=>{e.preventDefault();if(input.value!==confirmation.name)return;accepted=true;dialog.close();};
  dialog.querySelector('#production-cancel').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{dialog.remove();accepted?resolve():reject(new Error('Операция отменена.'));},{once:true});
  dialog.showModal();input.focus();
});
const historyPanel=addWorkspace('ddl-history','История DDL');
async function loadDDLHistory(){
  const generation=state.generation,connection=state.connection;
  const r=await api('/api/ddl-history');if(generation!==state.generation||connection!==state.connection)return;
  historyPanel.innerHTML=`<div class="section-toolbar"><div><h2>История изменений структуры</h2><p class="muted">Последние ${r.limit} записей Studio на всех серверах. Здесь — выбранное подключение. DDL и вызовы EXEC; изменения из других клиентов не записываются.</p></div><button class="button" id="ddl-refresh">↻ Обновить</button></div><label class="field">Фильтр по базе<input id="ddl-filter" placeholder="Все базы" value="${esc(state.database||'')}"></label><div id="ddl-entries"></div>`;
  const render=()=>{const value=$('ddl-filter').value.toLowerCase();$('ddl-entries').innerHTML=r.entries.filter(h=>!value||h.database.toLowerCase().includes(value)).map(h=>`<details class="panel ddl-entry"><summary><strong>${h.status==='success'?'Выполнено':h.status==='error'?'Ошибка':'Результат неизвестен'}</strong> · ${esc(h.database)} · ${new Date(h.started).toLocaleString('ru-RU')}</summary><p class="muted">${esc(h.connectionName)} · ${esc(h.server)}:${h.port} · ${esc(h.login)}${h.transaction?' · транзакция':''}${h.rolledBack?' · выполнен откат':''}</p>${h.error?`<p class="error">${esc(h.error)}</p>`:''}<pre class="sql-preview">${esc(h.sql)}</pre>${h.truncated?'<p>SQL обрезан до 64 КБ.</p>':''}<p class="muted">Результат относится к запуску скрипта. Без общей транзакции до ошибки могли примениться предыдущие команды.</p></details>`).join('')||blank('Записей пока нет.');};
  $('ddl-filter').oninput=render;$('ddl-refresh').onclick=safe(loadDDLHistory);render();
}
document.addEventListener('workspace-tab-changed',safe(async e=>{if(e.detail==='ddl-history')await loadDDLHistory();}));
document.addEventListener('database-changed',safe(async()=>{if(!historyPanel.hidden)await loadDDLHistory();}));
