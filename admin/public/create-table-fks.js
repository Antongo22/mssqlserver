function mountForeignKeyEditor(database) {
  const root = $('new-table-fks');
  let keys = [], loading = false, revision = 0;
  const cards = new Set();
  const localColumns = () => [...$('columns').children].map(row => ({
    id: row.dataset.columnId, row,
    name: row.querySelector('.column-name').value.trim(),
    type: row.querySelector('.column-type').value,
    identity: row.querySelector('.column-auto').checked,
    nullable: row.querySelector('.column-null').checked && !row.querySelector('.column-pk').checked,
  }));
  root.innerHTML = `<div class="fk-heading"><div><h3>Внешние ключи</h3><p class="muted">Свяжите столбцы новой таблицы с существующим PK в этой базе.</p></div><button type="button" class="button" id="refresh-primary-keys">↻ Обновить PK</button></div><p id="primary-key-status" class="muted" role="status">Загрузка первичных ключей…</p><div id="foreign-key-list"></div><button type="button" class="button" id="add-foreign-key" disabled>＋ Внешний ключ</button>`;
  const status = root.querySelector('#primary-key-status'), add = root.querySelector('#add-foreign-key');
  const refresh = root.querySelector('#refresh-primary-keys');
  function active() { return root.isConnected && root === $('new-table-fks'); }
  async function load() {
    const current = ++revision; loading = true; add.disabled = true; refresh.disabled = true;
    status.textContent = 'Запрашиваем существующие PK…';
    try {
      const result = await api(`/api/databases/${encodeURIComponent(database)}/primary-keys`);
      if (!active() || current !== revision) return;
      keys = result;
      status.textContent = keys.length ? `Найдено PK: ${keys.length}. Типы столбцов FK должны соответствовать типам выбранного PK.` : 'В этой базе пока нет первичных ключей. Создайте родительскую таблицу с PK, затем обновите список.';
      for (const card of cards) card.refreshTarget();
    } catch (error) {
      if (active()) status.textContent = `Не удалось загрузить PK: ${error.message}. Нажмите «Обновить PK».`;
    } finally {
      if (active() && current === revision) { loading = false; refresh.disabled = false; add.disabled = !keys.some(k => k.supported); }
    }
  }
  function addCard() {
    const element = document.createElement('fieldset'); element.className = 'fk-card';
    element.innerHTML = `<legend>Связь с первичным ключом</legend><div class="fk-card-actions"><button type="button" class="button remove-fk">Удалить связь</button></div><label class="field">Имя ограничения (необязательно)<input class="fk-name" maxlength="128" placeholder="Например, FK_Orders_Customers"></label><label class="field">Найти родительскую таблицу или PK<input type="search" class="fk-search" placeholder="Схема, таблица, имя PK или столбца"></label><label class="field">Существующий PK<select class="fk-target" required aria-label="Первичный ключ родительской таблицы"></select></label><div class="fk-mappings"></div><div class="builder-sort"><label class="field">При удалении родительской записи<select class="fk-on-delete"><option value="NO ACTION">NO ACTION — запретить при наличии ссылок</option><option value="CASCADE">CASCADE — удалить связанные записи</option><option value="SET NULL">SET NULL — очистить ссылку</option><option value="SET DEFAULT">SET DEFAULT — значение по умолчанию</option></select></label><label class="field">При изменении родительского ключа<select class="fk-on-update"><option value="NO ACTION">NO ACTION — запретить при наличии ссылок</option><option value="CASCADE">CASCADE — обновить связанные значения</option><option value="SET NULL">SET NULL — очистить ссылку</option><option value="SET DEFAULT">SET DEFAULT — значение по умолчанию</option></select></label></div><details><summary>SQL внешнего ключа</summary><pre class="fk-sql"></pre></details>`;
    root.querySelector('#foreign-key-list').append(element);
    const target = element.querySelector('.fk-target'), mappings = element.querySelector('.fk-mappings');
    const selected = new Map();
    const savedMappings = new Map();
    let keyId = null;
    const currentKey = () => keys.find(k => k.id === keyId);
    function createMappedColumn(index) {
      const key = currentKey();
      if (!key) return;
      const row = localColumns().find(l => !l.name && !l.row.querySelector('.column-pk').checked)?.row || addColumn();
      const base = `${key.table}_${key.columns[index].name}`.slice(0,115);
      const names = localColumns().map(l => l.name.toLowerCase());
      let name = base, suffix = 2;
      while (names.includes(name.toLowerCase())) name = `${base}_${suffix++}`;
      row.querySelector('.column-name').value = name;
      row.querySelector('.column-auto').checked = false;
      const type = key.columns[index].type, typeSelect = row.querySelector('.column-type');
      if (![...typeSelect.options].some(o => o.value === type)) typeSelect.add(new Option(type,type));
      typeSelect.value = type;
      selected.set(index,row.dataset.columnId);
      return row;
    }
    const actionNote = document.createElement('p');
    actionNote.className = 'fk-action-note'; actionNote.setAttribute('role','status');
    element.querySelector('.builder-sort').after(actionNote);
    function updateActions() {
      const locals = localColumns().filter(l => [...selected.values()].includes(l.id));
      const identity = locals.some(l => l.identity), notNullable = locals.some(l => !l.nullable);
      const onDelete = element.querySelector('.fk-on-delete'), onUpdate = element.querySelector('.fk-on-update');
      for (const option of onUpdate.options) option.disabled = (identity && option.value !== 'NO ACTION') || (notNullable && option.value === 'SET NULL');
      for (const option of onDelete.options) option.disabled = (identity && option.value !== 'NO ACTION') || (notNullable && option.value === 'SET NULL');
      for (const select of [onDelete,onUpdate]) select.setCustomValidity(select.selectedOptions[0]?.disabled ? 'Это действие недоступно для выбранного столбца. Выберите NO ACTION или добавьте столбец без AUTO.' : '');
      actionNote.textContent = identity ? 'Выбран AUTO (IDENTITY): каскадные действия для такого FK запрещены. При удалении и обновлении доступен только NO ACTION. Для обычной связи оставьте Id автоинкрементным и добавьте отдельный столбец без AUTO кнопкой «＋ Новый столбец».' : notNullable ? 'SET NULL недоступен: выбранный столбец не допускает NULL.' : '';
      actionNote.hidden = !actionNote.textContent;
    }
    const preview = () => {
      const key = currentKey(), locals = localColumns();
      const text = element.querySelector('.fk-sql');
      if (!key || key.columns.some((c,i) => !locals.find(l => l.id === selected.get(i))?.name)) {
        text.textContent = 'Выберите PK и сопоставьте все его столбцы.'; return;
      }
      const name = element.querySelector('.fk-name').value.trim();
      text.textContent = `${name ? `CONSTRAINT ${quote(name)}\n` : ''}FOREIGN KEY (${key.columns.map((c,i) => quote(locals.find(l => l.id === selected.get(i)).name)).join(', ')})\nREFERENCES ${quote(key.schema)}.${quote(key.table)} (${key.columns.map(c => quote(c.name)).join(', ')})\nON DELETE ${element.querySelector('.fk-on-delete').value}\nON UPDATE ${element.querySelector('.fk-on-update').value}`;
    };
    function updateLocals() {
      const key = currentKey(), locals = localColumns();
      mappings.querySelectorAll('[data-map]').forEach(select => {
        const index = Number(select.dataset.map), id = selected.get(index);
        select.innerHTML = '<option value="">Выберите столбец новой таблицы</option>' + locals.map(l => `<option value="${esc(l.id)}" ${!l.name ? 'disabled' : ''}>${esc(l.name || '(без имени)')} · ${esc(l.type)}${l.identity ? ' · AUTO (IDENTITY)' : ''}</option>`).join('');
        select.value = locals.some(l => l.id === id && l.name) ? id : '';
        const local = locals.find(l => l.id === select.value), pk = key?.columns[index];
        const note = mappings.querySelector(`[data-type-note="${index}"]`);
        if (note) note.textContent = local && pk && local.type !== pk.type ? `Выбрано ${local.type}; у PK — ${pk.type}. Можно применить тип PK кнопкой ниже.` : '';
      }); updateActions(); preview();
    }
    function renderMappings() {
      const key = currentKey();
      if (!key) { mappings.innerHTML = '<p class="muted">Выберите родительский PK.</p>'; updateActions(); preview(); return; }
      mappings.innerHTML = `<p class="muted">Столбцы FK добавляются автоматически с типами выбранного PK и без AUTO. Их имена можно изменить в списке столбцов выше или выбрать другие столбцы ниже.</p>` + key.columns.map((c,i) => `<div class="fk-mapping"><div><strong>${esc(key.schema + '.' + key.table + '.' + c.name)}</strong><small>${esc(c.type)}</small></div><span class="fk-arrow">←</span><div><select required data-map="${i}" aria-label="Локальный столбец для ${esc(c.name)}"></select><div class="fk-map-actions"><button type="button" class="button" data-new-column="${i}">＋ Новый столбец</button><button type="button" class="button" data-match-type="${i}">Применить тип PK</button></div><small class="fk-type-note" data-type-note="${i}"></small></div></div>`).join('');
      updateLocals();
    }
    function refreshTarget() {
      const search = element.querySelector('.fk-search').value.trim().toLowerCase();
      const choices = keys.filter(k => k.id === keyId || `${k.schema}.${k.table} ${k.name} ${k.columns.map(c => c.name).join(' ')}`.toLowerCase().includes(search));
      target.innerHTML = '<option value="">Выберите существующий PK</option>' + choices.map(k => `<option value="${k.id}" ${!k.supported ? 'disabled' : ''}>${esc(`${k.schema}.${k.table} (${k.columns.map(c => c.name).join(', ')}) — ${k.name}${!k.supported ? ' · специальный тип, используйте SQL' : ''}`)}</option>`).join('');
      target.value = currentKey() ? String(keyId) : '';
      renderMappings();
    }
    const card = { element, refreshTarget, updateLocals, read() {
      const key = currentKey(), locals = localColumns();
      if (!key || !key.supported) throw new Error('Для каждого FK выберите существующий поддерживаемый PK.');
      const columns = key.columns.map((c,i) => {
        const local = locals.find(l => l.id === selected.get(i));
        if (!local?.name) throw new Error(`Выберите локальный столбец для ${key.table}.${c.name}.`);
        return local.name;
      });
      if (new Set(columns).size !== columns.length) throw new Error('Разные столбцы составного PK должны ссылаться на разные локальные столбцы.');
      updateActions();
      if (!element.querySelector('.fk-on-update').checkValidity() || !element.querySelector('.fk-on-delete').checkValidity()) throw new Error('Выберите совместимое действие FK: для AUTO при удалении и обновлении доступен только NO ACTION.');
      return { name: element.querySelector('.fk-name').value.trim(), keyId: key.id, columns, onDelete: element.querySelector('.fk-on-delete').value, onUpdate: element.querySelector('.fk-on-update').value };
    } };
    cards.add(card);
    element.querySelector('.remove-fk').onclick = () => { cards.delete(card); element.remove(); };
    element.querySelector('.fk-search').oninput = refreshTarget;
    target.onchange = () => {
      if (keyId !== null) savedMappings.set(keyId,new Map(selected));
      keyId = target.value ? Number(target.value) : null;
      selected.clear();
      const key = currentKey(), saved = savedMappings.get(keyId);
      if (key?.supported) key.columns.forEach((column,index) => {
        const previousId = saved?.get(index);
        if (localColumns().some(l => l.id === previousId && l.name)) selected.set(index,previousId);
        else createMappedColumn(index);
      });
      renderMappings();
      for (const card of cards) card.updateLocals();
    };
    element.addEventListener('input', preview);
    element.querySelector('.fk-on-delete').onchange = element.querySelector('.fk-on-update').onchange = () => { updateActions(); preview(); };
    mappings.addEventListener('change', event => {
      if (event.target.matches('[data-map]')) { selected.set(Number(event.target.dataset.map), event.target.value); updateLocals(); }
    });
    mappings.onclick = event => {
      const create = event.target.closest('[data-new-column]'), match = event.target.closest('[data-match-type]');
      if (!create && !match) return;
      const index = Number((create || match).dataset[create ? 'newColumn' : 'matchType']);
      const key = currentKey(); if (!key) return;
      let local = localColumns().find(l => l.id === selected.get(index));
      if (create) {
        local = { row: createMappedColumn(index) };
      }
      if (!local) { notice('Сначала выберите локальный столбец.',true); return; }
      const select = local.row.querySelector('.column-type'), type = key.columns[index].type;
      if (![...select.options].some(o => o.value === type)) select.add(new Option(type,type));
      select.value = type;
      for (const c of cards) c.updateLocals();
    };
    refreshTarget(); target.focus();
  }
  add.onclick = addCard; refresh.onclick = load;
  const update = () => { for (const card of cards) card.updateLocals(); };
  $('columns').addEventListener('input', update);
  $('columns').addEventListener('change', update);
  const observer = new MutationObserver(update);
  observer.observe($('columns'),{childList:true});
  $('modal').addEventListener('close', () => observer.disconnect(), {once:true});
  load();
  return { read() { if (cards.size && loading) throw new Error('Дождитесь обновления списка PK.'); return [...cards].map(card => card.read()); } };
}
