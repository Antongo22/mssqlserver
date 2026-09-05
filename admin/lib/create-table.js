const simpleTypes = new Set(['INT','BIGINT','SMALLINT','TINYINT','BIT','DATE','DATETIME','DATETIME2','DATETIMEOFFSET','SMALLDATETIME','TIME','UNIQUEIDENTIFIER','MONEY','SMALLMONEY','FLOAT','REAL','XML']);

export function columnType(value) {
  if (typeof value !== 'string') throw new Error('Укажите SQL-тип столбца.');
  const type = value.toUpperCase().replace(/\s/g, '');
  if (simpleTypes.has(type)) return type;
  let match = type.match(/^(N?VARCHAR|N?CHAR|VARBINARY|BINARY)\((MAX|\d+)\)$/);
  if (match) {
    const [, name, size] = match;
    if (size === 'MAX' && ['VARCHAR','NVARCHAR','VARBINARY'].includes(name)) return type;
    if (Number(size) >= 1 && Number(size) <= (name.startsWith('N') ? 4000 : 8000)) return type;
  }
  match = type.match(/^(DECIMAL|NUMERIC)\((\d+),(\d+)\)$/);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 38 && Number(match[3]) <= Number(match[2])) return type;
  match = type.match(/^(DATETIME2|DATETIMEOFFSET|TIME)\(([0-7])\)$/);
  if (match) return type;
  match = type.match(/^FLOAT\((\d+)\)$/);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 53) return type;
  throw new Error(`Неподдерживаемый SQL-тип: ${value}`);
}

function displayType(c) {
  const type = c.type.toUpperCase();
  if (['NVARCHAR','NCHAR','VARCHAR','CHAR','VARBINARY','BINARY'].includes(type)) return `${type}(${c.maxLength === -1 ? 'MAX' : c.maxLength / (type.startsWith('N') ? 2 : 1)})`;
  if (['DECIMAL','NUMERIC'].includes(type)) return `${type}(${c.precision},${c.scale})`;
  if (['DATETIME2','DATETIMEOFFSET','TIME'].includes(type)) return `${type}(${c.scale})`;
  return type;
}

export async function primaryKeys(pool) {
  const result = await pool.request().query(`
    SELECT k.object_id id,k.name constraintName,s.name [schema],t.name tableName,
      c.name columnName,ty.name type,c.max_length maxLength,c.precision,c.scale,
      ty.is_user_defined userDefined,ic.key_ordinal ordinal
    FROM sys.key_constraints k
    JOIN sys.tables t ON t.object_id=k.parent_object_id
    JOIN sys.schemas s ON s.schema_id=t.schema_id
    JOIN sys.indexes i ON i.object_id=t.object_id AND i.index_id=k.unique_index_id
    JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal>0
    JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
    JOIN sys.types ty ON ty.user_type_id=c.user_type_id
    WHERE k.type='PK' AND t.is_ms_shipped=0 AND i.is_disabled=0
    ORDER BY s.name,t.name,k.object_id,ic.key_ordinal;`);
  const keys = new Map();
  for (const row of result.recordset) {
    if (!keys.has(row.id)) keys.set(row.id, { id: row.id, name: row.constraintName, schema: row.schema, table: row.tableName, supported: true, columns: [] });
    const key = keys.get(row.id), type = displayType(row);
    try { columnType(type); if (row.userDefined) key.supported = false; }
    catch { key.supported = false; }
    key.columns.push({ name: row.columnName, type, ordinal: row.ordinal });
  }
  return [...keys.values()];
}

export function installCreateTable(app, { withDb, identifier: q, fail }) {
  app.get('/api/databases/:database/primary-keys', async (req,res) => {
    res.json(await withDb(req.params.database, primaryKeys));
  });
  app.post('/api/databases/:database/tables', async (req,res) => {
    const { name, schema = 'dbo', columns, foreignKeys = [] } = req.body;
    const full = `${q(schema)}.${q(name)}`;
    if (!Array.isArray(columns) || !columns.length || columns.length > 50) throw fail('Добавьте от 1 до 50 столбцов.');
    if (columns.some(c => !c || typeof c !== 'object')) throw fail('Некорректное описание столбца.');
    if (columns.filter(c => c.primaryKey).length > 1) throw fail('В конструкторе можно выбрать один первичный ключ.');
    if (!Array.isArray(foreignKeys) || foreignKeys.length > 32) throw fail('Можно добавить до 32 внешних ключей.');
    const definitions = columns.map(c => {
      const type = columnType(c.type);
      if (c.identity && !['INT','BIGINT'].includes(type)) throw fail('Автонумерация доступна только для INT и BIGINT.');
      if (c.primaryKey && type.includes('(MAX)')) throw fail('Тип MAX нельзя использовать как первичный ключ.');
      return `${q(c.name)} ${type}${c.identity ? ' IDENTITY(1,1)' : ''} ${c.primaryKey || !c.nullable ? 'NOT NULL' : 'NULL'}${c.primaryKey ? ' PRIMARY KEY' : ''}`;
    });
    await withDb(req.params.database, async pool => {
      // Resolve against live catalog, never trust client-provided reference names.
      const available = foreignKeys.length ? await primaryKeys(pool) : [];
      const constraints = foreignKeys.map((fk,index) => {
        if (!fk || typeof fk !== 'object') throw fail('Некорректный внешний ключ.');
        const key = available.find(k => k.id === fk.keyId);
        if (!key) throw fail('Выбранный PK больше не существует. Обновите список первичных ключей.');
        if (!key.supported) throw fail('Этот PK использует специальный SQL-тип. Создайте связь через SQL-редактор.');
        if (!Array.isArray(fk.columns) || fk.columns.length !== key.columns.length || new Set(fk.columns).size !== fk.columns.length) throw fail(`Для ${key.schema}.${key.table} сопоставьте все ${key.columns.length} столбца PK без повторов.`);
        const local = fk.columns.map(name => {
          const c = columns.find(c => c.name === name);
          if (!c) throw fail(`Столбец внешнего ключа «${name}» не найден в новой таблице.`);
          return c;
        });
        const onDelete = fk.onDelete || 'NO ACTION', onUpdate = fk.onUpdate || 'NO ACTION';
        if (![onDelete,onUpdate].every(a => ['NO ACTION','CASCADE','SET NULL','SET DEFAULT'].includes(a))) throw fail('Некорректное действие внешнего ключа.');
        if (local.some(c => c.identity) && (onUpdate !== 'NO ACTION' || onDelete !== 'NO ACTION')) {
          throw fail('В FK выбран столбец с AUTO (IDENTITY). Для него и при обновлении, и при удалении выберите NO ACTION. Для обычной связи добавьте отдельный столбец без AUTO кнопкой «＋ Новый столбец».');
        }
        if ([onDelete,onUpdate].includes('SET NULL') && local.some(c => !c.nullable || c.primaryKey)) throw fail('Для SET NULL все столбцы внешнего ключа должны допускать NULL.');
        const constraint = fk.name?.trim() || `FK_${name}_${key.table}_${index+1}`.slice(0,128);
        return `CONSTRAINT ${q(constraint)} FOREIGN KEY (${fk.columns.map(q).join(',')}) REFERENCES ${q(key.schema)}.${q(key.table)} (${key.columns.map(c => q(c.name)).join(',')}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
      });
      // A single CREATE TABLE is atomic: invalid FKs cannot leave a half-created table.
      await pool.request().batch(`CREATE TABLE ${full} (${[...definitions,...constraints].join(',\n')});`);
    });
    res.status(201).json({ok:true});
  });
}
