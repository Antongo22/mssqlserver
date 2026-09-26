import sql from 'mssql';

// Persistent pools so #temp tables and session SET options survive between Execute clicks.
export function createQuerySessions({ connections, fail }) {
  const sessions = new Map();
  const TTL_MS = 10 * 60 * 1000;
  const MAX = 8;
  const fingerprint = cfg => JSON.stringify([cfg.server, cfg.port, cfg.user, cfg.options?.encrypt, cfg.options?.trustServerCertificate]);

  async function close(id) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    try { await entry.pool.close(); } catch { /* already closed */ }
  }

  async function sweep() {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastUsed > TTL_MS) await close(id);
    }
  }

  setInterval(() => { sweep().catch(() => {}); }, 30_000).unref?.();

  return {
    async run(sessionId, database, fn) {
      if (typeof sessionId !== 'string' || !/^[\w-]{8,80}$/.test(sessionId)) throw fail('Некорректный идентификатор сессии.');
      await sweep();
      const connectionId = connections.get().id;
      const cfg = connections.config();
      const mark = fingerprint(cfg);
      let entry = sessions.get(sessionId);
      if (entry && (entry.connectionId !== connectionId || entry.database !== database || entry.fingerprint !== mark)) {
        await close(sessionId);
        entry = null;
      }
      if (!entry) {
        if (sessions.size >= MAX) throw fail('Слишком много открытых SQL-сессий. Закройте ненужные или подождите 10 минут.');
        const pool = new sql.ConnectionPool({ ...cfg, database, pool: { max: 1, min: 0, idleTimeoutMillis: TTL_MS } });
        pool.on('error', () => { close(sessionId); });
        try { await pool.connect(); }
        catch (error) { try { await pool.close(); } catch { /* ignore */ } throw error; }
        entry = { pool, database, connectionId, fingerprint: mark, lastUsed: Date.now() };
        sessions.set(sessionId, entry);
      }
      entry.lastUsed = Date.now();
      try {
        return await fn(entry.pool);
      } catch (error) {
        // Broken connection: drop the session so the next run opens a clean pool.
        if (error.code === 'ECONNCLOSED' || error.code === 'ESOCKET' || /Connection is closed/i.test(error.message || '')) {
          await close(sessionId);
        }
        throw error;
      }
    },
    close,
    async closeAll() {
      await Promise.all([...sessions.keys()].map(close));
    },
  };
}
