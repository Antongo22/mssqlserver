export function installCatalog(app, { withDb, sql, identifier: q, fail }) {
  const root = '/api/databases/:database';
  app.get(root + '/objects', async (req, res) => {
    const r = await withDb(req.params.database, p => p.request().query(`
      SELECT o.object_id id,s.name [schema],o.name,o.type,o.type_desc kind,o.modify_date modifiedAt
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
      WHERE o.is_ms_shipped=0 AND o.type IN ('V','P','FN','IF','TF','TR','SO','SN') ORDER BY o.type,s.name,o.name;
      SELECT name FROM sys.schemas WHERE schema_id<16384 ORDER BY name;`));
    res.json({ objects: r.recordsets[0], schemas: r.recordsets[1] });
  });
  app.get(root + '/definition/:id', async (req, res) => {
    const r = await withDb(req.params.database, p => p.request().input('id', sql.Int, Number(req.params.id)).query(`
      SELECT o.name,s.name [schema],o.type,m.definition,m.uses_ansi_nulls,m.uses_quoted_identifier
      FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
      LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id WHERE o.object_id=@id AND o.is_ms_shipped=0;
      SELECT referenced_schema_name [schema],referenced_entity_name name,referenced_database_name [database]
      FROM sys.sql_expression_dependencies WHERE referencing_id=@id;`));
    if (!r.recordsets[0].length) throw fail('Объект не найден.', 404);
    res.json({ ...r.recordsets[0][0], dependencies: r.recordsets[1] });
  });
  app.delete(root + '/objects/:id', async (req, res) => {
    await withDb(req.params.database, async p => {
      const r = await p.request().input('id', sql.Int, Number(req.params.id)).query('SELECT name,SCHEMA_NAME(schema_id) [schema],type FROM sys.objects WHERE object_id=@id AND is_ms_shipped=0');
      const o = r.recordset[0], kinds = { V: 'VIEW', P: 'PROCEDURE', FN: 'FUNCTION', IF: 'FUNCTION', TF: 'FUNCTION', TR: 'TRIGGER', SO: 'SEQUENCE', SN: 'SYNONYM' };
      if (!o || !kinds[o.type]) throw fail('Объект не найден.', 404);
      if (req.body.confirm !== o.name) throw fail('Для удаления введите имя объекта.');
      await p.request().batch(`DROP ${kinds[o.type]} ${q(o.schema)}.${q(o.name)}`);
    }); res.json({ ok: true });
  });
  app.post(root + '/schemas', async (req, res) => {
    await withDb(req.params.database, p => p.request().batch(`CREATE SCHEMA ${q(req.body.name)} AUTHORIZATION dbo`));
    res.status(201).json({ ok: true });
  });
  app.get(root + '/properties', async (req, res) => {
    const r = await withDb(req.params.database, p => p.request().query(`
      SELECT name,recovery_model_desc recovery,compatibility_level compatibility,collation_name collation,
        is_read_only readOnly,is_auto_close_on autoClose,is_auto_shrink_on autoShrink,page_verify_option_desc pageVerify
      FROM sys.databases WHERE database_id=DB_ID();
      SELECT name,type_desc kind,physical_name path,CAST(size*8.0/1024 AS decimal(18,1)) sizeMB,growth,is_percent_growth FROM sys.database_files;`));
    res.json({ ...r.recordsets[0][0], files: r.recordsets[1] });
  });
  app.patch(root + '/properties', async (req, res) => {
    const { recovery, compatibility } = req.body;
    if (!['SIMPLE', 'FULL', 'BULK_LOGGED'].includes(recovery) || ![100,110,120,130,140,150,160].includes(Number(compatibility))) throw fail('Некорректные параметры базы.');
    if (req.body.confirm !== req.params.database) throw fail('Подтвердите имя базы.');
    await withDb('master', p => p.request().batch(`ALTER DATABASE ${q(req.params.database)} SET RECOVERY ${recovery}; ALTER DATABASE ${q(req.params.database)} SET COMPATIBILITY_LEVEL = ${Number(compatibility)};`));
    res.json({ ok: true });
  });
}
