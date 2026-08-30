import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(join(root, '分类标准.md'));
const translation = await readFile(join(root, 'docs', 'classification-standard.en.md'), 'utf8');
const actual = createHash('sha256').update(source).digest('hex');
const match = translation.match(/^Source SHA-256: `([0-9a-f]{64})`$/mu);
if (!match) throw new Error('English policy translation is missing the source SHA-256 marker');
if (match[1] !== actual) throw new Error(`English policy translation is stale: expected ${actual}, found ${match[1]}`);
console.log(`Policy translation matches ${actual}`);
