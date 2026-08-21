#!/usr/bin/env node
/*
 * 第二阶段：只读扫描 SillyTavern Character Card V1/V2/V3。
 *
 * 输入：命令行第一个可选参数为待扫描目录，默认 data/角色卡/未分类；
 *       仅递归读取其中的 .png 与 .json 文件。
 * 输出：命令行第二个可选参数为报告根目录，默认 reports/scans；每次扫描新建
 *       一个时间戳批次，包含 index.jsonl（统一索引）、audit.csv
 *       （审计简表）与 summary.json（汇总）。不会修改、移动或删除输入文件。
 */
import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { createBatchDirectory } from './lib/run-files.mjs';

const root = resolve(import.meta.dirname, '..');
const inputDirectory = resolve(process.argv[2] ?? join(root, 'data', '角色卡', '未分类'));
const reportsDirectory = resolve(process.argv[3] ?? join(root, 'reports', 'scans'));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const V1_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function string(value, fallback = '') { return value == null ? fallback : typeof value === 'string' ? value : String(value); }
function array(value) {
  if (value == null) return [];
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return Array.isArray(value) ? value.map(String) : [];
}

async function writeAll(handle, text) {
  const bytes = Buffer.from(text); let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw new Error('report write returned zero bytes');
    offset += bytesWritten;
  }
}

function normalizedCardHash(card) {
  const ignoredKeys = new Set(['creation_date', 'modification_date', 'create_date']);
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.keys(value).filter((key) => !ignoredKeys.has(key)).sort().map((key) => [key, normalize(value[key])]));
  };
  return createHash('sha256').update(JSON.stringify(normalize(card))).digest('hex');
}

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function versionOf(card) {
  if (!isObject(card)) return null;
  if (card.spec === 'chara_card_v2') return 2;
  if (card.spec === 'chara_card_v3') return 3;
  return !has(card, 'spec') && V1_FIELDS.every((field) => has(card, field)) ? 1 : null;
}

// This mapping intentionally mirrors SillyInnkeeper's CardDataExtractor.
function extractCard(card, version) {
  const data = version === 1 ? card : card.data;
  if (!isObject(data)) throw new Error('supported card has no object-valued data field');
  let creatorNotes = version === 1 ? string(data.creator_notes ?? data.creatorcomment) : string(data.creator_notes);
  if (version === 3 && isObject(data.creator_notes_multilingual)) {
    creatorNotes = typeof data.creator_notes_multilingual.en === 'string'
      ? data.creator_notes_multilingual.en
      : typeof data.creator_notes_multilingual.creator_notes === 'string'
        ? data.creator_notes_multilingual.creator_notes : creatorNotes;
  }
  return {
    spec_version: `${version}.0`, name: string(data.name), description: string(data.description),
    personality: string(data.personality), scenario: string(data.scenario), first_mes: string(data.first_mes),
    mes_example: string(data.mes_example), fav: typeof card.fav === 'boolean' ? card.fav : false,
    creator_notes: creatorNotes, system_prompt: version === 1 ? '' : string(data.system_prompt),
    post_history_instructions: version === 1 ? '' : string(data.post_history_instructions),
    alternate_greetings: array(data.alternate_greetings), tags: array(data.tags), creator: string(data.creator),
    character_version: string(data.character_version),
    group_only_greetings: version === 3 ? array(data.group_only_greetings) : null,
    nickname: version === 3 ? string(data.nickname) : null,
    character_book: version === 1 ? null : (data.character_book ?? null),
    extensions: isObject(data.extensions) ? data.extensions : null,
  };
}

function warningsFor(card, version) {
  const data = version === 1 ? card : card.data;
  const warnings = [];
  if (!isObject(data)) return ['data is missing or is not an object'];
  for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'creator', 'character_version', 'system_prompt', 'post_history_instructions']) {
    if (data[field] != null && typeof data[field] !== 'string') warnings.push(`${field} is not a string`);
  }
  for (const field of ['tags', 'alternate_greetings', ...(version === 3 ? ['group_only_greetings'] : [])]) {
    if (data[field] != null && typeof data[field] !== 'string' && !Array.isArray(data[field])) warnings.push(`${field} is neither a string nor an array`);
  }
  return warnings;
}

function decodeMetadata(text) {
  const bytes = Buffer.from(text, 'base64');
  // Buffer.from is permissive, so reject non-base64 input before JSON decoding.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('invalid Base64');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(raw);
}

function parsePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { status: 'invalid_png', detail: 'PNG signature is missing or invalid' };
  let offset = 8; let sawIend = false; const chunks = [];
  while (offset < buffer.length) {
    if (buffer.length - offset < 12) return { status: 'corrupt_png', detail: 'PNG chunk header or CRC is truncated' };
    const length = buffer.readUInt32BE(offset); offset += 4;
    if (length > buffer.length - offset - 8) return { status: 'corrupt_png', detail: 'PNG chunk length exceeds remaining file data' };
    const typeOffset = offset; const type = buffer.toString('ascii', offset, offset + 4); offset += 4;
    const data = buffer.subarray(offset, offset + length);
    const expectedCrc = buffer.readUInt32BE(offset + length); const actualCrc = crc32(buffer, typeOffset, offset + length);
    if (actualCrc !== expectedCrc) return { status: 'corrupt_png', detail: `PNG ${type} chunk CRC does not match` };
    offset += length + 4;
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0 && nul < data.length - 1) {
        const keyword = data.toString('ascii', 0, nul).toLowerCase();
        if (keyword === 'ccv3' || keyword === 'chara') chunks.push({ keyword, text: data.toString('latin1', nul + 1) });
      }
    }
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIend) return { status: 'corrupt_png', detail: 'PNG IEND chunk is missing' };
  if (!chunks.length) return { status: 'no_card_metadata', detail: 'No chara or ccv3 tEXt chunk exists' };
  let decodedAny = false;
  for (const keyword of ['ccv3', 'chara']) for (const chunk of chunks.filter((item) => item.keyword === keyword)) {
    try {
      const card = decodeMetadata(chunk.text); decodedAny = true;
      const version = versionOf(card);
      if (version) return { status: 'ok', card, version, metadata_chunk: keyword };
    } catch { /* Try the next metadata chunk, as the reference parser does. */ }
  }
  return decodedAny
    ? { status: 'unsupported_card_spec', detail: 'Metadata is readable but does not match supported V1, V2, or V3 card structures' }
    : { status: 'metadata_decode_failed', detail: 'chara/ccv3 metadata could not be Base64- and JSON-decoded' };
}

function parseJson(buffer) {
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer); const card = JSON.parse(raw); const version = versionOf(card);
    return version ? { status: 'ok', card, version, metadata_chunk: null }
      : { status: 'unsupported_card_spec', detail: 'JSON is readable but does not match supported V1, V2, or V3 card structures' };
  } catch (error) { return { status: 'json_decode_failed', detail: error.message }; }
}

async function listFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(path));
    else if (entry.isFile() && ['.png', '.json'].includes(extname(entry.name).toLowerCase())) output.push(path);
  }
  return output;
}

await stat(inputDirectory);
const { runId, batchDirectory } = await createBatchDirectory(reportsDirectory);
const indexHandle = await open(join(batchDirectory, 'index.jsonl'), 'w');
const auditHandle = await open(join(batchDirectory, 'audit.csv'), 'w');
const statusCounts = new Map(); const specVersionCounts = new Map(); let filesScanned = 0;
await writeAll(auditHandle, 'status,spec_version,file_sha256,card_sha256,relative_path,detail\n');
for (const path of await listFiles(inputDirectory)) {
  const file = await stat(path); const bytes = await readFile(path);
  let parsed = extname(path).toLowerCase() === '.png' ? parsePng(bytes) : parseJson(bytes);
  const record = { relative_path: relative(inputDirectory, path), file_name: basename(path), extension: extname(path).toLowerCase(), size_bytes: file.size, created_utc: file.birthtime.toISOString(), modified_utc: file.mtime.toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'), card_sha256: parsed.status === 'ok' ? normalizedCardHash(parsed.card) : null, status: parsed.status === 'ok' ? 'valid' : parsed.status, detail: parsed.detail ?? null, metadata_chunk: parsed.metadata_chunk ?? null };
  if (parsed.status === 'ok') {
    try { record.card = extractCard(parsed.card, parsed.version); record.warnings = warningsFor(parsed.card, parsed.version); if (record.warnings.length) record.status = 'valid_with_warnings'; }
    catch (error) { record.status = 'unsupported_card_spec'; record.detail = error.message; }
  }
  await writeAll(indexHandle, `${JSON.stringify(record)}\n`);
  await writeAll(auditHandle, [record.status, record.card?.spec_version ?? '', record.sha256, record.card_sha256 ?? '', record.relative_path, record.detail ?? ''].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',') + '\n');
  statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
  if (record.card) specVersionCounts.set(record.card.spec_version, (specVersionCounts.get(record.card.spec_version) ?? 0) + 1);
  filesScanned += 1;
}
await indexHandle.close(); await auditHandle.close();
const countsToArray = (counts, label) => [...counts.entries()].map(([name, count]) => ({ [label]: name, count })).sort((a, b) => String(a[label]).localeCompare(String(b[label])));
await writeFile(join(batchDirectory, 'summary.json'), JSON.stringify({ run_id: runId, generated_utc: new Date().toISOString(), input_directory: inputDirectory, files_scanned: filesScanned, status_counts: countsToArray(statusCounts, 'status'), spec_version_counts: countsToArray(specVersionCounts, 'spec_version') }, null, 2), 'utf8');
console.log(`扫描完成：${batchDirectory}`);
