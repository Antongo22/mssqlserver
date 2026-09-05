// Database metadata only: the model has no mutation endpoints and never reads table rows.
export function installDiagram(app, { withDb }) {
  app.get('/api/databases/:database/diagram', async (req, res) => {
    const result = await withDb(req.params.database, p => p.request().query(`
      SELECT t.object_id id,s.name [schema],t.name
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
      WHERE t.is_ms_shipped=0 ORDER BY s.name,t.name;
      SELECT c.object_id tableId,c.column_id id,c.name,ty.name type,
        SCHEMA_NAME(ty.schema_id) typeSchema,ty.is_user_defined userType,
        c.max_length maxLength,c.precision,c.scale,c.is_nullable nullable,
        c.is_identity [identity],c.is_computed computed
      FROM sys.columns c JOIN sys.tables t ON t.object_id=c.object_id
      JOIN sys.types ty ON ty.user_type_id=c.user_type_id
      WHERE t.is_ms_shipped=0 ORDER BY c.object_id,c.column_id;
      SELECT i.object_id tableId,i.index_id id,i.name,i.is_primary_key primaryKey,
        i.has_filter filtered,i.is_disabled disabled,ic.column_id columnId,ic.key_ordinal ordinal
      FROM sys.indexes i JOIN sys.tables t ON t.object_id=i.object_id
      JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
      WHERE t.is_ms_shipped=0 AND i.is_unique=1 AND ic.key_ordinal>0 AND i.is_hypothetical=0
      ORDER BY i.object_id,i.index_id,ic.key_ordinal;
      SELECT fk.object_id id,fk.name,fk.parent_object_id childTableId,
        fk.referenced_object_id parentTableId,fk.key_index_id referencedKeyId,
        fk.delete_referential_action_desc onDelete,fk.update_referential_action_desc onUpdate,
        fk.is_disabled disabled,fk.is_not_trusted untrusted,
        fc.constraint_column_id ordinal,fc.parent_column_id childColumnId,fc.referenced_column_id parentColumnId
      FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=fk.object_id
      JOIN sys.tables t ON t.object_id=fk.parent_object_id
      WHERE t.is_ms_shipped=0 ORDER BY fk.object_id,fc.constraint_column_id;`));
    res.json({ database: req.params.database, ...assembleDiagram(result.recordsets) });
  });
}

function sqlType(c) {
  if (c.userType) return `[${c.typeSchema.replaceAll(']', ']]')}].[${c.type.replaceAll(']', ']]')}]`;
  const type = c.type.toUpperCase();
  if (['NVARCHAR','NCHAR','VARCHAR','CHAR','VARBINARY','BINARY'].includes(type)) return `${type}(${c.maxLength === -1 ? 'MAX' : c.maxLength / (type.startsWith('N') ? 2 : 1)})`;
  if (['DECIMAL','NUMERIC'].includes(type)) return `${type}(${c.precision},${c.scale})`;
  if (['TIME','DATETIME2','DATETIMEOFFSET'].includes(type)) return `${type}(${c.scale})`;
  if (type === 'FLOAT') return `FLOAT(${c.precision})`;
  return type;
}

export function assembleDiagram([tables, columns, keyRows, fkRows]) {
  const byId = new Map(tables.map(t => [t.id, { ...t, columns: [], keys: [] }]));
  const keys = new Map(), foreignKeys = new Map();
  for (const c of columns) byId.get(c.tableId)?.columns.push({ ...c, sqlType: sqlType(c), primaryKey: false, uniqueKey: false, foreignKey: false });
  for (const row of keyRows) {
    const keyId = `${row.tableId}:${row.id}`;
    if (!keys.has(keyId)) {
      const key = { id: row.id, name: row.name, primaryKey: row.primaryKey, filtered: row.filtered, disabled: row.disabled, columnIds: [] };
      keys.set(keyId, key); byId.get(row.tableId)?.keys.push(key);
    }
    keys.get(keyId).columnIds.push(row.columnId);
  }
  for (const row of fkRows) {
    if (!byId.has(row.childTableId) || !byId.has(row.parentTableId)) continue;
    if (!foreignKeys.has(row.id)) {
      const { ordinal, childColumnId, parentColumnId, ...key } = row;
      foreignKeys.set(row.id, { ...key, columns: [] });
    }
    foreignKeys.get(row.id).columns.push({ childColumnId: row.childColumnId, parentColumnId: row.parentColumnId });
  }
  for (const table of byId.values()) for (const column of table.columns) {
    column.primaryKey = table.keys.some(k => k.primaryKey && k.columnIds.includes(column.id));
    column.uniqueKey = table.keys.some(k => !k.primaryKey && !k.filtered && !k.disabled && k.columnIds.includes(column.id));
  }
  for (const fk of foreignKeys.values()) {
    const child = byId.get(fk.childTableId), ids = fk.columns.map(c => c.childColumnId);
    for (const c of child.columns) if (ids.includes(c.id)) c.foreignKey = true;
    fk.optional = child.columns.some(c => ids.includes(c.id) && c.nullable);
    // An enabled, unfiltered unique key contained in the FK columns bounds children to one.
    fk.childUnique = child.keys.some(k => !k.filtered && !k.disabled && k.columnIds.every(id => ids.includes(id)));
  }
  return { tables: [...byId.values()], foreignKeys: [...foreignKeys.values()] };
}
