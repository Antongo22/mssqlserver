import test from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs';
import { buildDiagramGraph } from '../lib/diagram-layout.js';

const base = process.env.ADMIN_URL || 'http://localhost:3001';
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data)); return data;
}

function verifyGeometry(graph) {
  assert.ok(Number.isFinite(graph.width) && Number.isFinite(graph.height));
  for (const node of graph.children) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.width <= graph.width && node.y + node.height <= graph.height);
    for (const other of graph.children) {
      if (other === node) continue;
      assert.ok(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + node.height <= other.y || other.y + other.height <= node.y, `Overlapping tables ${node.id} and ${other.id}`);
    }
  }
  for (const edge of graph.edges) {
    assert.ok(edge.sections?.length, `Missing path for ${edge.id}`);
    for (const section of edge.sections) {
      const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
      for (const [index, p] of points.entries()) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        if (index) assert.ok(Math.abs(points[index - 1].x - p.x) < .01 || Math.abs(points[index - 1].y - p.y) < .01, 'Edges must be orthogonal');
      }
    }
  }
}

test('read-only database diagram: exact FK mappings, unique keys, cycles, schemas and disconnected tables', { timeout: 90000 }, async () => {
  const database = `Studio_diagram_${Date.now()}_]'`, root = '/api/databases/' + encodeURIComponent(database);
  const query = sql => api('/api/query', 'POST', { database, sql });
  await api('/api/databases', 'POST', { name: database });
  try {
    const empty = await api(root + '/diagram');
    assert.deepEqual(empty.tables, []); assert.deepEqual(empty.foreignKeys, []);
    await query(`CREATE SCHEMA [другая схема];
GO
CREATE TYPE dbo.CodeType FROM nvarchar(20) NOT NULL;
GO
CREATE TABLE dbo.[Parent]]](Id int IDENTITY PRIMARY KEY, Code nvarchar(24) NOT NULL UNIQUE, Version int NOT NULL, Tenant int NOT NULL, CONSTRAINT UQ_Parent_Pair UNIQUE(Version,Tenant));
CREATE TABLE [другая схема].[Parent]]](Id int PRIMARY KEY);
CREATE TABLE dbo.Child(Id int PRIMARY KEY, ParentCode nvarchar(24) NULL, OtherParent int NOT NULL, V int NULL, T int NULL,
  CONSTRAINT FK_ByCode FOREIGN KEY(ParentCode) REFERENCES dbo.[Parent]]](Code) ON DELETE SET NULL,
  CONSTRAINT FK_OtherSchema FOREIGN KEY(OtherParent) REFERENCES [другая схема].[Parent]]](Id),
  CONSTRAINT FK_Composite FOREIGN KEY(V,T) REFERENCES dbo.[Parent]]](Version,Tenant));
CREATE TABLE dbo.OneToOne(Id int PRIMARY KEY REFERENCES dbo.[Parent]]](Id));
CREATE TABLE dbo.Employees(Id int PRIMARY KEY, ManagerId int NULL, MentorId int NULL,
  CONSTRAINT FK_Manager FOREIGN KEY(ManagerId) REFERENCES dbo.Employees(Id),
  CONSTRAINT FK_Mentor FOREIGN KEY(MentorId) REFERENCES dbo.Employees(Id));
CREATE TABLE dbo.CycleA(Id int PRIMARY KEY, BId int NULL);
CREATE TABLE dbo.CycleB(Id int PRIMARY KEY, AId int NULL REFERENCES dbo.CycleA(Id));
ALTER TABLE dbo.CycleA ADD CONSTRAINT FK_CycleA_B FOREIGN KEY(BId) REFERENCES dbo.CycleB(Id);
CREATE TABLE dbo.Isolated([<Column &>]]'] nvarchar(max), Amount decimal(29,7), Clock time(4), Custom dbo.CodeType, Computed AS (1+1));
CREATE UNIQUE INDEX IX_Filtered ON dbo.Child(OtherParent) WHERE OtherParent>0;
ALTER TABLE dbo.Child NOCHECK CONSTRAINT FK_ByCode;`);
    const model = await api(root + '/diagram');
    assert.equal(model.database, database); assert.equal(model.tables.length, 8); assert.equal(model.foreignKeys.length, 8);
    const table = (name, schema = 'dbo') => model.tables.find(t => t.name === name && t.schema === schema);
    const col = (t, id) => t.columns.find(c => c.id === id);
    const parent = table('Parent]'), child = table('Child'), isolated = table('Isolated');
    assert.ok(parent.columns.find(c => c.name === 'Id').identity);
    assert.ok(parent.columns.find(c => c.name === 'Code').uniqueKey);
    assert.ok(parent.columns.find(c => c.name === 'Id').primaryKey);
    assert.notEqual(parent.id, table('Parent]', 'другая схема').id);
    assert.deepEqual(isolated.columns.map(c => c.sqlType), ['NVARCHAR(MAX)', 'DECIMAL(29,7)', 'TIME(4)', '[dbo].[CodeType]', 'INT']);
    assert.equal(isolated.columns[0].name, "<Column &>]'"); assert.equal(isolated.columns[4].computed, true);
    assert.ok(child.columns.find(c => c.name === 'ParentCode').foreignKey);
    const composite = model.foreignKeys.find(f => f.name === 'FK_Composite');
    assert.deepEqual(composite.columns.map(c => [col(child, c.childColumnId).name, col(parent, c.parentColumnId).name]), [['V','Version'], ['T','Tenant']]);
    assert.equal(composite.optional, true); assert.equal(composite.childUnique, false);
    const code = model.foreignKeys.find(f => f.name === 'FK_ByCode');
    assert.equal(code.disabled, true); assert.equal(code.untrusted, true); assert.equal(code.onDelete, 'SET_NULL');
    assert.equal(model.foreignKeys.find(f => f.childTableId === table('OneToOne').id).childUnique, true);
    assert.equal(model.foreignKeys.find(f => f.name === 'FK_OtherSchema').childUnique, false, 'Filtered uniqueness must not imply one-to-one');
    const input = buildDiagramGraph(model), layout = await new ELK().layout(input);
    assert.equal(layout.children.length, 8); assert.equal(layout.edges.length, 8); verifyGeometry(layout);
    // Real metadata changes must be visible on the next read, including removed constraints.
    await query('ALTER TABLE dbo.Child DROP CONSTRAINT FK_ByCode;');
    assert.equal((await api(root + '/diagram')).foreignKeys.length, 7);
    for (const asset of ['/diagram.js', '/diagram.css', '/elk-worker.min.js']) assert.equal((await fetch(base + asset)).status, 200);
  } finally { await api(root, 'DELETE', { confirm: database }); }
});

test('automatic layout preserves all tables in larger models and handles a single isolated table', { timeout: 60000 }, async () => {
  const tables = Array.from({ length: 80 }, (_, i) => ({ id: i + 1, schema: 'dbo', name: `Table${i}`, columns: Array.from({ length: 3 + i % 13 }, (_, c) => ({ id: c + 1, name: `Column${c}`, sqlType: 'NVARCHAR(255)' })) }));
  const foreignKeys = tables.slice(1, 70).map((t, i) => ({ id: i + 1, parentTableId: Math.floor(i / 2) + 1, childTableId: t.id, columns: [{ parentColumnId: 1, childColumnId: 2 }] }));
  const elk = new ELK();
  const large = await elk.layout(buildDiagramGraph({ tables, foreignKeys }));
  assert.equal(large.children.length, 80); assert.equal(large.edges.length, 69); verifyGeometry(large);
  verifyGeometry(await elk.layout(buildDiagramGraph({ tables: [tables[0]], foreignKeys: [] })));
});
