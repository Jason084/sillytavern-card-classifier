#!/usr/bin/env node
/*
 * 第六阶段：默认只生成整理计划；只有计划的 approval.json 被明确批准后才执行。
 *
 * 预览：node src/06-organize-character-cards.mjs [分类批次或 classifications.jsonl]
 *       [目标目录] [报告根目录] [--operation=copy|move]
 * 执行：node src/06-organize-character-cards.mjs --execute <计划批次或 plan.jsonl>
 *       [approval.json]
 * 执行前后均核对 SHA-256，且绝不覆盖已有目标文件。
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { createBatchDirectory, newRunId, sha256File } from './lib/run-files.mjs';

const root = resolve(import.meta.dirname, '..');
const rawArguments = process.argv.slice(2); const execute = rawArguments.includes('--execute');
const operationArgument = rawArguments.find((argument) => argument.startsWith('--operation='));
const operation = operationArgument?.slice('--operation='.length) ?? 'copy';
const positionals = rawArguments.filter((argument) => argument !== '--execute' && !argument.startsWith('--operation='));
if (!['copy', 'move'].includes(operation)) throw new Error('--operation 只能是 copy 或 move');
function csv(values) { return values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',') + '\n'; }
function normalizedPath(path) { return resolve(path).toLocaleLowerCase('en-US'); }
function isInside(path, directory) { const target = normalizedPath(path); const parent = normalizedPath(directory); return target === parent || target.startsWith(`${parent}${sep.toLocaleLowerCase('en-US')}`); }
function safeCategory(value) {
  const output = String(value ?? '').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!output || output === '.' || output === '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(output)) {
    throw new Error(`无效分类目录名：${value}`);
  }
  return output;
}
function validatedCategory(value, owners) {
  const original = String(value ?? '').trim(); const output = safeCategory(original);
  const key = output.toLocaleLowerCase('en-US'); const previous = owners.get(key);
  if (previous && previous !== original) throw new Error(`分类目录名冲突：“${previous}”和“${original}”都会写入“${output}”`);
  owners.set(key, original); return output;
}

async function latestFile(directory, fileName) {
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, fileName);
    try { if ((await stat(path)).isFile()) candidates.push(path); } catch { /* Ignore incomplete batches. */ }
  }
  candidates.sort((a, b) => basename(dirname(b)).localeCompare(basename(dirname(a))));
  if (!candidates.length) throw new Error(`找不到 ${fileName}：${directory}`); return candidates[0];
}
async function fileFromArgument(argument, defaultDirectory, fileName) {
  if (!argument) return latestFile(defaultDirectory, fileName);
  const path = resolve(argument); const info = await stat(path); return info.isDirectory() ? join(path, fileName) : path;
}
async function availableDestination(initialPath, fileHash, allocated) {
  const extension = extname(initialPath); const stem = basename(initialPath, extension); const directory = dirname(initialPath);
  let candidate = initialPath; let number = 1;
  while (allocated.has(normalizedPath(candidate)) || await stat(candidate).then(() => true, () => false)) {
    const suffix = number === 1 ? `__${fileHash.slice(0, 12)}` : `__${fileHash.slice(0, 12)}-${number}`;
    candidate = join(directory, `${stem}${suffix}${extension}`); number += 1;
  }
  allocated.add(normalizedPath(candidate)); return candidate;
}

