// Shared frontend helpers used by import, schema apply and designer apply.
function chunkList(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function applySQLScript({ connection, database, sql, timeout = 600 }) {
  if (!database) throw new Error('Выберите базу данных.');
  if (!sql?.trim()) throw new Error('Нет SQL для выполнения.');
  return api('/api/query', {
    method: 'POST',
    headers: connection ? { 'X-Studio-Connection': connection } : {},
    body: { database, sql, id: crypto.randomUUID(), timeout, transaction: false },
  });
}

async function validateImportChunks({ database, connection, schema, name, records, onProgress }) {
  const chunks = chunkList(records, 500);
  let checked = 0;
  const errors = [];
  for (const slice of chunks) {
    const r = await api(`/api/databases/${encodeURIComponent(database)}/data/import/preview`, {
      method: 'POST',
      headers: { 'X-Studio-Connection': connection },
      body: { schema, name, records: slice },
    });
    for (const error of r.errors || []) errors.push({ ...error, row: error.row + checked });
    checked += slice.length;
    onProgress?.(checked, records.length, 'validate');
    if (errors.length >= 100) break;
  }
  return { valid: errors.length === 0, errors: errors.slice(0, 100), rows: records.length };
}

async function importRecordChunks({ database, connection, schema, name, records, onProgress }) {
  const chunks = chunkList(records, 500);
  let inserted = 0;
  for (const slice of chunks) {
    await api(`/api/databases/${encodeURIComponent(database)}/data/import`, {
      method: 'POST',
      headers: { 'X-Studio-Connection': connection },
      body: { schema, name, records: slice },
    });
    inserted += slice.length;
    onProgress?.(inserted, records.length, 'import');
  }
  return inserted;
}
