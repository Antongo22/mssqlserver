import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
export function createBackups({ withDb, sql, identifier: q, fail, connections, store }) {
  const filename = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+\.bak$/.test(value) || value.length > 180) throw fail('Некорректное имя файла резервной копии.'); return value; };
  function paths() {
    const c = connections.get(), root = process.env.BACKUP_DIR || '/backups';
    if (c.id === 'local') return { local: root, server: '/var/opt/mssql/backups' };
    if (!c.backupPath) throw fail('Для бекапов этого сервера задайте общий каталог при добавлении подключения.');
    return { local: path.join(root, c.id), server: c.backupPath.replace(/[\\/]$/, '') };
  }
  const disk = name => `${paths().server}/${filename(name)}`;
  const request = p => new sql.Request(p, { requestTimeout: 600000 });
  async function create(database, prefix = 'backup') {
    q(database); const name = `${prefix}_${Date.now()}_${randomUUID()}.bak`;
    await withDb('master', p => request(p).input('file',sql.NVarChar(400),disk(name)).batch(`BACKUP DATABASE ${q(database)} TO DISK=@file WITH COPY_ONLY,COMPRESSION,CHECKSUM,INIT;`)); return name;
  }
  async function verify(name) { await withDb('master',p => request(p).input('file',sql.NVarChar(400),disk(name)).batch('RESTORE VERIFYONLY FROM DISK=@file WITH CHECKSUM;')); }
  async function restore(name, database) {
    const full = q(database);
    await withDb('master', async p => {
      const existing = await p.request().input('name',sql.NVarChar(128),database).query("SELECT DB_ID(@name) id,CONVERT(nvarchar(400),SERVERPROPERTY('InstanceDefaultDataPath')) dataPath,CONVERT(nvarchar(400),SERVERPROPERTY('InstanceDefaultLogPath')) logPath");
      const config = existing.recordset[0];
      if (config.id !== null) throw fail('База уже существует. Восстановление выполняется только в новую базу.');
      if (!config.dataPath || !config.logPath) throw fail('Не удалось определить каталоги файлов сервера. Используйте RESTORE через SQL.');
      const listing = await p.request().input('file',sql.NVarChar(400),disk(name)).query('RESTORE FILELISTONLY FROM DISK=@file');
      if (listing.recordset.some(f => !['D','L'].includes(f.Type))) throw fail('Копия содержит специальные файлы. Используйте RESTORE через SQL.');
      const r = request(p).input('file',sql.NVarChar(400),disk(name)), id = randomUUID().replaceAll('-','');
      const moves = listing.recordset.map((f,i) => {
        r.input('logical'+i,sql.NVarChar(128),f.LogicalName).input('physical'+i,sql.NVarChar(400),`${f.Type === 'L' ? config.logPath : config.dataPath}restore_${id}_${i}.${f.Type === 'L' ? 'ldf' : 'mdf'}`);
        return `MOVE @logical${i} TO @physical${i}`;
      });
      await r.batch(`RESTORE DATABASE ${full} FROM DISK=@file WITH ${moves.join(',')},RECOVERY,CHECKSUM;`);
    });
  }
  const active = new Set();
  async function runSchedule(schedule) {
    if (active.has(schedule.id)) throw fail('Это задание уже выполняется.');
    active.add(schedule.id);
    const started = Date.now(); let name, error;
    try {
      await connections.run(schedule.connection, async () => {
        await mkdir(paths().local, { recursive: true });
        name = await create(schedule.database, 'schedule_' + schedule.id); await verify(name);
        if (schedule.restoreCheck) {
          const temp = 'Studio_RestoreCheck_' + randomUUID().replaceAll('-','');
          try { await restore(name,temp); await withDb(temp,p => request(p).batch(`DBCC CHECKDB (${q(temp)}) WITH PHYSICAL_ONLY,NO_INFOMSGS;`)); }
          finally {
            // Only this unique temporary database belongs to the check.
            await withDb('master',p => p.request().input('db',sql.NVarChar(128),temp).batch(`IF DB_ID(@db) IS NOT NULL BEGIN ALTER DATABASE ${q(temp)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${q(temp)}; END;`));
          }
        }
        const own = (await readdir(paths().local)).filter(n => n.startsWith('schedule_' + schedule.id + '_') && n.endsWith('.bak'));
        for (const file of own) if (file !== name && (await stat(path.join(paths().local,file))).mtimeMs < Date.now() - schedule.retentionDays * 86400000) await unlink(path.join(paths().local,file));
      });
    } catch (e) { error = e.message; }
    finally {
      try { await store.update(s => {
        s.history.unshift({ scheduleId: schedule.id, connection: schedule.connection, database: schedule.database, started, finished: Date.now(), file: name, success: !error, error, restoreCheck: schedule.restoreCheck }); s.history = s.history.slice(0,100);
        const current = s.schedules.find(x => x.id === schedule.id); if (current) current.nextRun = Date.now() + current.minutes * 60000;
      }); } finally { active.delete(schedule.id); }
    }
    if (error) throw fail(error); return { name };
  }
  function install(app) {
    app.get('/api/backup-schedules', (req,res) => { const c = connections.get().id, s = store.read(); res.json({ schedules: s.schedules.filter(x => x.connection === c).map(x => ({ ...x, running: active.has(x.id) })), history: s.history.filter(x => x.connection === c) }); });
    app.post('/api/backup-schedules', async (req,res) => {
      paths(); const b = req.body; q(b.database);
      if (!Number.isInteger(Number(b.minutes)) || b.minutes < 1 || b.minutes > 10080 || !Number.isInteger(Number(b.retentionDays)) || b.retentionDays < 1 || b.retentionDays > 3650) throw fail('Интервал: 1–10080 минут; хранение: 1–3650 дней.');
      await withDb(b.database,p => p.request().query('SELECT 1'));
      const item = { id: randomUUID(), connection: connections.get().id, database: b.database, minutes: Number(b.minutes), retentionDays: Number(b.retentionDays), restoreCheck: b.restoreCheck === true, enabled: true, nextRun: Date.now()+Number(b.minutes)*60000 };
      await store.update(s => { s.schedules.push(item); }); res.status(201).json(item);
    });
    app.post('/api/backup-schedules/:id', async (req,res) => {
      const schedule = store.read().schedules.find(s => s.id === req.params.id && s.connection === connections.get().id);
      if (!schedule) throw fail('Расписание не найдено.',404);
      if (req.body.action === 'run') { res.json(await runSchedule(schedule)); return; }
      if (active.has(schedule.id)) throw fail('Дождитесь завершения копирования.');
      if (!['enable','disable','delete'].includes(req.body.action)) throw fail('Неизвестное действие.');
      if (req.body.action === 'delete' && req.body.confirm !== schedule.database) throw fail('Подтвердите имя базы.');
      await store.update(s => { if (req.body.action === 'delete') s.schedules = s.schedules.filter(x => x.id !== schedule.id); else s.schedules.find(x => x.id === schedule.id).enabled = req.body.action === 'enable'; }); res.json({ ok: true });
    });
    const timer = setInterval(() => { for (const schedule of store.read().schedules) if (schedule.enabled && schedule.nextRun <= Date.now() && !active.has(schedule.id)) runSchedule(schedule).catch(e => console.error('Scheduled backup failed:', e.message)); }, 10000);
    timer.unref();
  }
  return { paths, create, verify, restore, install };
}
