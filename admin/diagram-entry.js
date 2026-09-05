import ELK from 'elkjs/lib/elk-api.js';
import { buildDiagramGraph, HEADER, ROW, nodeId, edgeId } from './lib/diagram-layout.js';

// The existing workspace owns api(), tab(), esc() and state. This bundle only reads metadata.
const get = id => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg';
const button = document.createElement('button');
button.id = 'diagram-tab'; button.className = 'tab'; button.textContent = '◇ Модель БД';
button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false'); button.setAttribute('aria-controls', 'diagram-panel');
get('tables-tab').after(button);
const panel = document.createElement('section');
panel.id = 'diagram-panel'; panel.hidden = true; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'diagram-tab');
panel.innerHTML = `
  <div class="section-toolbar"><div><h2>Даталогическая модель</h2><p class="muted">Таблицы и связи из структуры базы · только просмотр</p></div><div class="actions"><button class="button" id="diagram-reload">↻ Обновить</button><button class="button" id="diagram-export" disabled>↓ SVG</button><button class="button" id="diagram-fullscreen">На весь экран</button></div></div>
  <div class="diagram-tools"><label class="diagram-search"><span class="sr-only">Поиск таблицы или столбца</span><input id="diagram-search" type="search" placeholder="Найти таблицу или столбец…"></label><select id="diagram-table-select" aria-label="Перейти к таблице"><option value="">Перейти к таблице…</option></select><div class="diagram-zoom"><button class="button" id="diagram-minus" aria-label="Уменьшить масштаб" disabled>−</button><output id="diagram-scale">100%</output><button class="button" id="diagram-plus" aria-label="Увеличить масштаб" disabled>＋</button><button class="button" id="diagram-fit" disabled>Вместить</button></div></div>
  <p id="diagram-status" class="muted" role="status">Выберите базу данных.</p>
  <div class="diagram-workspace"><div class="diagram-viewport" id="diagram-viewport" tabindex="0" aria-label="Диаграмма: стрелки перемещают холст, плюс и минус меняют масштаб, 0 вмещает модель"><svg id="diagram-svg" xmlns="${ns}" role="group" aria-label="Таблицы и внешние ключи" hidden></svg><div id="diagram-message" class="diagram-message">Выберите базу данных.</div></div><aside id="diagram-inspector" class="diagram-inspector" aria-label="Сведения о таблице или связи"></aside></div>
  <div class="diagram-legend"><span><b>PK</b> первичный ключ</span><span><b>FK</b> внешний ключ</span><span><b>UK</b> уникальный ключ</span><span><b>?</b> допускается NULL</span><span><b>N</b> от 0 до многих</span><span>Линия: родитель → дочерняя таблица</span><span>Пунктир: FK отключён / не проверен</span></div>
  <p class="muted diagram-help">Перетаскивайте фон, чтобы перемещать холст. Колесо — масштаб. Нажмите таблицу или линию, чтобы увидеть подробности. Связи отображаются только по существующим FK.</p>`;
