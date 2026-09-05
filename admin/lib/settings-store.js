import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
export async function createStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'settings.json');
  let data = { connections: [], schedules: [], history: [] };
  try { data = { ...data, ...JSON.parse(await readFile(file, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(data),
    update(fn) {
      const work = queue.then(async () => {
        const next = structuredClone(data); const result = fn(next);
        await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
        await rename(file + '.tmp', file); data = next; return result;
      });
      queue = work.catch(() => {}); return work;
    },
  };
}
