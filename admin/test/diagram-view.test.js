// DOM-level behavior tests, with the actual ELK worker code in an isolated JS context.
// These do not simulate browser painting or screenshot QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';

const source = (await build({ entryPoints: [fileURLToPath(new URL('../diagram-entry.js', import.meta.url))], bundle: true, write: false })).outputFiles[0].text;
const workerCode = await readFile(new URL('../node_modules/elkjs/lib/elk-worker.min.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const model = {
  database: 'Example',
  tables: [
    { id: 1, schema: 'dbo', name: '<Parent &>', keys: [{ id: 1, name: 'PK_Pair', primaryKey: true, columnIds: [1,2] }], columns: [{ id: 1, name: 'Id', sqlType: 'INT', primaryKey: true }, { id: 2, name: 'Code', sqlType: 'INT', primaryKey: true }] },
    { id: 2, schema: 'sales', name: 'Child', keys: [], columns: [{ id: 1, name: 'ParentId', sqlType: 'INT', foreignKey: true }, { id: 2, name: '<Code>', sqlType: 'INT', foreignKey: true }] },
    { id: 3, schema: 'dbo', name: 'Isolated', keys: [], columns: [{ id: 1, name: 'Value', sqlType: 'INT' }] },
  ],
  foreignKeys: [{ id: 1, name: '<FK_pair>', parentTableId: 1, childTableId: 2, referencedKeyId: 1, columns: [{ parentColumnId: 1, childColumnId: 1 }, { parentColumnId: 2, childColumnId: 2 }], onDelete: 'NO_ACTION', onUpdate: 'CASCADE' }],
};
class Worker {
  constructor() {
    this.context = vm.createContext({ postMessage: data => queueMicrotask(() => { if (!this.stopped) this.onmessage({ data }); }), console, setTimeout, clearTimeout });
    vm.runInContext('self = globalThis', this.context);
    vm.runInContext(workerCode, this.context);
  }
  postMessage(data) { queueMicrotask(() => {
    if (this.stopped) return;
    this.context.incoming = JSON.stringify(data);
    vm.runInContext('self.onmessage({ data: JSON.parse(incoming) })', this.context);
  }); }
  terminate() { this.stopped = true; }
}
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('View did not settle');
}
function setup() {
  const { document, window, CustomEvent } = parseHTML(html);
  const $ = id => document.getElementById(id), requests = [];
  let respond = async () => structuredClone(model), blob;
  const state = { database: 'Example' };
  const context = vm.createContext({ document, window, console, CustomEvent, Worker, AbortController, DOMException, Blob, setTimeout, clearTimeout,
    state, esc, api: async (path, options) => { requests.push({ path, options }); return respond(path, options); },
    tab: name => { $('diagram-panel').hidden = name !== 'diagram'; document.dispatchEvent(new CustomEvent('workspace-tab-changed', { detail: name })); },
    requestAnimationFrame: fn => setTimeout(fn, 0), ResizeObserver: class { observe() {} },
    getComputedStyle: () => ({ getPropertyValue: name => name === '--bg' ? '#101722' : '#e4eaf3' }),
    URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    XMLSerializer: class { serializeToString(node) { return node.outerHTML; } },
  });
  vm.runInContext(source, context);
  Object.defineProperties($('diagram-viewport'), { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
  return { $, document, window, state, requests, setResponse: fn => { respond = fn; }, getBlob: () => blob, CustomEvent };
}

test('model viewer: read-only load, escaped names, composite highlighting, search, zoom and full SVG export', { timeout: 15000 }, async () => {
  const { $, document, requests, getBlob } = setup();
  assert.equal(requests.length, 0, 'Load lazily when the tab opens');
  $('diagram-tab').click();
  await waitFor(() => $('diagram-panel').getAttribute('aria-busy') === 'false');
  assert.equal($('diagram-export').disabled, false, $('diagram-status').textContent);
  assert.equal($('diagram-svg').hasAttribute('hidden'), false, 'SVG visibility uses attributes, not HTML-only hidden properties');
  assert.equal(document.querySelectorAll('.model-node').length, 3);
  assert.equal(document.querySelectorAll('.model-edge').length, 1);
  document.querySelector('.model-edge').dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.equal(document.querySelectorAll('.model-column.linked').length, 4);
  assert.equal($('diagram-inspector').querySelector('h3').textContent, '<FK_pair>');
  assert.equal($('diagram-inspector').querySelector('fk_pair'), null);
  assert.match($('diagram-inspector').textContent, /составная связь/);
  $('diagram-search').value = 'Isolated'; $('diagram-search').oninput();
  assert.equal(document.querySelectorAll('.model-node.dimmed').length, 2);
  $('diagram-search').onkeydown({ key: 'Enter' });
  assert.equal(document.querySelector('.model-node.selected').dataset.tableId, '3');
  const oldTransform = $('diagram-scene').getAttribute('transform');
  $('diagram-plus').click();
  assert.notEqual($('diagram-scene').getAttribute('transform'), oldTransform);
  assert.doesNotMatch($('diagram-scene').getAttribute('transform'), /NaN|Infinity/);
  $('diagram-export').click();
  const svg = await getBlob().text();
  assert.match(svg, /&lt;Parent &amp;&gt;/); assert.match(svg, /Isolated/); assert.match(svg, /sales/);
  assert.doesNotMatch(svg, /class="[^"]*dimmed|var\(--|translate\([^)]*\) scale/);
  assert.match(svg, /#101722/);
  assert.ok(requests.every(r => r.path.endsWith('/diagram') && !r.options.method), 'Viewer performs only metadata GETs');
});

test('model viewer discards old database responses and recovers from errors and empty schemas', { timeout: 15000 }, async () => {
  const { $, document, state, setResponse, CustomEvent } = setup();
  let resolveOld;
  setResponse(() => new Promise(resolve => { resolveOld = resolve; }));
  $('diagram-tab').click();
  state.database = 'New database';
  setResponse(async () => ({ ...structuredClone(model), database: state.database }));
  document.dispatchEvent(new CustomEvent('database-changing'));
  await waitFor(() => $('diagram-panel').getAttribute('aria-busy') === 'false');
  assert.equal($('diagram-export').disabled, false, $('diagram-status').textContent);
  resolveOld({ database: 'Old', tables: [], foreignKeys: [] });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match($('diagram-status').textContent, /New database/);
  assert.equal(document.querySelectorAll('.model-node').length, 3);
  setResponse(async () => { throw new Error('Database offline'); });
  await $('diagram-reload').onclick();
  assert.equal($('diagram-export').disabled, true); assert.equal($('diagram-svg').hasAttribute('hidden'), true);
  assert.equal($('diagram-status').textContent, 'Database offline');
  setResponse(async () => ({ database: 'Empty', tables: [], foreignKeys: [] }));
  await $('diagram-reload').onclick();
  assert.match($('diagram-message').textContent, /нет пользовательских таблиц/);
  assert.equal(document.querySelectorAll('.model-node').length, 0);
  setResponse(async () => structuredClone(model));
  await $('diagram-reload').onclick();
  assert.equal($('diagram-export').disabled, false);
});
