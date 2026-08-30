import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'data', 'node_modules', 'reports', 'work']);

async function markdownFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await markdownFiles(path));
    else if (entry.name.endsWith('.md')) output.push(path);
  }
  return output;
}

const failures = [];
for (const file of await markdownFiles(root)) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    let target = match[1].trim().replace(/^<|>$/gu, '');
    if (!target || /^(?:https?:|mailto:|#)/iu.test(target)) continue;
    target = decodeURIComponent(target.split('#', 1)[0]);
    try { await access(resolve(dirname(file), target)); }
    catch { failures.push(`${file.slice(root.length + 1)} -> ${target}`); }
  }
}
if (failures.length) {
  console.error(`Broken Markdown links:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('Markdown links OK');
