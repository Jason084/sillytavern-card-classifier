#!/usr/bin/env node
/*
 * 第六阶段：默认只生成整理计划；只有计划的 approval.json 被明确批准后才执行。
 *
 * 预览：node src/060-organize-character-cards.mjs [分类批次或 classifications.jsonl]
 *       [目标目录] [报告根目录] [--operation=copy|move]
 * 执行：node src/060-organize-character-cards.mjs --execute <计划批次或 plan.jsonl>
 *       [approval.json]
 * 执行前后均核对 SHA-256，且绝不覆盖已有目标文件。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createBatchDirectory, sha256File } from './lib/run-files.mjs';
import { currentProjectDataPath } from './lib/data-paths.mjs';
import { isMainModule, parseOrganizationArguments } from './lib/cli.mjs';
import { csv, readJsonIfPresent } from './lib/report-io.mjs';
import { availableDestination, executeApprovedPlan, isInside, normalizedPath, validatePlanPath } from './lib/organization-plan.mjs';

export async function main(args = process.argv.slice(2)) {
const root = resolve(import.meta.dirname, '..');
const { execute, operation, positionals } = parseOrganizationArguments(args, { allowOperation: true });
const excludedCategory = '排除';
const unresolvedCategory = '未分类';
const nonstandardCategory = '标准外';
if (!['copy', 'move'].includes(operation)) throw new Error('--operation 只能是 copy 或 move');
function currentDataPath(path) { return currentProjectDataPath(root, path); }
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
async function latestCompleteClassificationFile() {
  const roots = [
    join(root, 'reports', 'classification-reviews-052'),
    join(root, 'reports', 'classification-reviews'),
    join(root, 'reports', 'classifications'),
  ];
  for (const directory of roots) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const candidates = entries.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of candidates) {
      const batchDirectory = join(directory, entry.name);
      const classificationsPath = join(batchDirectory, 'classifications.jsonl');
      try { if (!(await stat(classificationsPath)).isFile()) continue; } catch { continue; }
      const run = await readJsonIfPresent(join(batchDirectory, 'run.json'));
      const summary = await readJsonIfPresent(join(batchDirectory, 'summary.json'));
      if (run?.status === 'complete' && summary && (summary.unique_failed_or_incomplete ?? 0) === 0) return classificationsPath;
    }
  }
  throw new Error('找不到完整的 052、051 或 05 分类批次；请显式传入已完成批次');
}
async function fileFromArgument(argument, defaultDirectory, fileName) {
  if (!argument) return latestFile(defaultDirectory, fileName);
  const path = resolve(argument); const info = await stat(path); return info.isDirectory() ? join(path, fileName) : path;
}

async function previewPlan() {
  const classificationsPath = positionals[0]
    ? await fileFromArgument(positionals[0], '', 'classifications.jsonl')
    : await latestCompleteClassificationFile();
  const classificationDirectory = dirname(classificationsPath);
  const summary = JSON.parse(await readFile(join(classificationDirectory, 'summary.json'), 'utf8'));
  const run = await readJsonIfPresent(join(classificationDirectory, 'run.json'));
  if (run && run.status !== 'complete') throw new Error(`分类批次尚未完成（run.json status=${run.status ?? 'missing'}）`);
  if ((summary.unique_failed_or_incomplete ?? 0) !== 0) throw new Error(`分类批次仍有 ${summary.unique_failed_or_incomplete} 个未完成的唯一内容`);
  if (!summary.source_input_directory) throw new Error('分类汇总缺少 source_input_directory，无法确定来源目录');
  const sourceRoot = currentDataPath(summary.source_input_directory);
  const destinationRoot = currentDataPath(positionals[1] ?? join(root, 'data', '已分类角色卡'));
  const reportsRoot = resolve(positionals[2] ?? join(root, 'reports', 'organization-plans'));
  const categoryOwners = new Map();
  for (const category of Array.isArray(summary.categories) ? summary.categories : []) validatedCategory(category, categoryOwners);
  validatedCategory(excludedCategory, categoryOwners);
  validatedCategory(unresolvedCategory, categoryOwners);
  validatedCategory(nonstandardCategory, categoryOwners);
  const allowedCategories = Array.isArray(summary.allowed_categories) ? new Set(summary.allowed_categories) : null;
  const categoryCounts = new Map(); const relativePaths = new Set();
  let classificationsRead = 0; let classifiedCount = 0; let excludedCount = 0; let reviewCount = 0;
  for await (const line of createInterface({ input: createReadStream(classificationsPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const result = JSON.parse(line); classificationsRead += 1;
    if (!result.relative_path || relativePaths.has(result.relative_path)) throw new Error(`分类结果存在空路径或重复路径：${result.relative_path ?? ''}`);
    relativePaths.add(result.relative_path);
    if (!/^[0-9a-f]{64}$/i.test(String(result.sha256 ?? ''))) throw new Error(`分类记录缺少有效文件哈希：${result.relative_path}`);
    if (result.model_decision === 'exclude') {
      if (result.needs_review !== true) throw new Error(`排除记录未保留复核标记：${result.relative_path}`);
      excludedCount += 1; continue;
    }
    if (result.model_decision === 'review') {
      if (result.needs_review !== true) throw new Error(`未决记录未保留复核标记：${result.relative_path}`);
      reviewCount += 1; continue;
    }
    if (result.model_decision !== 'classify' || result.needs_review !== false || !result.category || String(result.category).startsWith('__')) {
      throw new Error(`分类记录状态不一致，不能安全整理：${result.relative_path}`);
    }
    const category = String(result.category).trim();
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1); classifiedCount += 1;
  }
  if (summary.source_file_records != null && summary.source_file_records !== classificationsRead) {
    throw new Error(`分类记录数不完整：summary=${summary.source_file_records}，实际=${classificationsRead}`);
  }
  const outsideCategories = allowedCategories
    ? [...categoryCounts].filter(([category]) => !allowedCategories.has(category))
    : [];
  const nonstandardCount = outsideCategories.reduce((total, [, count]) => total + count, 0);
  if (classifiedCount + excludedCount + reviewCount !== classificationsRead) throw new Error('分类决定计数不一致');
  const sourceClassificationsSha256 = await sha256File(classificationsPath);
  const { runId, batchDirectory } = await createBatchDirectory(reportsRoot);
  const planPath = join(batchDirectory, 'plan.jsonl'); const planHandle = await open(planPath, 'w');
  const csvHandle = await open(join(batchDirectory, 'plan.csv'), 'w'); const planHash = createHash('sha256');
  await csvHandle.write(csv(['operation', 'model_decision', 'category', 'original_category', 'source_path', 'destination_path', 'sha256', 'status', 'detail']));
  const allocated = new Set(); let planned = 0; let missingSources = 0;
  for await (const line of createInterface({ input: createReadStream(classificationsPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue; const result = JSON.parse(line);
    const sourcePath = resolve(sourceRoot, result.relative_path);
    if (!isInside(sourcePath, sourceRoot)) throw new Error(`来源相对路径越界：${result.relative_path}`);
    const isNonstandard = result.model_decision === 'classify' && allowedCategories && !allowedCategories.has(result.category);
    const outputCategory = result.model_decision === 'classify'
      ? isNonstandard ? nonstandardCategory : result.category
      : result.model_decision === 'exclude' ? excludedCategory : unresolvedCategory;
    const category = validatedCategory(outputCategory, categoryOwners); const initialDestination = join(destinationRoot, category, basename(result.file_name ?? result.relative_path));
    const destinationPath = await availableDestination(initialDestination, result.sha256, allocated, { rejectExisting: true });
    let status = 'planned'; let detail = '';
    try { if (!(await stat(sourcePath)).isFile()) throw new Error('不是普通文件'); }
    catch (error) { status = 'source_missing'; detail = error.message; missingSources += 1; }
    const record = { operation, category, relative_path: result.relative_path, source_path: sourcePath, destination_path: destinationPath,
      sha256: result.sha256, card_sha256: result.card_sha256, classification_source: result.classification_source,
      model_decision: result.model_decision, original_category: result.category, status, detail };
    const output = `${JSON.stringify(record)}\n`; planHash.update(output); await planHandle.write(output);
    await csvHandle.write(csv([operation, result.model_decision, category, result.category, sourcePath, destinationPath, result.sha256, status, detail])); planned += 1;
  }
  await planHandle.close(); await csvHandle.close(); const planSha256 = planHash.digest('hex');
  const approval = { plan_run_id: runId, approved: false, operation, destination_root: destinationRoot, plan_sha256: planSha256,
    source_classifications_sha256: sourceClassificationsSha256,
    instruction: '人工检查 plan.csv 后，将 approved 改为 true；然后使用 --execute 参数执行本批次。' };
  await writeFile(join(batchDirectory, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8');
  await writeFile(join(batchDirectory, 'summary.json'), JSON.stringify({ run_id: runId, generated_utc: new Date().toISOString(), source_classifications: classificationsPath,
    source_classifications_sha256: sourceClassificationsSha256, source_root: sourceRoot, destination_root: destinationRoot, operation,
    classifications_read: classificationsRead, files_classified: classifiedCount, files_to_standard_categories: classifiedCount - nonstandardCount,
    files_to_nonstandard_folder: nonstandardCount, nonstandard_category_counts: outsideCategories.map(([category, count]) => ({ category, count })),
    files_to_excluded_folder: excludedCount,
    files_to_unclassified_folder: reviewCount, files_planned: planned, missing_sources: missingSources,
    plan_sha256: planSha256, executed: false }, null, 2), 'utf8');
  console.log(`整理预览计划已生成：${batchDirectory}`);
}

async function executePlan() {
  const planPath = await fileFromArgument(positionals[0], join(root, 'reports', 'organization-plans'), 'plan.jsonl');
  const batchDirectory = dirname(planPath);
  const approvalPath = resolve(positionals[1] ?? join(batchDirectory, 'approval.json'));
  const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  const logPath = await executeApprovedPlan({
    planPath,
    approval,
    batchDirectory,
    allowedOperations: ['copy', 'move'],
    mapPath: currentDataPath,
    approvalError: '计划尚未批准：请先人工检查 plan.csv，再将 approval.json 中的 approved 改为 true',
    operationError: '批准文件中的 operation 无效',
    includeOperationInLog: true,
    validatePlan({ plan, approval: approved, sourcePath, destinationPath, destinationRoot }) {
      if (plan.status !== 'planned') throw new Error(`计划状态为 ${plan.status}`);
      if (plan.operation !== approved.operation) throw new Error('单条计划的操作类型与批准文件不一致');
      if (!isAbsolute(plan.source_path) || !isAbsolute(plan.destination_path) || !validatePlanPath(sourcePath, destinationPath, destinationRoot)) throw new Error('目标路径越界');
    },
  });
  console.log(`整理计划执行完成：${logPath}`);
}
if (execute) await executePlan(); else await previewPlan();
}

if (isMainModule(import.meta.url)) await main();
