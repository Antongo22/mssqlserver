import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
export function createConnections({ store, config, sql, fail }) {
  const context = new AsyncLocalStorage();
  const local = { id: 'local', name: 'Docker · локальный', server: config.server, port: config.port, user: config.user, environment: 'development', encrypt: true, trustServerCertificate: true };
  const list = () => [local, ...store.read().connections].map(({ password, ...c }) => c);
  function get(id = context.getStore() || 'local') {
    if (id === 'local') return local;
    const c = store.read().connections.find(c => c.id === id);
    if (!c) throw fail('Подключение не найдено. Выберите доступный сервер.', 404); return c;
  }
  function connectionConfig(id) {
    const c = get(id);
    return c.id === 'local' ? config : { ...config, server: c.server, port: c.port, user: c.user, password: c.password, options: { ...config.options, encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate } };
  }
  const run = (id, fn) => context.run(id, fn);
  const validate = b => {
    for (const k of ['name','server','user']) if (typeof b[k] !== 'string' || !b[k].trim() || b[k].length > 128 || /[\x00-\x1f]/.test(b[k])) throw fail(`Некорректное поле: ${k}.`);
    if (!Number.isInteger(Number(b.port)) || Number(b.port) < 1 || Number(b.port) > 65535) throw fail('Порт: 1–65535.');
    if (typeof b.password !== 'string' || !b.password || b.password.length > 256) throw fail('Укажите пароль.');
    if (!['development','test','production'].includes(b.environment)) throw fail('Выберите окружение.');
    if (b.backupPath && (typeof b.backupPath !== 'string' || b.backupPath.length > 260 || /[\x00-\x1f]/.test(b.backupPath))) throw fail('Некорректный путь бекапов.');
    return { name: b.name.trim(), server: b.server.trim(), port: Number(b.port), user: b.user.trim(), password: b.password, environment: b.environment, encrypt: b.encrypt !== false, trustServerCertificate: b.trustServerCertificate === true, backupPath: b.backupPath || '' };
  };
  function install(app) {
    app.get('/api/connections', (req,res) => res.json(list()));
    app.post('/api/connections/test', async (req,res) => {
      const c = validate(req.body), pool = new sql.ConnectionPool({ ...config, server: c.server, port: c.port, user: c.user, password: c.password, options: { ...config.options, encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate } });
      pool.on('error', () => {});
      try { await pool.connect(); const r = await pool.request().query('SELECT @@SERVERNAME name'); res.json(r.recordset[0]); } finally { await pool.close(); }
    });
    app.post('/api/connections', async (req,res) => {
      const c = { ...validate(req.body), id: randomUUID() };
      await store.update(s => { s.connections.push(c); }); const { password, ...safe } = c; res.status(201).json(safe);
    });
    app.delete('/api/connections/:id', async (req,res) => {
      const c = get(req.params.id);
      if (c.id === 'local') throw fail('Локальное подключение встроено в Compose.');
      if (req.body.confirm !== c.name) throw fail('Подтвердите имя подключения.');
      await store.update(s => { if (s.schedules.some(x => x.connection === c.id)) throw fail('Сначала удалите расписания этого подключения.'); s.connections = s.connections.filter(x => x.id !== c.id); }); res.json({ ok: true });
    });
  }
  return { get, config: connectionConfig, run, install, middleware: (req,res,next) => { const id = req.headers['x-studio-connection'] || 'local'; try { get(id); run(id, next); } catch (e) { next(e); } } };
}
