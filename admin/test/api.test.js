import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const base = process.env.ADMIN_URL || 'http://localhost:3001';
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
test('database lifecycle, quoted identifiers, table data and query limits', async () => {
  const name = `Studio_test_${Date.now()}_]'`, path = `/api/databases/${encodeURIComponent(name)}`;
  assert.equal((await api('/api/databases', 'POST', { name })).status, 201);
  try {
    assert.ok((await api('/api/databases')).data.databases.some(d => d.name === name));
    assert.equal((await api(path + '/tables', 'POST', { name: 'Items]', columns: [
      { name: 'Id', type: 'INT', primaryKey: true, identity: true },
      { name: 'Name', type: 'NVARCHAR(255)', nullable: false },
    ] })).status, 201);
    const query = sql => api('/api/query', 'POST', { database: name, sql });
    assert.equal((await query("INSERT INTO dbo.[Items]]] (Name) VALUES (N'Привет');")).status, 200);
    const selected = await query('SELECT * FROM dbo.[Items]]]; SELECT 1 AS Same, 2 AS Same; PRINT N\'Готово\';');
    assert.equal(selected.status, 200);
    assert.deepEqual(selected.data.recordsets[0].rows, [[1, 'Привет']]);
    assert.deepEqual(selected.data.recordsets[1].rows, [[1, 2]]);
    assert.ok(selected.data.messages.includes('Готово'));
    assert.equal(Number((await api(path + '/tables')).data[0].rows), 1);
    assert.equal((await api(path + '/table?schema=dbo&name=Items%5D')).data[0].primaryKey, true);
    const capped = await query('SELECT TOP (1100) a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b;');
    assert.equal(capped.data.recordsets[0].rows.length, 1000);
    assert.equal(capped.data.truncated, true);
    assert.equal((await query('SELECT * FROM NoSuchTable;')).status, 400);
    assert.equal((await query('SELECT 1;\nGO\nSELECT 2;')).status, 400);
    assert.equal((await api(path, 'DELETE', { confirm: 'wrong' })).status, 400);
    assert.equal((await api('/api/databases/master', 'DELETE', { confirm: 'master' })).status, 400);
  } finally {
    const deleted = await api(path, 'DELETE', { confirm: name });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  }
  assert.ok(!(await api('/api/databases')).data.databases.some(d => d.name === name));
});
test('local API rejects cross-site requests and serves the UI', async () => {
  assert.equal((await fetch(base + '/api/databases')).status, 403);
  assert.equal((await fetch(base + '/api/databases', { headers: { 'X-Admin-Request': '1', Origin: 'https://example.com' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/databases', { headers: { 'X-Admin-Request': '1', Host: 'example.com' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(base + '/health')).status, 200);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SQL-редактор/);
  for (const path of ['/app.js', '/style.css']) assert.equal((await fetch(base + path)).status, 200);
});
