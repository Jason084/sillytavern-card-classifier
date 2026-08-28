#!/usr/bin/env node
/*
 * 第二阶段（020）：只读扫描 SillyTavern Character Card V1/V2/V3。
 *
 * 输入：命令行第一个可选参数为待扫描目录，默认 data/未分类角色卡；
 *       仅递归读取其中的 .png 与 .json 文件。
 * 输出：命令行第二个可选参数为报告根目录，默认 reports/scans；每次扫描新建
 *       一个时间戳批次，包含 index.jsonl（统一索引）、audit.csv
 *       （审计简表）与 summary.json（汇总）。不会修改、移动或删除输入文件。
 */
import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { createBatchDirectory } from './lib/run-files.mjs';
import { isMainModule } from './lib/cli.mjs';
import { extractCard, normalizedCardHash, parseCardFile, warningsFor } from './lib/card-parser.mjs';
import { writeAll } from './lib/report-io.mjs';

export async function main(args = process.argv.slice(2)) {
const root = resolve(import.meta.dirname, '..');
const inputDirectory = resolve(args[0] ?? join(root, 'data', '未分类角色卡'));
const reportsDirectory = resolve(args[1] ?? join(root, 'reports', 'scans'));
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
  let parsed = parseCardFile(bytes, extname(path));
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
}

if (isMainModule(import.meta.url)) await main();