document.querySelector('.workspace').append(panel);
button.onclick = () => tab('diagram');
const svg = get('diagram-svg'), viewport = get('diagram-viewport'), inspector = get('diagram-inspector');
let model = null, graph = null, scene = null, selected = null, tables = new Map();
let revision = 0, controller, cancelLayout, currentDatabase, zoom = 1, pan = { x: 0, y: 0 }, drag = null, moved = false;
const short = (text, length) => text.length > length ? text.slice(0, length - 1) + '…' : text;
const fullname = t => `${t.schema}.${t.name}`;
function element(tag, attrs = {}, text) {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
// Shared with exported SVG so downloaded diagrams remain standalone and match the theme.
const svgStyles = `
  text { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; fill: var(--ink); font-size: 12px; }
  .model-node, .model-edge { cursor: pointer; outline: none; }
  .node-body { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
  .node-header { fill: var(--blue-soft); }
  .node-title { font-size: 14px; font-weight: 650; }
  .node-schema, .column-type, .column-null { fill: var(--muted); font-size: 11px; }
  .column-name { font-family: "SFMono-Regular",Consolas,monospace; }
  .column-key { fill: var(--blue); font-weight: 650; font-size: 10px; }
  .column-line { stroke: var(--soft-line); }
  .column-highlight { fill: transparent; }
  .model-column.linked .column-highlight { fill: var(--selection); }
  .edge-line { fill: none; stroke: var(--muted); stroke-width: 1.7; }
  .edge-hit { fill: none; stroke: transparent; stroke-width: 14; }
  .edge-arrow { fill: var(--muted); }
  .edge-label-bg { fill: var(--surface); stroke: var(--line); }
  .edge-label { fill: var(--muted); font-size: 11px; text-anchor: middle; }
  .model-edge.flagged .edge-line { stroke: var(--warning); stroke-dasharray: 6 5; }
  .model-node.selected .node-body, .model-node:focus .node-body { stroke: var(--blue); stroke-width: 3; }
  .model-edge.selected .edge-line, .model-edge:focus .edge-line { stroke: var(--blue); stroke-width: 3; }
  .model-edge.selected .edge-label { fill: var(--blue); font-weight: bold; }
  .model-edge:hover .edge-line { stroke: var(--blue); stroke-width: 3; }
  .model-node:hover .node-body { stroke: var(--blue); }
  .dimmed { opacity: .22; }
`;

function ready(enabled) {
  for (const id of ['export', 'minus', 'plus', 'fit']) get('diagram-' + id).disabled = !enabled;
}
function reset() {
  revision++; controller?.abort(); cancelLayout?.(); cancelLayout = null;
  model = graph = scene = selected = null; currentDatabase = null; tables = new Map();
  svg.replaceChildren(); svg.setAttribute('hidden', ''); ready(false); panel.setAttribute('aria-busy', 'false');
  get('diagram-table-select').innerHTML = '<option value="">Перейти к таблице…</option>';
  get('diagram-search').value = ''; get('diagram-scale').textContent = '100%';
  get('diagram-message').hidden = false; get('diagram-message').textContent = 'Модель ещё не загружена.';
  get('diagram-status').textContent = 'Модель ещё не загружена.'; inspector.replaceChildren();
}
async function layout(data, signal) {
  const engine = new ELK({ workerUrl: '/elk-worker.min.js', algorithms: ['layered'] });
  let timer, abort;
  try {
    return await Promise.race([
      engine.layout(buildDiagramGraph(data)),
      new Promise((_, reject) => {
        abort = () => reject(new DOMException('Отменено', 'AbortError'));
        cancelLayout = abort; signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Раскладка заняла больше минуты. Нажмите «Обновить», чтобы повторить.')), 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); engine.terminateWorker();
    if (cancelLayout === abort) cancelLayout = null;
  }
}
async function load() {
  reset();
  const database = state.database, version = revision;
  if (!database) return;
  currentDatabase = database; controller = new AbortController();
  const signal = controller.signal;
  panel.setAttribute('aria-busy', 'true');
  get('diagram-status').textContent = 'Читаем структуру базы…'; get('diagram-message').textContent = 'Загрузка модели…';
  try {
    const data = await api(`/api/databases/${encodeURIComponent(database)}/diagram`, { signal });
    if (version !== revision) return;
    if (!data.tables.length) {
      get('diagram-status').textContent = '0 таблиц · 0 связей';
      get('diagram-message').textContent = 'В этой базе пока нет пользовательских таблиц.';
      return;
    }
    get('diagram-status').textContent = `Автоматическая раскладка: ${data.tables.length} таблиц, ${data.foreignKeys.length} связей…`;
    const positions = await layout(data, signal);
    if (version !== revision) return;
    model = data; graph = positions; tables = new Map(data.tables.map(t => [t.id, t]));
    render(); updateSearch(); showOverview(); ready(true);
    get('diagram-status').textContent = `${database} · ${data.tables.length} таблиц · ${data.foreignKeys.length} связей · обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
    get('diagram-message').hidden = true; svg.removeAttribute('hidden');
    requestAnimationFrame(() => { if (version === revision) fit(); });
  } catch (error) {
    if (version !== revision || error.name === 'AbortError') return;
    get('diagram-message').textContent = 'Не удалось построить модель. Нажмите «Обновить», чтобы повторить.';
    get('diagram-status').textContent = error.message;
  } finally { if (version === revision) panel.setAttribute('aria-busy', 'false'); }
}
function render() {
  svg.replaceChildren();
  svg.append(element('style', {}, svgStyles), element('title', {}, `Модель базы ${model.database}`));
  const defs = element('defs');
  const marker = element('marker', { id: 'diagram-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
  marker.append(element('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'edge-arrow' })); defs.append(marker); svg.append(defs);
  scene = element('g', { id: 'diagram-scene' }); svg.append(scene);
  const fks = new Map(model.foreignKeys.map(fk => [edgeId(fk.id), fk]));
  for (const edge of graph.edges) {
    const fk = fks.get(edge.id), label = `${fk.name}: ${fullname(tables.get(fk.parentTableId))} → ${fullname(tables.get(fk.childTableId))}`;
    const group = element('g', { class: `model-edge${fk.disabled || fk.untrusted ? ' flagged' : ''}`, 'data-fk-id': fk.id, role: 'button', tabindex: 0, 'aria-label': label });
    group.append(element('title', {}, label));
    for (const section of edge.sections || []) {
      const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
      const d = points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
      group.append(element('path', { d, class: 'edge-hit' }), element('path', { d, class: 'edge-line', 'marker-end': 'url(#diagram-arrow)' }));
    }
    for (const label of edge.labels || []) {
      if (!Number.isFinite(label.x)) continue;
      group.append(element('rect', { x: label.x, y: label.y, width: label.width, height: label.height, rx: 5, class: 'edge-label-bg' }), element('text', { x: label.x + label.width / 2, y: label.y + 15, class: 'edge-label' }, label.text));
    }
    scene.append(group);
  }
  for (const node of graph.children) {
    const table = model.tables.find(t => nodeId(t.id) === node.id);
    const group = element('g', { class: 'model-node', 'data-table-id': table.id, transform: `translate(${node.x} ${node.y})`, role: 'button', tabindex: 0, 'aria-label': `${fullname(table)}, ${table.columns.length} столбцов` });
    group.append(element('title', {}, fullname(table)), element('rect', { width: node.width, height: node.height, rx: 9, class: 'node-body' }),
      element('path', { d: `M9 1 H${node.width - 9} Q${node.width - 1} 1 ${node.width - 1} 9 V${HEADER - 1} H1 V9 Q1 1 9 1`, class: 'node-header' }),
      element('text', { x: 16, y: 20, class: 'node-schema' }, short(table.schema, Math.floor((node.width - 32) / 7))),
      element('text', { x: 16, y: 42, class: 'node-title' }, short(table.name, Math.floor((node.width - 32) / 8))));
    table.columns.forEach((column, index) => {
      const y = HEADER + index * ROW;
      const row = element('g', { class: 'model-column', 'data-column-id': column.id });
      const flags = [column.primaryKey ? 'PK' : column.uniqueKey ? 'UK' : '', column.foreignKey ? 'FK' : ''].filter(Boolean).join(' ');
      const typeWidth = Math.min(190, node.width * .35), typeX = node.width - typeWidth - 34;
      row.append(element('title', {}, `${column.name} · ${column.sqlType} · ${column.nullable ? 'NULL' : 'NOT NULL'}${column.identity ? ' · IDENTITY' : ''}${column.computed ? ' · вычисляемый' : ''}`),
        element('rect', { x: 1, y, width: node.width - 2, height: ROW, class: 'column-highlight' }),
        element('line', { x1: 1, x2: node.width - 1, y1: y, y2: y, class: 'column-line' }),
        element('text', { x: 12, y: y + 19, class: 'column-key' }, flags),
        element('text', { x: 62, y: y + 19, class: 'column-name' }, short(column.name, Math.floor((typeX - 72) / 7.3))),
        element('text', { x: typeX, y: y + 19, class: 'column-type' }, short(column.sqlType, Math.floor(typeWidth / 6.5))),
        element('text', { x: node.width - 19, y: y + 19, class: 'column-null' }, column.nullable ? '?' : ''));
      group.append(row);
    });
    scene.append(group);
  }
}

function showOverview() {
  if (!model) return;
  inspector.innerHTML = `<div class="diagram-inspector-head"><h3>Связи базы</h3><p>Выберите таблицу или связь на диаграмме.</p></div><div class="diagram-relations">${model.foreignKeys.map(fk => relationButton(fk)).join('') || '<p class="muted">Внешние ключи не объявлены. Совпадение названий столбцов не создаёт связь.</p>'}</div>`;
}
function relationButton(fk) {
  return `<button class="diagram-relation" data-inspect-fk="${fk.id}"><strong>${esc(fk.name)}</strong><small>${esc(fullname(tables.get(fk.parentTableId)))} → ${esc(fullname(tables.get(fk.childTableId)))}</small>${fk.disabled || fk.untrusted ? '<small class="diagram-warning">Отключён / не проверен</small>' : ''}</button>`;
}
function selectTable(id, center = false) {
  const table = tables.get(id); if (!table) return;
  selected = { table: id };
  const relations = model.foreignKeys.filter(fk => fk.childTableId === id || fk.parentTableId === id);
  inspector.innerHTML = `<div class="diagram-inspector-head"><button class="diagram-back" data-overview>← Все связи</button><h3>${esc(fullname(table))}</h3><p>${table.columns.length} столбцов · ${relations.length} связей</p></div>
    <details class="diagram-columns" open><summary>Столбцы</summary>${table.columns.map(c => `<div><strong>${esc(c.name)}</strong><small>${esc(c.sqlType)} · ${c.nullable ? 'NULL' : 'NOT NULL'}${c.identity ? ' · IDENTITY' : ''}${c.computed ? ' · вычисляемый' : ''}</small></div>`).join('')}</details>
    <details class="diagram-columns"><summary>Ключи (${table.keys.length})</summary>${table.keys.map(k => `<div><strong>${esc(k.name)}</strong><small>${k.primaryKey ? 'PRIMARY KEY' : 'UNIQUE'}${k.filtered ? ' · с фильтром' : ''}${k.disabled ? ' · отключён' : ''}</small><small>${esc(k.columnIds.map(id => table.columns.find(c => c.id === id)?.name).join(', '))}</small></div>`).join('') || '<p>Нет ключей.</p>'}</details>
    <h4>Связи</h4><div class="diagram-relations">${relations.map(relationButton).join('') || '<p class="muted">Нет внешних ключей.</p>'}</div>`;
  highlight();
  if (center) {
    const node = graph.children.find(n => n.id === nodeId(id));
    zoom = Math.min(1, (viewport.clientWidth - 50) / node.width);
    pan = { x: viewport.clientWidth / 2 - (node.x + node.width / 2) * zoom, y: 40 - node.y * zoom }; transform();
  }
}
function selectRelation(id) {
  const fk = model?.foreignKeys.find(f => f.id === id); if (!fk) return;
  selected = { fk: id };
  const parent = tables.get(fk.parentTableId), child = tables.get(fk.childTableId), key = parent.keys.find(k => k.id === fk.referencedKeyId);
  inspector.innerHTML = `<div class="diagram-inspector-head"><button class="diagram-back" data-overview>← Все связи</button><h3>${esc(fk.name)}</h3><p>${key?.primaryKey ? 'PK' : 'UNIQUE'} → FK · ${fk.columns.length > 1 ? 'составная связь' : 'внешний ключ'}</p></div>
    <p><b>Родитель</b><button class="diagram-relation" data-inspect-table="${parent.id}">${esc(fullname(parent))}</button></p><p><b>Дочерняя таблица</b><button class="diagram-relation" data-inspect-table="${child.id}">${esc(fullname(child))}</button></p>
    <h4>Столбцы: FK → ключ родителя</h4><div class="diagram-columns">${fk.columns.map(pair => `<div><strong>${esc(child.columns.find(c => c.id === pair.childColumnId)?.name)} → ${esc(parent.columns.find(c => c.id === pair.parentColumnId)?.name)}</strong></div>`).join('')}</div>
    <p>Родителей на дочернюю запись: <b>${fk.optional ? '0 или 1' : '1'}</b>.<br>Дочерних записей на родителя: <b>${fk.childUnique ? '0 или 1' : '0…N'}</b>.</p>
    <p>При удалении: <b>${esc(fk.onDelete.replaceAll('_', ' '))}</b><br>При обновлении: <b>${esc(fk.onUpdate.replaceAll('_', ' '))}</b></p>
    <p class="${fk.disabled || fk.untrusted ? 'diagram-warning' : 'muted'}">${fk.disabled ? 'FK отключён: новые изменения не проверяются. ' : ''}${fk.untrusted ? 'Существующие данные не проверены. ' : ''}${fk.disabled || fk.untrusted ? 'Кратность показана по объявленной структуре; данные могут ей не соответствовать.' : 'FK включён, существующие данные проверены.'}</p>
    ${fk.columns.length > 1 ? '<p class="muted">Одна линия обозначает весь составной FK. На диаграмме подсвечены все участвующие столбцы.</p>' : ''}`;
  highlight();
}
function highlight() {
  if (!scene) return;
  const fks = model.foreignKeys.filter(f => selected?.fk === f.id || selected?.table === f.parentTableId || selected?.table === f.childTableId);
  const linkedTables = new Set(fks.flatMap(f => [f.parentTableId, f.childTableId]));
  if (selected?.table) linkedTables.add(selected.table);
  const search = get('diagram-search').value.trim().toLocaleLowerCase();
  const matches = new Set(model.tables.filter(t => matchesSearch(t, search)).map(t => t.id));
  for (const node of scene.querySelectorAll('.model-node')) {
    const id = Number(node.dataset.tableId);
    node.classList.toggle('selected', selected?.table === id || (selected?.fk !== undefined && linkedTables.has(id)));
    node.classList.toggle('dimmed', selected ? !linkedTables.has(id) : !matches.has(id));
    for (const column of node.querySelectorAll('.model-column')) {
      const columnId = Number(column.dataset.columnId);
      column.classList.toggle('linked', fks.some(f => f.columns.some(c => (f.parentTableId === id && c.parentColumnId === columnId) || (f.childTableId === id && c.childColumnId === columnId))));
    }
  }
  for (const edge of scene.querySelectorAll('.model-edge')) {
    const id = Number(edge.dataset.fkId), fk = model.foreignKeys.find(f => f.id === id), related = fks.some(f => f.id === id);
    edge.classList.toggle('selected', related);
    edge.classList.toggle('dimmed', selected ? !related : !matches.has(fk.parentTableId) && !matches.has(fk.childTableId));
  }
}
function matchesSearch(table, search) { return !search || fullname(table).toLocaleLowerCase().includes(search) || table.columns.some(c => c.name.toLocaleLowerCase().includes(search)); }
function updateSearch() {
  const search = get('diagram-search').value.trim().toLocaleLowerCase();
  const found = model?.tables.filter(t => matchesSearch(t, search)) || [];
  get('diagram-table-select').innerHTML = `<option value="">${search ? `Найдено таблиц: ${found.length}` : 'Перейти к таблице…'}</option>${found.map(t => `<option value="${t.id}">${esc(fullname(t))}</option>`).join('')}`;
  selected = null; highlight();
}
function transform() { if (scene) scene.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${zoom})`); get('diagram-scale').textContent = `${Math.round(zoom * 100)}%`; }
function fit() {
  if (!graph || !viewport.clientWidth || !viewport.clientHeight) return;
  zoom = Math.min(1, (viewport.clientWidth - 30) / graph.width, (viewport.clientHeight - 30) / graph.height);
  pan = { x: (viewport.clientWidth - graph.width * zoom) / 2, y: (viewport.clientHeight - graph.height * zoom) / 2 }; transform();
}
function scale(factor, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
  if (!graph) return;
  const next = Math.max(Math.min(.03, zoom), Math.min(3, zoom * factor));
  pan = { x: x - (x - pan.x) * next / zoom, y: y - (y - pan.y) * next / zoom }; zoom = next; transform();
}
get('diagram-reload').onclick = load;
get('diagram-fit').onclick = fit;
get('diagram-plus').onclick = () => scale(1.25);
get('diagram-minus').onclick = () => scale(.8);
get('diagram-search').oninput = () => { updateSearch(); showOverview(); };
get('diagram-search').onkeydown = event => { if (event.key === 'Enter') { const option = get('diagram-table-select').options[1]; if (option) selectTable(Number(option.value), true); } };
get('diagram-table-select').onchange = event => { if (event.target.value) selectTable(Number(event.target.value), true); };
inspector.onclick = event => {
  const fk = event.target.closest('[data-inspect-fk]'), table = event.target.closest('[data-inspect-table]');
  if (fk) selectRelation(Number(fk.dataset.inspectFk));
  else if (table) selectTable(Number(table.dataset.inspectTable), true);
  else if (event.target.closest('[data-overview]')) { selected = null; highlight(); showOverview(); }
};
function inspectTarget(target) {
  const table = target.closest('[data-table-id]'), fk = target.closest('[data-fk-id]');
  if (table) selectTable(Number(table.dataset.tableId));
  else if (fk) selectRelation(Number(fk.dataset.fkId));
  else { selected = null; highlight(); showOverview(); }
}
svg.addEventListener('click', event => { if (!moved) inspectTarget(event.target); });
viewport.addEventListener('wheel', event => {
  if (!graph) return;
  event.preventDefault();
  const rect = viewport.getBoundingClientRect(); scale(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * .004), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });
viewport.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !graph) return;
  moved = false; drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, pan: { ...pan }, target: event.target };
});
viewport.addEventListener('pointermove', event => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging'); }
  if (moved) { pan = { x: drag.pan.x + dx, y: drag.pan.y + dy }; transform(); }
});
const endDrag = () => { drag = null; viewport.classList.remove('dragging'); };
viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag); viewport.addEventListener('lostpointercapture', endDrag);
viewport.addEventListener('pointerleave', () => { if (!moved) endDrag(); });
viewport.onkeydown = event => {
  if (!graph) return;
  if (['Enter', ' '].includes(event.key) && event.target.closest('.model-node, .model-edge')) { event.preventDefault(); inspectTarget(event.target); return; }
  if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) event.preventDefault();
  if (event.key === '+' || event.key === '=') scale(1.25);
  if (event.key === '-') scale(.8);
  if (event.key === '0') fit();
  if (event.key === 'Escape') { selected = null; highlight(); showOverview(); }
  if (event.key.startsWith('Arrow')) { const delta = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[event.key]; pan.x += delta[0]; pan.y += delta[1]; transform(); }
};
get('diagram-fullscreen').onclick = async () => {
  try { if (document.fullscreenElement === panel) await document.exitFullscreen(); else await panel.requestFullscreen(); }
  catch { panel.classList.toggle('diagram-expanded'); get('diagram-fullscreen').textContent = panel.classList.contains('diagram-expanded') ? 'Свернуть' : 'На весь экран'; fit(); }
};
document.addEventListener('fullscreenchange', () => { get('diagram-fullscreen').textContent = document.fullscreenElement === panel ? 'Свернуть' : 'На весь экран'; fit(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && panel.classList.contains('diagram-expanded')) { panel.classList.remove('diagram-expanded'); get('diagram-fullscreen').textContent = 'На весь экран'; fit(); } });
new ResizeObserver(() => { if (graph && !panel.hidden) fit(); }).observe(viewport);

