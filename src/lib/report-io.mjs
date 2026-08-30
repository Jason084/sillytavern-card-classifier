import { open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function csv(values) {
  return values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',') + '\n';
}

export async function writeAll(handle, text) {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw new Error('report write returned zero bytes');
    offset += bytesWritten;
  }
}

export async function fileExists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function readJsonIfPresent(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readJsonl(path) {
  if (!(await fileExists(path))) return [];
  const output = [];
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && !lines[lastNonEmpty].trim()) lastNonEmpty -= 1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try { output.push(JSON.parse(lines[index])); }
    catch (error) {
      if (index !== lastNonEmpty) throw new Error(`${path} 第 ${index + 1} 行不是有效 JSON：${error.message}`);
    }
  }
  return output;
}

export async function rewriteJsonl(path, records) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  await rename(temporaryPath, path);
}

export async function jsonlAppender(path, existing = []) {
  await rewriteJsonl(path, existing);
  const handle = await open(path, 'a');
  let queue = Promise.resolve();
  return {
    append(record) {
      const task = queue.then(() => handle.write(`${JSON.stringify(record)}\n`));
      queue = task.catch(() => {});
      return task;
    },
    async close() { await queue; await handle.close(); },
  };
}

export async function fileFromArgument(argument, defaultDirectory, fileName) {
  if (!argument) return latestArtifact(defaultDirectory, fileName);
  const path = resolve(argument);
  const info = await stat(path);
  return info.isDirectory() ? join(path, fileName) : path;
}

export async function latestArtifact(directory, fileName, isAcceptable = async () => true) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const batchDirectory = join(directory, entry.name);
    const candidate = join(batchDirectory, fileName);
    if (await fileExists(candidate) && await isAcceptable(batchDirectory, candidate)) return candidate;
  }
  throw new Error(`找不到 ${fileName}：${directory}`);
}
