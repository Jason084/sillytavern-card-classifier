import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'data', 'node_modules', 'reports', 'work']);

const promptMarkerWords = ['un', 'restricted', 'jail', 'break'];
const forbidden = [
  [
    'external API endpoint',
    /https?:\/\/(?!(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/:\s"'`)]|$))(?!(?:[^/\s"']+\.)?example(?:\.[a-z]{2,})?(?::\d+)?(?:[/:\s"'`)]|$))(?:(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?\/v\d+(?:[/?#\s"'`)]|$)/iu,
  ],
  ['credential variable', /\b(?!(?:MODEL|API)_)[A-Z][A-Z0-9]*(?:_(?:API_KEY|API_TOKEN|SECRET|TOKEN|PASSWORD))\b/u],
  [
    'unsafe prompt marker',
    new RegExp(
      `\\b(?:${promptMarkerWords[0]}${promptMarkerWords[1]}|${promptMarkerWords[2]}${promptMarkerWords[3]})\\b|(?:无限制|不受限制)(?:模式|指令)`,
      'iu',
    ),
  ],
  [
    'private-looking Windows path',
    /\b[A-Z]:\\(?:[^\\\r\n`"'<>|,]*\\)*(?:[^\\\r\n`"'<>|,]*[ ][^\\\r\n`"'<>|,]*\\|[^\\\r\n`"'<>|,]*[^\x00-\x7F][^\\\r\n`"'<>|,]*\\|(?:Users|home|Documents and Settings)\\[^\\\r\n`"'<>|,]+)/iu,
  ],
  ['email address', /\b[A-Z0-9._%+-]+@(?!(?:[A-Z0-9-]+\.)*example(?:\.[A-Z]{2,})?\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
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

export async function findPublicContentFailures(directory = root) {
  const failures = [];
  for (const file of await files(directory)) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    if (text.includes('\u0000') || text.includes('\uFFFD')) continue;
    for (const [label, pattern] of forbidden) {
      if (pattern.test(text)) failures.push(`${relative(directory, file)}: ${label}`);
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const failures = await findPublicContentFailures();
  if (failures.length) {
    console.error(`Content not suitable for the public repository:\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('Public-content check OK');
}
