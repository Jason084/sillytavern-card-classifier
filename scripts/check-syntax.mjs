import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function JavaScriptFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await JavaScriptFiles(path));
    else if (entry.name.endsWith('.mjs')) output.push(path);
  }
  return output;
}

const files = [...await JavaScriptFiles(join(root, 'src')), ...await JavaScriptFiles(join(root, 'test'))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}
console.log(`Syntax OK: ${files.length} files`);
