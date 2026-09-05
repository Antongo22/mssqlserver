import express from 'express';
import sql from 'mssql';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 3000);
const config = {
  server: process.env.MSSQL_HOST || 'localhost',
  port: Number(process.env.MSSQL_PORT || 1433),
  user: 'sa', password: process.env.MSSQL_SA_PASSWORD,
  options: { encrypt: true, trustServerCertificate: true, appName: 'Local MSSQL Studio' },
  pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
  connectionTimeout: 10000, requestTimeout: 60000,
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\x00-\x1f]/.test(value)) {
    throw fail('Имя должно содержать от 1 до 128 символов без управляющих символов.');
  }
  return `[${value.replaceAll(']', ']]')}]`;
}
async function withDb(database, fn) {
  identifier(database);
  const pool = new sql.ConnectionPool({ ...config, database });
  pool.on('error', () => {});
  try { await pool.connect(); return await fn(pool); }
  finally { await pool.close(); }
}
app.disable('x-powered-by');
app.use((req, res, next) => {
  const hostname = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1'].includes(hostname)) return res.status(403).json({ error: 'Разрешён только локальный доступ.' });
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store');
    if (req.headers['x-admin-request'] !== '1') return res.status(403).json({ error: 'Требуется заголовок X-Admin-Request: 1.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Запрос с другого сайта запрещён.' });
  }
  next();
});
app.use(express.json({ limit: '256kb' }));
app.get('/health', async (req, res) => {
  try { await withDb('master', p => p.request().query('SELECT 1 AS ok')); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
app.get('/api/databases', async (req, res) => {
  const result = await withDb('master', p => p.request().query(`
    SELECT d.name, d.state_desc AS state, d.database_id AS id,
      d.create_date AS createdAt, d.collation_name AS collation,
      CAST(COALESCE(SUM(CAST(f.size AS bigint)),0) * 8.0 / 1024 AS decimal(18,1)) AS sizeMB
    FROM sys.databases d LEFT JOIN sys.master_files f ON f.database_id = d.database_id
    GROUP BY d.name,d.state_desc,d.database_id,d.create_date,d.collation_name
    ORDER BY CASE WHEN d.database_id > 4 THEN 0 ELSE 1 END,d.name;
    SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion')) AS version,
      CONVERT(nvarchar(128),SERVERPROPERTY('Edition')) AS edition;`));
  res.json({ databases: result.recordsets[0], server: result.recordsets[1][0] });
});
app.post('/api/databases', async (req, res) => {
  const name = identifier(req.body.name);
  await withDb('master', p => p.request().batch(`CREATE DATABASE ${name}`));
  res.status(201).json({ name: req.body.name });
});
app.delete('/api/databases/:database', async (req, res) => {
  const database = req.params.database;
  const name = identifier(database);
  if (req.body.confirm !== database) throw fail('Введите точное имя базы для удаления.');
  await withDb('master', async p => {
    const found = await p.request().input('name', sql.NVarChar(128), database).query('SELECT database_id AS id FROM sys.databases WHERE name=@name');
    if (!found.recordset.length) throw fail('База не найдена.', 404);
    if (found.recordset[0].id <= 4) throw fail('Удаление системных баз запрещено.');
    await p.request().batch(`DROP DATABASE ${name}`);
  });
  res.json({ ok: true });
});
app.get('/api/databases/:database/tables', async (req, res) => {
  const result = await withDb(req.params.database, p => p.request().query(`
    SELECT s.name AS [schema], t.name, t.object_id AS id,
      COALESCE(SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END),0) AS [rows]
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
    LEFT JOIN sys.partitions p ON p.object_id=t.object_id
    GROUP BY s.name,t.name,t.object_id ORDER BY s.name,t.name`));
  res.json(result.recordset);
});
app.get('/api/databases/:database/table', async (req, res) => {
  const schema = identifier(req.query.schema), table = identifier(req.query.name);
  const result = await withDb(req.params.database, p => p.request()
    .input('object', sql.NVarChar(520), `${schema}.${table}`).query(`
      SELECT c.name, ty.name AS type, c.max_length AS maxLength, c.precision, c.scale,
        c.is_nullable AS nullable,c.is_identity AS [identity],
        CONVERT(bit,CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i
          ON i.object_id=ic.object_id AND i.index_id=ic.index_id
          WHERE i.is_primary_key=1 AND ic.object_id=c.object_id AND ic.column_id=c.column_id) THEN 1 ELSE 0 END) AS primaryKey
      FROM sys.columns c JOIN sys.types ty ON c.user_type_id=ty.user_type_id
      WHERE c.object_id=OBJECT_ID(@object) ORDER BY c.column_id`));
  if (!result.recordset.length) throw fail('Таблица не найдена.', 404);
  res.json(result.recordset);
});
const types = new Set(['INT', 'BIGINT', 'NVARCHAR(255)', 'NVARCHAR(MAX)', 'DECIMAL(18,2)', 'BIT', 'DATE', 'DATETIME2', 'UNIQUEIDENTIFIER']);
app.post('/api/databases/:database/tables', async (req, res) => {
  const table = identifier(req.body.name);
  const columns = req.body.columns;
  if (!Array.isArray(columns) || !columns.length || columns.length > 50) throw fail('Добавьте от 1 до 50 столбцов.');
  if (columns.filter(c => c.primaryKey).length > 1) throw fail('В конструкторе можно выбрать один первичный ключ.');
  const definitions = columns.map(c => {
    if (!types.has(c.type)) throw fail('Неподдерживаемый тип столбца.');
    if (c.identity && !['INT', 'BIGINT'].includes(c.type)) throw fail('Автонумерация доступна только для INT и BIGINT.');
    if (c.primaryKey && c.type === 'NVARCHAR(MAX)') throw fail('NVARCHAR(MAX) нельзя использовать как первичный ключ.');
    return `${identifier(c.name)} ${c.type}${c.identity ? ' IDENTITY(1,1)' : ''} ${c.primaryKey || !c.nullable ? 'NOT NULL' : 'NULL'}${c.primaryKey ? ' PRIMARY KEY' : ''}`;
  });
  await withDb(req.params.database, p => p.request().batch(`CREATE TABLE dbo.${table} (${definitions.join(',')})`));
  res.status(201).json({ ok: true });
});
// Stream the response to bound retained results even for large SELECTs.
async function runQuery(pool, text) {
  const request = pool.request();
  request.stream = true;
  request.arrayRowMode = true;
  // In streaming mode the driver reports SQL errors via events.
  let streamError;
  request.on('error', error => { streamError ||= error; });
  const recordsets = [], messages = [];
  let current, count = 0, bytes = 0, truncated = false;
  request.on('recordset', columns => {
    current = { columns: columns.map(c => c.name), rows: [] };
    if (recordsets.length < 20) recordsets.push(current);
    else { current = null; truncated = true; }
  });
  request.on('row', row => {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (current && current.rows.length < 1000 && count < 5000 && bytes + size < 2_000_000) {
      current.rows.push(row); count++; bytes += size;
    } else truncated = true;
  });
  request.on('info', info => { if (messages.length < 100) messages.push(info.message.slice(0, 4000)); });
  const result = await request.batch(text);
  if (streamError) throw streamError;
  return { recordsets, messages, rowsAffected: result.rowsAffected, truncated };
}
app.post('/api/query', async (req, res) => {
  if (typeof req.body.sql !== 'string' || !req.body.sql.trim()) throw fail('Введите SQL-запрос.');
  if (/^\s*GO\s*(?:\d+)?\s*(?:--.*)?$/im.test(req.body.sql)) throw fail('GO — разделитель sqlcmd. Выполняйте каждый блок отдельно, без строки GO.');
  const start = performance.now();
  const result = await withDb(req.body.database, p => runQuery(p, req.body.sql));
  res.json({ ...result, durationMs: Math.round(performance.now() - start) });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Метод API не найден.' }));
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));
app.use((err, req, res, next) => {
  res.status(err.status || (err.code === 'ELOGIN' || err.code === 'ESOCKET' ? 503 : 400))
    .json({ error: err.message || 'Ошибка сервера.', code: err.code, line: err.lineNumber });
});
app.listen(port, '0.0.0.0', () => console.log(`MSSQL Studio: http://localhost:${port}`));
