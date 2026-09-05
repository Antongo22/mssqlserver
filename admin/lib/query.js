import sql from 'mssql';
import { bindParameters } from './query-parameters.js';
// GO is a client-side separator, but never inside a string, identifier or comment.
export function splitBatches(source) {
  const batches = [];
  let buffer = [], quote = null, comment = 0, startLine = 1;
  const lines = source.split(/\r?\n/);
  const push = (repeat = 1) => {
    const text = buffer.join('\n').trim();
    if (text) for (let i = 0; i < repeat; i++) batches.push({ text, startLine });
    if (batches.length > 100) throw new Error('Не более 100 SQL-блоков за запуск.');
    buffer = [];
  };
  lines.forEach((line, index) => {
    const separator = !quote && !comment && line.match(/^\s*GO(?:\s+(\d+))?\s*(?:--.*)?$/i);
    if (separator) {
      const repeat = Number(separator[1] || 1);
      if (repeat < 1 || repeat > 100) throw new Error('GO допускает от 1 до 100 повторов.');
      push(repeat); startLine = index + 2; return;
    }
    buffer.push(line);
    for (let i = 0; i < line.length; i++) {
      const c = line[i], next = line[i + 1];
      if (comment) { if (c === '/' && next === '*') { comment++; i++; } else if (c === '*' && next === '/') { comment--; i++; } }
      else if (quote) { if (c === quote) { if (next === quote) i++; else quote = null; } }
      else if (c === '-' && next === '-') break;
      else if (c === '/' && next === '*') { comment++; i++; }
      else if (c === "'" || c === '"') quote = c;
      else if (c === '[') quote = ']';
    }
  });
  push();
  return batches;
}

export const running = new Map();
export async function executeScript(pool, body, onStart = () => {}) {
  const batches = splitBatches(body.sql);
  if (!batches.length) throw new Error('Введите SQL-запрос.');
  const id = body.id;
  if (typeof id !== 'string' || !/^[\w-]{8,80}$/.test(id)) throw new Error('Некорректный идентификатор запроса.');
  if (running.has(id)) throw new Error('Этот запрос уже выполняется.');
  const timeout = Number(body.timeout || 60);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new Error('Тайм-аут: от 1 до 600 секунд.');
  let currentRequest, cancelled = false, reason = 'Запрос отменён.';
  const cancel = message => { cancelled = true; reason = message || reason; currentRequest?.cancel(); };
  running.set(id, cancel); onStart(cancel);
  const timer = setTimeout(() => cancel('Превышено время выполнения.'), timeout * 1000);
  const result = { recordsets: [], messages: [], rowsAffected: [], truncated: false, completedBatches: 0, transaction: !!body.transaction };
  let count = 0, bytes = 0;
  const batch = async (text, collect = true) => {
    if (cancelled) throw new Error(reason);
    const request = new sql.Request(pool, { requestTimeout: timeout * 1000 });
    currentRequest = request;
    request.stream = true; request.arrayRowMode = true;
    let current, error;
    request.on('error', err => { error ||= err; });
    request.on('recordset', columns => {
      current = { columns: columns.map(c => c.name), rows: [] };
      if (collect && result.recordsets.length < 20) result.recordsets.push(current);
      else { current = null; if (collect) result.truncated = true; }
    });
    request.on('row', row => {
      if (!collect) return;
      const size = Buffer.byteLength(JSON.stringify(row));
      if (current && current.rows.length < 1000 && count < 5000 && bytes + size < 4_000_000) {
        current.rows.push(row); count++; bytes += size;
      } else result.truncated = true;
    });
    request.on('info', info => { if (result.messages.length < 100) result.messages.push(info.message.slice(0, 4000)); });
    const prefix = collect ? bindParameters(request, body.parameters, sql) : '';
    const response = await request.batch(prefix + text);
    currentRequest = null;
    if (cancelled) throw new Error(reason);
    if (error) throw error;
    if (collect) result.rowsAffected.push(...response.rowsAffected);
  };
  try {
    if (body.mode === 'estimated') await batch('SET SHOWPLAN_XML ON;', false);
    else {
      if (body.transaction) await batch('SET XACT_ABORT ON; BEGIN TRANSACTION;', false);
      if (body.statistics) await batch('SET STATISTICS IO ON; SET STATISTICS TIME ON;', false);
      if (body.mode === 'actual') await batch('SET STATISTICS XML ON;', false);
    }
    for (const part of batches) {
      try { await batch(part.text); result.completedBatches++; }
      catch (error) { if (error.lineNumber) error.lineNumber += part.startLine - 1; throw error; }
    }
    if (body.transaction && body.mode !== 'estimated') await batch('IF @@TRANCOUNT > 0 COMMIT TRANSACTION;', false);
    return result;
  } catch (error) {
    if (body.transaction && body.mode !== 'estimated') {
      try { await pool.request().batch('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;'); result.rolledBack = true; } catch { result.rolledBack = false; }
    }
    error.partial = result;
    throw error;
  } finally {
    clearTimeout(timer); running.delete(id);
  }
}
