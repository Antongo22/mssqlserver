const $ = id => document.getElementById(id);
const state = { databases: [], database: null, tables: [], table: null, columns: [], data: null, results: null, resultIndex: 0, busy: false, generation: 0 };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const quote = value => `[${value.replaceAll(']', ']]')}]`;
const dbPath = () => `/api/databases/${encodeURIComponent(state.database)}`;
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = !message; }
function safe(action) { return async (...args) => { try { await action(...args); } catch (error) { notice(error.message, true); } }; }
function renderDatabases() {
  const search = $('db-search').value.toLowerCase();
  let systemHeading = false;
  $('databases').innerHTML = state.databases.filter(d => d.name.toLowerCase().includes(search)).map(d => {
    const heading = d.id <= 4 && !systemHeading ? '<div class="side-group">СИСТЕМНЫЕ</div>' : '';
    if (d.id <= 4) systemHeading = true;
    return `${heading}<button class="db-item ${d.name === state.database ? 'active' : ''}" data-db="${esc(d.name)}" title="${esc(d.name)}"><span>▤</span><span class="db-name">${esc(d.name)}</span>${d.id <= 4 ? '<span class="db-type">SYS</span>' : ''}</button>`;
  }).join('') || '<p class="muted">Базы не найдены</p>';
}
async function loadDatabases(preferred) {
  const data = await api('/api/databases');
  state.databases = data.databases;
  $('connection-status').textContent = 'Соединение установлено';
  $('server-version').textContent = `Версия ${data.server.version}`;
  $('footer-status').textContent = 'Подключено · localhost';
  const selected = preferred || state.database;
  await selectDatabase(data.databases.find(d => d.name === selected)?.name || data.databases[0]?.name);
}
async function selectDatabase(name) {
  if (!name) return;
  state.database = name; state.table = null; state.columns = []; state.data = null;
  const generation = ++state.generation;
  const database = state.databases.find(d => d.name === name);
  $('database-title').textContent = name; $('breadcrumb').textContent = name; $('query-database').textContent = name;
  $('database-meta').textContent = `${database.state} · ${Number(database.sizeMB).toLocaleString('ru-RU')} МБ · ${database.collation || '—'}`;
  $('delete-database').disabled = database.id <= 4 || state.busy;
  $('new-table').disabled = database.state !== 'ONLINE' || state.busy;
  $('run-query').disabled = database.state !== 'ONLINE' || state.busy;
  $('table-detail').hidden = true;
  $('table-count').textContent = '…';
  $('tables-list').innerHTML = '<div class="empty small"><p>Загрузка таблиц…</p></div>';
  state.results = null; $('export-csv').disabled = true; $('query-stats').textContent = '';
  $('result-tabs').hidden = true; $('query-messages').hidden = true;
  $('query-result').innerHTML = '<div class="empty small"><h3>Готово к запросам</h3><p>Результат появится здесь.</p></div>';
  renderDatabases();
  try {
    const tables = await api(`${dbPath()}/tables`);
    if (generation !== state.generation) return;
    state.tables = tables; renderTables();
  } catch (error) { if (generation === state.generation) { state.tables = []; renderTables(); notice(error.message, true); } }
}
function renderTables() {
  $('table-count').textContent = state.tables.length;
  $('tables-list').innerHTML = state.tables.length ? state.tables.map((t, i) => `<button class="table-card ${state.table?.id === t.id ? 'selected' : ''}" data-table="${i}"><span class="table-icon">▦</span><span><strong>${esc(t.name)}</strong><small>${esc(t.schema)} · ${Number(t.rows).toLocaleString('ru-RU')} записей</small></span><span class="arrow">↗</span></button>`).join('') : '<div class="empty"><span class="empty-symbol">▦</span><h3>В этой базе пока нет таблиц</h3><p>Создайте первую таблицу в конструкторе<br>или выполните CREATE TABLE в SQL-редакторе.</p><button class="button primary" data-action="new-table">＋ Создать таблицу</button></div>';
}
function grid(columns, rows) {
  if (!columns.length) return '<div class="empty small"><p>Запрос выполнен без набора данных.</p></div>';
  return `<table><thead><tr><th>#</th>${columns.map(c => `<th>${esc(c || '(без имени)')}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r, i) => `<tr><td class="muted">${i + 1}</td>${r.map(v => v === null ? '<td class="null">NULL</td>' : `<td title="${esc(typeof v === 'object' ? JSON.stringify(v) : v)}">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length + 1}" class="muted">Нет записей</td></tr>`}</tbody></table>`;
}
async function openTable(table) {
  const generation = state.generation;
  state.table = table; renderTables();
  $('table-detail').hidden = false; $('table-title').textContent = `${table.schema}.${table.name}`;
  $('table-content').textContent = 'Загрузка…';
  const [columns, data] = await Promise.all([
    api(`${dbPath()}/table?schema=${encodeURIComponent(table.schema)}&name=${encodeURIComponent(table.name)}`),
    api('/api/query', { method: 'POST', body: { database: state.database, sql: `SELECT TOP (100) * FROM ${quote(table.schema)}.${quote(table.name)};` } }),
  ]);
  if (generation !== state.generation || state.table !== table) return;
  state.columns = columns; state.data = data.recordsets[0]; showTableData();
}
function showTableData() {
  $('show-data').classList.add('active'); $('show-structure').classList.remove('active');
  $('data-note').textContent = 'Первые 100 записей · без сортировки';
  $('table-content').innerHTML = state.data ? grid(state.data.columns, state.data.rows) : '';
}
function showStructure() {
  $('show-data').classList.remove('active'); $('show-structure').classList.add('active'); $('data-note').textContent = `${state.columns.length} столбцов`;
  $('table-content').innerHTML = grid(['Столбец', 'Тип', 'NULL', 'Ключ', 'Автонумерация'], state.columns.map(c => {
    let type = c.type;
    if (['nvarchar', 'nchar', 'varchar', 'char', 'varbinary', 'binary'].includes(type)) type += `(${c.maxLength === -1 ? 'max' : c.maxLength / (type.startsWith('n') ? 2 : 1)})`;
    if (['decimal', 'numeric'].includes(c.type)) type += `(${c.precision},${c.scale})`;
    return [c.name, type, c.nullable ? 'Да' : 'Нет', c.primaryKey ? 'PRIMARY KEY' : '—', c.identity ? 'IDENTITY' : '—'];
  }));
}
function tab(name) {
  for (const id of ['tables', 'query']) { $(id + '-panel').hidden = id !== name; $(id + '-tab').classList.toggle('active', id === name); $(id + '-tab').setAttribute('aria-selected', String(id === name)); }
}
const selectedTableName = () => state.table ? `${quote(state.table.schema)}.${quote(state.table.name)}` : '[dbo].[TableName]';
function template(type) {
  const table = selectedTableName();
  const editable = state.columns.filter(c => !c.identity && !['timestamp', 'rowversion'].includes(c.type));
  const column = quote(editable.find(c => !c.primaryKey)?.name || 'ColumnName');
  const key = quote(state.columns.find(c => c.primaryKey)?.name || 'Id');
  const templates = {
    select: `SELECT TOP (100) *\nFROM ${table};`,
    insert: editable.length ? `INSERT INTO ${table}\n    (${editable.map(c => quote(c.name)).join(', ')})\nVALUES\n    (${editable.map(c => /int|decimal|numeric|bit|float|real|money/.test(c.type) ? '0' : /date|time/.test(c.type) ? 'SYSDATETIME()' : c.type === 'uniqueidentifier' ? 'NEWID()' : "N'Значение'").join(', ')});` : `INSERT INTO ${table} (${column})\nVALUES (N'Значение');`,
    update: `-- Замените значение и условие WHERE перед запуском.\nUPDATE ${table}\nSET ${column} = N'Новое значение'\nWHERE ${key} = 0;`,
    delete: `-- Проверьте условие WHERE перед запуском.\nDELETE FROM ${table}\nWHERE ${key} = 0;`,
    create: `CREATE TABLE dbo.NewTable (\n    Id INT IDENTITY(1,1) PRIMARY KEY,\n    Name NVARCHAR(255) NOT NULL,\n    CreatedAt DATETIME2 NOT NULL DEFAULT SYSDATETIME()\n);`,
  };
  if (!templates[type]) return;
  $('sql-editor').value = templates[type]; tab('query'); $('sql-editor').focus(); $('query-template').value = '';
}
async function runQuery() {
  if (state.busy || !state.database) return;
  state.busy = true; $('run-query').disabled = true; $('run-query').textContent = 'Выполняется…';
  $('new-database').disabled = true; $('new-table').disabled = true; $('delete-database').disabled = true;
  const generation = state.generation, database = state.database;
  notice(''); $('query-stats').textContent = 'Выполнение…';
  const editor = $('sql-editor');
  const text = editor.value.substring(editor.selectionStart, editor.selectionEnd).trim() || editor.value;
  try {
    const result = await api('/api/query', { method: 'POST', body: { database, sql: text } });
    if (generation !== state.generation) return;
    state.results = result; state.resultIndex = 0;
    $('query-stats').textContent = `${result.durationMs} мс · затронуто ${result.rowsAffected.reduce((a, b) => a + b, 0)} строк`;
    $('query-messages').hidden = !result.messages.length && !result.truncated;
    $('query-messages').textContent = [...result.messages, ...(result.truncated ? ['Показана часть результата: до 1000 строк на набор, 5000 всего и 2 МБ. Уточните SELECT / WHERE для остальных данных.'] : [])].join('\n');
    renderResult();
    try { state.tables = await api(`${dbPath()}/tables`); if (generation === state.generation) renderTables(); } catch { /* Database may have been removed by SQL. */ }
  } catch (error) {
    if (generation !== state.generation) return;
    state.results = null; $('export-csv').disabled = true; $('result-tabs').hidden = true; $('query-messages').hidden = true;
    $('query-stats').textContent = 'Ошибка'; $('query-result').innerHTML = `<div class="empty small"><h3>Запрос не выполнен</h3><p class="error-text">${esc(error.message)}</p></div>`;
  } finally {
    state.busy = false; $('run-query').disabled = false; $('run-query').textContent = '▶ Выполнить';
    $('new-database').disabled = false; $('new-table').disabled = false;
    $('delete-database').disabled = (state.databases.find(d => d.name === state.database)?.id || 0) <= 4;
  }
}
function renderResult() {
  const sets = state.results?.recordsets || [], selected = sets[state.resultIndex];
  $('result-tabs').hidden = sets.length < 2;
  $('result-tabs').innerHTML = sets.map((set, i) => `<button class="chip ${i === state.resultIndex ? 'active' : ''}" data-result="${i}">Результат ${i + 1} · ${set.rows.length}</button>`).join('');
  $('query-result').innerHTML = selected ? grid(selected.columns, selected.rows) : '<div class="empty small"><h3>Запрос выполнен</h3><p>Команда не возвращает таблицу данных.</p></div>';
  $('export-csv').disabled = !selected;
}
let submitModal;
function modal(title, content, submit, label = 'Создать', danger = false, wide = false) {
  $('modal-title').textContent = title; $('modal-body').innerHTML = content; $('modal-error').hidden = true;
  $('modal-submit').textContent = label; $('modal-submit').className = `button primary${danger ? ' danger' : ''}`;
  $('modal').classList.toggle('wide', wide); submitModal = submit; $('modal').showModal();
  $('modal-body').querySelector('input')?.focus();
}
function newDatabase() {
  modal('Новая база данных', '<label class="field">Название базы<input name="name" required maxlength="128" placeholder="Например, MyProject" autocomplete="off"><small>Будет создана пустая база с настройками SQL Server по умолчанию.</small></label>', async form => {
    const name = new FormData(form).get('name').trim();
    await api('/api/databases', { method: 'POST', body: { name } });
    await loadDatabases(name); tab('tables'); notice(`База «${name}» создана.`);
  });
}
function deleteDatabase() {
  const database = state.database;
  modal('Удалить базу данных?', `<p class="modal-copy">Все таблицы и данные базы <strong>${esc(database)}</strong> будут удалены без возможности восстановления.</p><label class="field">Введите название базы<input name="confirm" required autocomplete="off" placeholder="${esc(database)}"></label>`, async form => {
    await api(`/api/databases/${encodeURIComponent(database)}`, { method: 'DELETE', body: { confirm: new FormData(form).get('confirm') } });
    await loadDatabases(); notice(`База «${database}» удалена.`);
  }, 'Удалить базу', true);
}
const types = ['INT', 'BIGINT', 'NVARCHAR(255)', 'NVARCHAR(MAX)', 'DECIMAL(18,2)', 'BIT', 'DATE', 'DATETIME2', 'UNIQUEIDENTIFIER'];
function addColumn(first = false) {
  const row = document.createElement('div'); row.className = 'column-row';
  row.innerHTML = `<input type="text" class="column-name" aria-label="Название столбца" placeholder="Название" required maxlength="128" value="${first ? 'Id' : ''}"><select class="column-type" aria-label="Тип столбца">${types.map(t => `<option ${!first && t === 'NVARCHAR(255)' ? 'selected' : ''}>${t}</option>`).join('')}</select><label>NULL<input type="checkbox" class="column-null" ${first ? '' : 'checked'}></label><label>PK<input type="checkbox" class="column-pk" ${first ? 'checked' : ''}></label><label>AUTO<input type="checkbox" class="column-auto" ${first ? 'checked' : ''}></label><button type="button" class="icon-button remove-column" aria-label="Удалить столбец">×</button>`;
  $('columns').append(row);
}
function newTable() {
  if (!state.database) return;
  const database = state.database;
  modal('Новая таблица', `<label class="field">Название таблицы<input name="name" required maxlength="128" placeholder="Например, Products"><small>База: ${esc(database)} · схема dbo. PK — первичный ключ, AUTO — автоинкремент.</small></label><div id="columns"></div><button type="button" class="button" id="add-column">＋ Столбец</button>`, async form => {
    const columns = [...$('columns').children].map(row => ({ name: row.querySelector('.column-name').value.trim(), type: row.querySelector('.column-type').value, nullable: row.querySelector('.column-null').checked, primaryKey: row.querySelector('.column-pk').checked, identity: row.querySelector('.column-auto').checked }));
    const name = new FormData(form).get('name').trim();
    await api(`/api/databases/${encodeURIComponent(database)}/tables`, { method: 'POST', body: { name, columns } });
    await selectDatabase(database); const created = state.tables.find(t => t.schema === 'dbo' && t.name === name); if (created) await openTable(created);
    notice(`Таблица «${name}» создана.`);
  }, 'Создать таблицу', false, true);
  addColumn(true); addColumn(); $('add-column').onclick = () => addColumn();
}
$('modal-form').onsubmit = async event => {
  event.preventDefault(); $('modal-submit').disabled = true; $('modal-error').hidden = true;
  try { await submitModal(event.target); $('modal').close(); }
  catch (error) { $('modal-error').textContent = error.message; $('modal-error').hidden = false; }
  finally { $('modal-submit').disabled = false; }
};
$('modal-body').onclick = event => event.target.closest('.remove-column')?.parentElement.remove();
$('cancel-modal').onclick = $('close-modal').onclick = () => $('modal').close();
$('new-database').onclick = newDatabase; $('delete-database').onclick = deleteDatabase; $('new-table').onclick = newTable;
$('refresh').onclick = safe(() => loadDatabases()); $('db-search').oninput = renderDatabases;
$('databases').onclick = safe(async event => { const button = event.target.closest('[data-db]'); if (button) { notice(''); await selectDatabase(button.dataset.db); } });
$('tables-list').onclick = safe(async event => { if (event.target.closest('[data-action="new-table"]')) return newTable(); const button = event.target.closest('[data-table]'); if (button) await openTable(state.tables[Number(button.dataset.table)]); });
$('tables-tab').onclick = () => tab('tables'); $('query-tab').onclick = () => tab('query');
$('show-data').onclick = showTableData; $('show-structure').onclick = showStructure;
$('select-template').onclick = () => template('select'); $('insert-template').onclick = () => template('insert');
$('query-template').onchange = event => template(event.target.value);
$('run-query').onclick = runQuery;
$('sql-editor').onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); runQuery(); } if (event.key === 'Tab') { event.preventDefault(); const target = event.target; target.setRangeText('    ', target.selectionStart, target.selectionEnd, 'end'); } };
$('result-tabs').onclick = event => { const button = event.target.closest('[data-result]'); if (button) { state.resultIndex = Number(button.dataset.result); renderResult(); } };
$('export-csv').onclick = () => {
  const result = state.results?.recordsets[state.resultIndex]; if (!result) return;
  const cell = value => { let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const csv = '\uFEFF' + [result.columns, ...result.rows].map(row => row.map(cell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'query-result.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
loadDatabases().catch(error => { notice(error.message, true); $('connection-status').textContent = 'Нет соединения'; $('footer-status').textContent = 'Ошибка соединения'; $('databases').textContent = 'Нажмите ↻, чтобы повторить подключение.'; });
