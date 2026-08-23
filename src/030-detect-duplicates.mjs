#!/usr/bin/env node
/*
 * 第三阶段（030）：基于第二阶段索引生成只读重复检测报告。
 *
 * 输入：命令行第一个可选参数为扫描批次目录或 index.jsonl，默认使用
 *       reports/scans 下最新的完整批次。
 * 输出：命令行第二个可选参数为报告根目录，默认 reports/duplicates；每次运行
 *       新建一个时间戳批次。不会修改、移动或删除角色卡文件。
 */
import { open, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { readJsonlRecords } from './lib/read-jsonl.mjs';
import { cardHashOf } from './lib/card-hash.mjs';
import { createBatchDirectory } from './lib/run-files.mjs';

const root = resolve(import.meta.dirname, '..');
const scansDirectory = join(root, 'reports', 'scans');
const reportsDirectory = resolve(process.argv[3] ?? join(root, 'reports', 'duplicates'));

function csv(values) { return values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',') + '\n'; }
function normalized(value) { return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN'); }
function add(map, key, value) { if (key) map.set(key, [...(map.get(key) ?? []), value]); }
function distinct(items, key) { return new Set(items.map((item) => item[key]).filter(Boolean)); }

async function latestIndex(directory) {
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, 'index.jsonl');
    try {
      const summaryPath = join(directory, entry.name, 'summary.json');
      if ((await stat(path)).isFile() && (await stat(summaryPath)).isFile()) candidates.push(path);
    } catch { /* Ignore incomplete batches. */ }
  }
  candidates.sort((a, b) => basename(dirname(b)).localeCompare(basename(dirname(a))));
  if (!candidates.length) throw new Error(`找不到扫描索引：${directory}`);
  return candidates[0];
}

async function inputIndex(argument) {
  if (!argument) return latestIndex(scansDirectory);
  const path = resolve(argument); const info = await stat(path);
  return info.isDirectory() ? join(path, 'index.jsonl') : path;
}

const indexPath = await inputIndex(process.argv[2]);
await stat(indexPath);
const { runId, batchDirectory } = await createBatchDirectory(reportsDirectory);
const fileHashGroups = new Map(); const cardHashGroups = new Map();
const fileNameGroups = new Map(); const identityGroups = new Map();
let recordsRead = 0; let validCards = 0; let repairedIndexRecords = 0; let invalidIndexRecords = 0;
const indexErrorsHandle = await open(join(batchDirectory, 'index-errors.jsonl'), 'w');

for await (const input of readJsonlRecords(indexPath)) {
  recordsRead += 1;
  if (!input.record) { invalidIndexRecords += 1; await indexErrorsHandle.write(`${JSON.stringify({ start_line: input.start_line, end_line: input.end_line, error: input.error })}\n`); continue; }
  if (input.repaired) repairedIndexRecords += 1; const record = input.record; const cardHash = cardHashOf(record);
  const item = {
    relative_path: record.relative_path, file_name: record.file_name,
    extension: record.extension, size_bytes: record.size_bytes, sha256: record.sha256,
    card_sha256: cardHash.hash, card_hash_source: cardHash.source, status: record.status,
    spec_version: record.card?.spec_version ?? null, name: record.card?.name ?? '',
    creator: record.card?.creator ?? '', character_version: record.card?.character_version ?? '',
  };
  add(fileHashGroups, item.sha256, item);
  add(fileNameGroups, normalized(item.file_name), item);
  if (item.card_sha256) {
    validCards += 1; add(cardHashGroups, item.card_sha256, item);
    const name = normalized(item.name);
    if (name) add(identityGroups, `${name}\u0000${normalized(item.creator)}`, item);
  }
}
await indexErrorsHandle.close();

const groups = [];
for (const [hash, files] of fileHashGroups) if (files.length > 1) groups.push({ type: 'exact_file_duplicate', key: hash, reason: '文件 SHA-256 完全相同', files });
for (const [hash, files] of cardHashGroups) if (files.length > 1 && distinct(files, 'sha256').size > 1) groups.push({ type: 'same_card_different_file', key: hash, reason: '角色内容哈希相同，但文件 SHA-256 不同（通常为封面或 PNG 附加数据不同）', files });
for (const [name, files] of fileNameGroups) if (files.length > 1 && distinct(files, 'sha256').size > 1) groups.push({ type: 'same_filename_different_content', key: name, reason: '文件名相同，但文件内容不同；作为不同版本保留', files });
for (const [identity, files] of identityGroups) if (files.length > 1 && distinct(files, 'card_sha256').size > 1) groups.push({ type: 'suspected_version', key: identity, reason: '规范化角色名与作者相同，但角色内容哈希不同；需人工判断版本关系', files });
groups.sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key));

const jsonlHandle = await open(join(batchDirectory, 'duplicate-groups.jsonl'), 'w');
const csvHandle = await open(join(batchDirectory, 'review.csv'), 'w');
await csvHandle.write(csv(['group_type', 'group_key', 'file_count', 'distinct_file_hashes', 'distinct_card_hashes', 'relative_paths', 'reason']));
const typeCounts = new Map();
for (const group of groups) {
  await jsonlHandle.write(`${JSON.stringify(group)}\n`);
  await csvHandle.write(csv([group.type, group.key, group.files.length, distinct(group.files, 'sha256').size, distinct(group.files, 'card_sha256').size, group.files.map((file) => file.relative_path).join(' | '), group.reason]));
  typeCounts.set(group.type, (typeCounts.get(group.type) ?? 0) + 1);
}
await jsonlHandle.close(); await csvHandle.close();
const countsToArray = (counts) => [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => a.type.localeCompare(b.type));
await writeFile(join(batchDirectory, 'summary.json'), JSON.stringify({
  run_id: runId, generated_utc: new Date().toISOString(), source_index: indexPath,
  records_read: recordsRead, valid_cards: validCards, repaired_index_records: repairedIndexRecords, invalid_index_records: invalidIndexRecords, duplicate_group_count: groups.length,
  group_type_counts: countsToArray(typeCounts), files_are_unchanged: true,
}, null, 2), 'utf8');
console.log(`重复检测完成：${batchDirectory}`);
