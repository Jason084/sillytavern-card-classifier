#!/usr/bin/env node
/*
 * 第八阶段：根据第七阶段的选择性分组结果生成完整目录树。
 * 仅同人作品/IP和特殊一级目录允许增加一层；其他普通类别保持一级目录。
 * 默认仅生成 copy 计划；approval.json 明确批准后才执行，且绝不覆盖目标文件。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createBatchDirectory, sha256File } from './lib/run-files.mjs';
import { REFINEMENT_SCOPE, refinementMode, validDirectoryName } from './lib/refinement.mjs';
import { isMainModule, parseOrganizationArguments } from './lib/cli.mjs';
import { csv, fileExists as exists, readJsonIfPresent } from './lib/report-io.mjs';
import { availableDestination, executeApprovedPlan, isInside, normalizedPath, targetRootMustBeEmpty, validatePlanPath } from './lib/organization-plan.mjs';

export async function main(args = process.argv.slice(2)) {
const root = resolve(import.meta.dirname, '..');
const { execute, positionals } = parseOrganizationArguments(args);

async function fileFromArgument(argument, defaultDirectory, fileName) {
  if (!argument) {
    const entries = await readdir(defaultDirectory, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const candidate = join(defaultDirectory, entry.name, fileName); const run = await readJsonIfPresent(join(defaultDirectory, entry.name, 'run.json'));
      if (run?.status === 'complete' && await exists(candidate)) return candidate;
    }
    throw new Error(`找不到完整的 ${fileName}：${defaultDirectory}`);
  }
  const path = resolve(argument); const info = await stat(path); return info.isDirectory() ? join(path, fileName) : path;
}
function validatedName(value, owners, kind) {
  const original = String(value ?? '').trim(); const output = validDirectoryName(original);
  if (!output) throw new Error(`无效${kind}目录名：${value}`);
  const key = output.toLocaleLowerCase('en-US'); const previous = owners.get(key);
  if (previous && previous !== original) throw new Error(`${kind}目录名冲突：“${previous}”和“${original}”`);
  owners.set(key, original); return output;
}
async function resolveOrganizedSource(sourceRoot, record) {
  const parent = validDirectoryName(record.parent_category); if (!parent) throw new Error(`无效一级目录：${record.parent_category}`);
  const directory = join(sourceRoot, parent); const originalName = basename(record.file_name ?? record.relative_path); const exact = join(directory, originalName);
  if (await exists(exact) && await sha256File(exact) === record.sha256) return exact;
  const extension = extname(originalName); const stem = basename(originalName, extension); const prefix = `${stem}__${String(record.sha256).slice(0, 12)}`.toLocaleLowerCase('en-US');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { throw new Error(`来源一级目录不存在：${directory}（${error.message}）`); }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const candidateStem = basename(entry.name, extname(entry.name)).toLocaleLowerCase('en-US');
    if (!candidateStem.startsWith(prefix)) continue;
    const candidate = join(directory, entry.name); if (await sha256File(candidate) === record.sha256) return candidate;
  }
  throw new Error(`找不到与哈希匹配的一级分类副本：${record.relative_path}`);
}

async function previewPlan() {
  const refinementsPath = await fileFromArgument(positionals[0], join(root, 'reports', 'refinements'), 'refinements.jsonl'); const refinementDirectory = dirname(refinementsPath);
  const summary = JSON.parse(await readFile(join(refinementDirectory, 'summary.json'), 'utf8')); const run = await readJsonIfPresent(join(refinementDirectory, 'run.json'));
  if (run?.status !== 'complete' || summary.status !== 'complete' || (summary.unique_failed_or_incomplete ?? 0) !== 0) throw new Error('只能整理完整的二次分类批次');
  if (run.refinement_scope !== REFINEMENT_SCOPE || summary.refinement_scope !== REFINEMENT_SCOPE) throw new Error('070 批次不是当前“同人作品/IP与特殊目录辅助分组”范围，拒绝整理');
  const sourceRoot = resolve(positionals[1] ?? join(root, 'data', '已分类角色卡')); const destinationRoot = resolve(positionals[2] ?? join(root, 'data', '二次分类角色卡')); const reportsRoot = resolve(positionals[3] ?? join(root, 'reports', 'refinement-plans'));
  if (normalizedPath(sourceRoot) === normalizedPath(destinationRoot) || isInside(destinationRoot, sourceRoot)) throw new Error('二次分类目标不能与一级分类来源相同或位于其内部');
  await targetRootMustBeEmpty(destinationRoot);
  const refinementSha256 = await sha256File(refinementsPath); const records = []; const relativePaths = new Set(); const parentOwners = new Map(); const subcategoryOwners = new Map();
  for await (const line of createInterface({ input: createReadStream(refinementsPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue; const record = JSON.parse(line);
    if (!record.relative_path || relativePaths.has(record.relative_path)) throw new Error(`二次分类结果存在空路径或重复路径：${record.relative_path ?? ''}`);
    if (!/^[0-9a-f]{64}$/iu.test(String(record.sha256 ?? ''))) throw new Error(`二次分类记录缺少有效文件哈希：${record.relative_path}`);
    const parent = validatedName(record.parent_category, parentOwners, '一级');
    const mode = refinementMode(parent);
    if (typeof record.selected_for_refinement !== 'boolean') throw new Error(`二次分类记录缺少有效范围标记：${record.relative_path}`);
    let subcategory = null;
    if (record.selected_for_refinement === true) {
      if (!mode) throw new Error(`普通一级目录不得生成二级目录：${parent}`);
      if (!record.subcategory) throw new Error(`超阈值记录缺少二级类别：${record.relative_path}`);
      const owners = subcategoryOwners.get(parent) ?? new Map(); subcategory = validatedName(record.subcategory, owners, `${parent}的二级`); subcategoryOwners.set(parent, owners);
    } else if (record.subcategory != null) throw new Error(`未触发二次分类的记录不应带二级类别：${record.relative_path}`);
    relativePaths.add(record.relative_path); records.push({ ...record, parent, mode, subcategory });
  }
  if (records.length !== summary.source_file_records) throw new Error(`二次分类记录数不完整：summary=${summary.source_file_records}，实际=${records.length}`);
  const { runId, batchDirectory } = await createBatchDirectory(reportsRoot); const planPath = join(batchDirectory, 'plan.jsonl'); const planHandle = await open(planPath, 'w'); const csvHandle = await open(join(batchDirectory, 'plan.csv'), 'w'); const planHash = createHash('sha256');
  await csvHandle.write(csv(['operation', 'parent_category', 'subcategory', 'source_path', 'destination_path', 'sha256', 'status', 'detail']));
  const allocated = new Set(); const counts = new Map(); let missingSources = 0;
  for (const record of records) {
    let sourcePath = ''; let status = 'planned'; let detail = '';
    try { sourcePath = await resolveOrganizedSource(sourceRoot, record); }
    catch (error) { status = 'source_missing_or_changed'; detail = error.message; missingSources += 1; sourcePath = join(sourceRoot, record.parent, basename(record.file_name ?? record.relative_path)); }
    const directory = record.subcategory ? join(destinationRoot, record.parent, record.subcategory) : join(destinationRoot, record.parent); const initialDestination = join(directory, basename(record.file_name ?? record.relative_path)); const destinationPath = await availableDestination(initialDestination, record.sha256, allocated);
    if (!isInside(destinationPath, destinationRoot) || normalizedPath(destinationPath) === normalizedPath(destinationRoot)) throw new Error(`目标路径越界：${record.relative_path}`);
    const plan = { operation: 'copy', refinement_scope: REFINEMENT_SCOPE, relative_path: record.relative_path, parent_category: record.parent, subcategory: record.subcategory, selected_for_refinement: record.selected_for_refinement, source_path: sourcePath, destination_path: destinationPath, sha256: record.sha256, card_sha256: record.card_sha256, refinement_source: record.refinement_source, used_fallback: record.used_fallback, status, detail };
    const output = `${JSON.stringify(plan)}\n`; planHash.update(output); await planHandle.write(output); await csvHandle.write(csv(['copy', record.parent, record.subcategory, sourcePath, destinationPath, record.sha256, status, detail]));
    const key = record.subcategory ? `${record.parent}/${record.subcategory}` : record.parent; counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  await planHandle.close(); await csvHandle.close(); const planSha256 = planHash.digest('hex');
  const approval = { plan_run_id: runId, approved: false, operation: 'copy', refinement_scope: REFINEMENT_SCOPE, source_root: sourceRoot, destination_root: destinationRoot, plan_sha256: planSha256, source_refinements_sha256: refinementSha256, instruction: '人工检查 plan.csv 和 summary.json 后，将 approved 改为 true；然后使用 --execute 执行本批次。' };
  await writeFile(join(batchDirectory, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8');
  await writeFile(join(batchDirectory, 'summary.json'), JSON.stringify({ run_id: runId, generated_utc: new Date().toISOString(), refinement_scope: REFINEMENT_SCOPE, source_refinements: refinementsPath, source_refinements_sha256: refinementSha256, source_root: sourceRoot, destination_root: destinationRoot, operation: 'copy', records_read: records.length, files_planned: records.length, selected_for_refinement: records.filter((item) => item.selected_for_refinement).length, model_grouped_files: records.filter((item) => item.selected_for_refinement && item.mode === 'model').length, deterministic_grouped_files: records.filter((item) => item.selected_for_refinement && item.mode === 'deterministic').length, kept_at_one_level: records.filter((item) => !item.selected_for_refinement).length, missing_or_changed_sources: missingSources, destination_leaf_counts: [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, 'zh-CN')), plan_sha256: planSha256, executed: false }, null, 2), 'utf8');
  console.log(`二次整理预览计划已生成：${batchDirectory}`);
}

async function executePlan() {
  const planPath = await fileFromArgument(positionals[0], join(root, 'reports', 'refinement-plans'), 'plan.jsonl');
  const batchDirectory = dirname(planPath);
  const approvalPath = resolve(positionals[1] ?? join(batchDirectory, 'approval.json'));
  const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  const summary = JSON.parse(await readFile(join(batchDirectory, 'summary.json'), 'utf8'));
  const logPath = await executeApprovedPlan({
    planPath,
    approval,
    summary,
    batchDirectory,
    allowedOperations: ['copy'],
    operationBeforeHash: true,
    approvalError: '计划尚未批准：请先人工检查 plan.csv 和 summary.json',
    operationError: '二次整理只允许 copy',
    validateApproval({ approval: approved, summary: batchSummary }) {
      if (approved.refinement_scope !== REFINEMENT_SCOPE || batchSummary.refinement_scope !== REFINEMENT_SCOPE) throw new Error('计划不属于当前选择性分组范围，拒绝执行');
      if (approved.plan_run_id !== batchSummary.run_id || normalizedPath(approved.destination_root) !== normalizedPath(batchSummary.destination_root) || approved.source_refinements_sha256 !== batchSummary.source_refinements_sha256) throw new Error('批准文件与本批次汇总不一致，拒绝执行');
    },
    validatePlan({ plan, sourcePath, destinationPath, destinationRoot }) {
      if (plan.status !== 'planned') throw new Error(`计划状态为 ${plan.status}`);
      const mode = refinementMode(plan.parent_category);
      if (plan.refinement_scope !== REFINEMENT_SCOPE || typeof plan.selected_for_refinement !== 'boolean') throw new Error('单条计划超出当前选择性分组范围');
      if (plan.selected_for_refinement ? (!mode || !plan.subcategory) : plan.subcategory != null) throw new Error('单条计划的二级目录与选择性分组范围不一致');
      if (plan.operation !== 'copy' || !isAbsolute(plan.source_path) || !isAbsolute(plan.destination_path) || !validatePlanPath(sourcePath, destinationPath, destinationRoot)) throw new Error('单条计划无效或路径越界');
    },
  });
  console.log(`二次整理计划执行完成：${logPath}`);
}
if (execute) await executePlan(); else await previewPlan();
}

if (isMainModule(import.meta.url)) await main();
