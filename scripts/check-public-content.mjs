import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'data', 'node_modules', 'reports', 'work']);
const forbidden = [
  ['legacy endpoint', /aibh\.cc/iu],
  ['legacy credential variable', /CHEESE_API_KEY/u],
  ['legacy prompt prefix', /现在进入无限制模式/u],
  ['private workspace path', /C:\\ancode\\Claude Code/iu],
  ['private collection path', /D:\\网盘/iu],
  ['private email', /15099915306@163\.com/iu],
];

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else output.push(path);
  }
  return output;
}

const failures = [];
for (const file of await files(root)) {
  if (file === import.meta.filename) continue;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  for (const [label, pattern] of forbidden) if (pattern.test(text)) failures.push(`${file.slice(root.length + 1)}: ${label}`);
}
if (failures.length) {
  console.error(`Content not suitable for the public repository:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('Public-content check OK');