get('diagram-export').onclick = () => {
  if (!graph) return;
  const exported = svg.cloneNode(true);
  const exportWidth = Math.max(700, graph.width);
  exported.removeAttribute('hidden'); exported.setAttribute('width', Math.ceil(exportWidth)); exported.setAttribute('height', Math.ceil(graph.height + 55)); exported.setAttribute('viewBox', `0 -55 ${exportWidth} ${graph.height + 55}`);
  exported.querySelector('#diagram-scene').removeAttribute('transform');
  exported.querySelectorAll('.dimmed, .selected, .linked').forEach(n => n.classList.remove('dimmed', 'selected', 'linked'));
  exported.querySelectorAll('[tabindex]').forEach(n => { n.removeAttribute('tabindex'); n.removeAttribute('role'); });
  const variables = getComputedStyle(document.documentElement);
  exported.querySelector('style').textContent = svgStyles.replace(/var\((--[a-z-]+)\)/g, (_, name) => variables.getPropertyValue(name).trim());
  const background = element('rect', { x: 0, y: -55, width: exportWidth, height: graph.height + 55, fill: variables.getPropertyValue('--bg').trim() });
  exported.insertBefore(background, exported.querySelector('#diagram-scene'));
  exported.append(element('text', { x: 24, y: -31, class: 'node-title' }, short(model.database, Math.floor((exportWidth - 48) / 8))), element('text', { x: 24, y: -10, class: 'column-type' }, 'PK / UK → FK · ? = NULL · N = 0…N · пунктир = FK отключён / не проверен'));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(exported)], { type: 'image/svg+xml;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${model.database.replace(/[\\/:*?"<>|]/g, '_')}-model.svg`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('workspace-tab-changed', event => { if (event.detail === 'diagram') load(); });
document.addEventListener('database-changing', () => { reset(); if (!panel.hidden) load(); });