async function previewPlan() {
  const classificationsPath = await fileFromArgument(positionals[0], join(root, 'reports', 'classifications'), 'classifications.jsonl');
  const classificationDirectory = dirname(classificationsPath); const summary = JSON.parse(await readFile(join(classificationDirectory, 'summary.json'), 'utf8'));
  const sourceRoot = resolve(summary.source_input_directory ?? join(root, 'data', '角色卡', '未分类'));
  const destinationRoot = resolve(positionals[1] ?? join(root, 'data', '角色卡', '已分类'));
  const reportsRoot = resolve(positionals[2] ?? join(root, 'reports', 'organization-plans'));
  const categoryOwners = new Map();
  for (const category of Array.isArray(summary.categories) ? summary.categories : []) validatedCategory(category, categoryOwners);
  const { runId, batchDirectory } = await createBatchDirectory(reportsRoot);
  const planPath = join(batchDirectory, 'plan.jsonl'); const planHandle = await open(planPath, 'w');
  const csvHandle = await open(join(batchDirectory, 'plan.csv'), 'w'); const planHash = createHash('sha256');
  await csvHandle.write(csv(['operation', 'category', 'source_path', 'destination_path', 'sha256', 'status', 'detail']));
  const allocated = new Set(); let classificationsRead = 0; let planned = 0; let skippedReview = 0; let missingSources = 0;
  for await (const line of createInterface({ input: createReadStream(classificationsPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue; const result = JSON.parse(line); classificationsRead += 1;
    if (result.needs_review || !result.category || String(result.category).startsWith('__')) { skippedReview += 1; continue; }
    const sourcePath = resolve(sourceRoot, result.relative_path);
    if (!isInside(sourcePath, sourceRoot)) throw new Error(`来源相对路径越界：${result.relative_path}`);
    const category = validatedCategory(result.category, categoryOwners); const initialDestination = join(destinationRoot, category, basename(result.file_name ?? result.relative_path));
    const destinationPath = await availableDestination(initialDestination, result.sha256, allocated);
    let status = 'planned'; let detail = '';
    try { if (!(await stat(sourcePath)).isFile()) throw new Error('不是普通文件'); }
    catch (error) { status = 'source_missing'; detail = error.message; missingSources += 1; }
    const record = { operation, category, relative_path: result.relative_path, source_path: sourcePath, destination_path: destinationPath,
      sha256: result.sha256, card_sha256: result.card_sha256, classification_source: result.classification_source,
      confidence: result.confidence, status, detail };
    const output = `${JSON.stringify(record)}\n`; planHash.update(output); await planHandle.write(output);
    await csvHandle.write(csv([operation, category, sourcePath, destinationPath, result.sha256, status, detail])); planned += 1;
  }
  await planHandle.close(); await csvHandle.close(); const planSha256 = planHash.digest('hex');
  const approval = { plan_run_id: runId, approved: false, operation, destination_root: destinationRoot, plan_sha256: planSha256,
    instruction: '人工检查 plan.csv 后，将 approved 改为 true；然后使用 --execute 参数执行本批次。' };
  await writeFile(join(batchDirectory, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8');
  await writeFile(join(batchDirectory, 'summary.json'), JSON.stringify({ run_id: runId, generated_utc: new Date().toISOString(), source_classifications: classificationsPath,
    source_root: sourceRoot, destination_root: destinationRoot, operation, classifications_read: classificationsRead, files_planned: planned,
    skipped_needing_review: skippedReview, missing_sources: missingSources, plan_sha256: planSha256, executed: false }, null, 2), 'utf8');
  console.log(`整理预览计划已生成：${batchDirectory}`);
}

async function executePlan() {
  const planPath = await fileFromArgument(positionals[0], join(root, 'reports', 'organization-plans'), 'plan.jsonl');
  const batchDirectory = dirname(planPath); const approvalPath = resolve(positionals[1] ?? join(batchDirectory, 'approval.json'));
  const approval = JSON.parse(await readFile(approvalPath, 'utf8')); const actualPlanHash = await sha256File(planPath);
  if (approval.approved !== true) throw new Error('计划尚未批准：请先人工检查 plan.csv，再将 approval.json 中的 approved 改为 true');
  if (approval.plan_sha256 !== actualPlanHash) throw new Error('计划哈希与批准文件不一致，拒绝执行');
  if (!['copy', 'move'].includes(approval.operation)) throw new Error('批准文件中的 operation 无效');
  const destinationRoot = resolve(approval.destination_root); const executionRunId = newRunId(); const logPath = join(batchDirectory, `execution-${executionRunId}.jsonl`);
  const logHandle = await open(logPath, 'wx'); const csvHandle = await open(join(batchDirectory, `execution-${executionRunId}.csv`), 'wx');
  await csvHandle.write(csv(['executed_utc', 'operation', 'source_path', 'destination_path', 'sha256', 'result', 'detail']));
  const counts = new Map(); let recordsRead = 0;
  for await (const line of createInterface({ input: createReadStream(planPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue; const plan = JSON.parse(line); recordsRead += 1;
    let result = 'skipped'; let detail = '';
    try {
      if (plan.status !== 'planned') throw new Error(`计划状态为 ${plan.status}`);
      if (plan.operation !== approval.operation) throw new Error('单条计划的操作类型与批准文件不一致');
      if (!isAbsolute(plan.source_path) || !isAbsolute(plan.destination_path) || !isInside(plan.destination_path, destinationRoot) || normalizedPath(plan.destination_path) === normalizedPath(destinationRoot)) throw new Error('目标路径越界');
      const sourceHash = await sha256File(plan.source_path); if (sourceHash !== plan.sha256) throw new Error('来源文件已变化，SHA-256 不匹配');
      try { await stat(plan.destination_path); throw new Error('目标文件已存在，拒绝覆盖'); } catch (error) { if (error.message === '目标文件已存在，拒绝覆盖') throw error; if (error.code !== 'ENOENT') throw error; }
      await mkdir(dirname(plan.destination_path), { recursive: true });
      await copyFile(plan.source_path, plan.destination_path, constants.COPYFILE_EXCL);
      const destinationHash = await sha256File(plan.destination_path);
      if (destinationHash !== plan.sha256) { await unlink(plan.destination_path); throw new Error('复制后哈希校验失败，已删除不完整目标文件'); }
      if (approval.operation === 'move') await unlink(plan.source_path);
      result = approval.operation === 'move' ? 'moved' : 'copied';
    } catch (error) { result = 'failed'; detail = error.message; }
    const executedUtc = new Date().toISOString(); const record = { executed_utc: executedUtc, operation: approval.operation, source_path: plan.source_path,
      destination_path: plan.destination_path, sha256: plan.sha256, result, detail };
    await logHandle.write(`${JSON.stringify(record)}\n`); await csvHandle.write(csv([executedUtc, approval.operation, plan.source_path, plan.destination_path, plan.sha256, result, detail]));
    counts.set(result, (counts.get(result) ?? 0) + 1);
  }
  await logHandle.close(); await csvHandle.close();
  await writeFile(join(batchDirectory, `execution-summary-${executionRunId}.json`), JSON.stringify({ plan_run_id: approval.plan_run_id, executed_utc: new Date().toISOString(),
    plan_sha256: actualPlanHash, records_read: recordsRead, result_counts: [...counts.entries()].map(([result, count]) => ({ result, count })) }, null, 2), 'utf8');
  console.log(`整理计划执行完成：${logPath}`);
}

if (execute) await executePlan(); else await previewPlan();
