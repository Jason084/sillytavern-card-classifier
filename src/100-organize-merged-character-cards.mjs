#!/usr/bin/env node
/*
 * 第十阶段：根据已批准的 090 同人 IP 映射生成完整复制计划。
 * 预览只写报告；只有计划本身再次获批后，--execute 才会复制到新的空目录。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBatchDirectory, sha256File } from './lib/run-files.mjs';
import { csv, latestArtifact } from './lib/report-io.mjs';
import {
  availableDestination, executeApprovedPlan, isInside, normalizedPath,
  targetRootMustBeEmpty, validatePlanPath,
} from './lib/organization-plan.mjs';

const MERGE_SCOPE = 'approved-fanwork-ip-merge-plan-v1';
const CANDIDATE_SCOPE = 'fanwork-ip-merge-candidates-v1';
const FANWORK_PARENT = '同人';
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function validDirectoryName(value, maximumLength = 40) {
  const output = String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!output || output.length > maximumLength || output === '.' || output === '..') return null;
  if (/[<>:"/\\|?*\u0000-\u001F]/u.test(output) || /[. ]$/u.test(output) || WINDOWS_RESERVED.test(output)) return null;
  return output;
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

async function readJsonlStrict(path) {
  const records = []; let lineNumber = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    lineNumber += 1; if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { throw new Error(`${path} 第 ${lineNumber} 行不是有效 JSON：${error.message}`); }
  }
  return records;
}

async function artifactFromArgument(argument, defaultDirectory, fileName, acceptable = async () => true) {
  if (!argument) return latestArtifact(defaultDirectory, fileName, acceptable);
  const path = resolve(argument); return (await stat(path)).isDirectory() ? join(path, fileName) : path;
}

async function latestApprovedCandidate(batchDirectory, candidatesPath) {
  try {
    const [run, summary, approval, hash] = await Promise.all([
      readJson(join(batchDirectory, 'run.json')), readJson(join(batchDirectory, 'summary.json')),
      readJson(join(batchDirectory, 'approval.json')), sha256File(candidatesPath),
    ]);
    return run.status === 'complete' && summary.status === 'complete' && run.merge_scope === CANDIDATE_SCOPE
      && summary.merge_scope === CANDIDATE_SCOPE && approval.approved === true
      && summary.candidates_sha256 === hash && approval.candidates_sha256 === hash;
  } catch { return false; }
}

function approvedTargets(candidates, approval) {
  if (approval.approved !== true) throw new Error('090 候选尚未人工批准');
  const byDirectory = new Map();
  for (const candidate of candidates) {
    const currentDirectory = validDirectoryName(candidate.current_directory);
    if (!currentDirectory || byDirectory.has(currentDirectory)) throw new Error(`候选存在无效或重复目录：${candidate.current_directory ?? ''}`);
    if (!validDirectoryName(candidate.canonical_name) || !validDirectoryName(candidate.suggested_target)) throw new Error(`候选包含无效目录名：${currentDirectory}`);
    byDirectory.set(currentDirectory, candidate);
  }
  const overrides = new Map();
  for (const override of approval.overrides ?? []) {
    const currentDirectory = validDirectoryName(override.current_directory); const target = validDirectoryName(override.approved_target);
    if (!currentDirectory || !byDirectory.has(currentDirectory) || !target || !String(override.reason ?? '').trim() || overrides.has(currentDirectory)) throw new Error(`090 人工覆盖无效或重复：${override.current_directory ?? ''}`);
    overrides.set(currentDirectory, target);
  }
  const policy = approval.below_minimum_policy;
  const policyRows = candidates.filter((item) => item.recommendation === policy?.recommendation);
  if (!policy || !validDirectoryName(policy.approved_target)
    || new Set(policyRows.map((item) => item.canonical_name)).size !== policy.canonical_group_count
    || policyRows.length !== policy.current_directory_count
    || policyRows.reduce((sum, item) => sum + item.file_count, 0) !== policy.file_count) throw new Error('090 独立目录门槛批准策略与候选内容不一致');
  const output = new Map();
  for (const [currentDirectory, candidate] of byDirectory) {
    const target = overrides.get(currentDirectory)
      ?? (candidate.recommendation === policy.recommendation ? policy.approved_target : candidate.suggested_target);
    if (!validDirectoryName(target)) throw new Error(`批准目标无效：${currentDirectory}`);
    output.set(currentDirectory, { ...candidate, approved_target: target, approval_source: overrides.has(currentDirectory) ? 'manual_override' : candidate.recommendation === policy.recommendation ? 'minimum_policy' : 'candidate' });
  }
  const waitingCount = [...output.values()].filter((item) => item.approved_target === '待确认原作').reduce((sum, item) => sum + item.file_count, 0);
  if (waitingCount !== approval.expected_waiting_bucket_file_count) throw new Error(`待确认原作批准数量不一致：approval=${approval.expected_waiting_bucket_file_count}，实际=${waitingCount}`);
  return output;
}

async function verifySourceRecords(records, concurrency = 12) {
  const results = new Array(records.length); let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor; cursor += 1; if (index >= records.length) return;
      const item = records[index];
      try {
        const info = await stat(item.sourcePath);
        if (!info.isFile()) throw new Error('来源不是文件');
        const actual = await sha256File(item.sourcePath);
        results[index] = actual === item.plan.sha256 ? { status: 'planned', detail: '' } : { status: 'source_missing_or_changed', detail: '来源文件 SHA-256 已变化' };
      } catch (error) { results[index] = { status: 'source_missing_or_changed', detail: error.code === 'ENOENT' ? '来源文件不存在' : error.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, records.length || 1) }, () => worker()));
  return results;
}

async function preview(positionals) {
  const root = resolve(import.meta.dirname, '..');
  const candidatesPath = await artifactFromArgument(positionals[0], join(root, 'reports', 'fanwork-ip-merge-candidates'), 'candidates.jsonl', (directory, candidate) => latestApprovedCandidate(directory, candidate));
  const candidateDirectory = dirname(candidatesPath);
  const [candidateRun, candidateSummary, candidateApproval, candidatesSha256] = await Promise.all([
    readJson(join(candidateDirectory, 'run.json')), readJson(join(candidateDirectory, 'summary.json')),
    readJson(join(candidateDirectory, 'approval.json')), sha256File(candidatesPath),
  ]);
  if (candidateRun.status !== 'complete' || candidateSummary.status !== 'complete' || candidateRun.merge_scope !== CANDIDATE_SCOPE || candidateSummary.merge_scope !== CANDIDATE_SCOPE) throw new Error('090 候选批次不完整或范围无效');
  if (candidateSummary.candidates_sha256 !== candidatesSha256 || candidateApproval.candidates_sha256 !== candidatesSha256) throw new Error('090 候选哈希与摘要或批准文件不一致');
  const candidateApprovalPath = join(candidateDirectory, 'approval.json'); const candidateApprovalSha256 = await sha256File(candidateApprovalPath);
  const candidates = await readJsonlStrict(candidatesPath); const mappings = approvedTargets(candidates, candidateApproval);

  const indexPath = join(candidateDirectory, 'fanwork-index.jsonl'); const indexSha256 = await sha256File(indexPath);
  if (indexSha256 !== candidateSummary.fanwork_index_sha256) throw new Error('090 逐卡索引哈希与摘要不一致');
  const fanworkIndex = await readJsonlStrict(indexPath); const fanworkByPath = new Map();
  for (const item of fanworkIndex) {
    if (!item.relative_path || fanworkByPath.has(item.relative_path) || !mappings.has(item.current_directory)) throw new Error(`090 逐卡索引存在无效路径或目录：${item.relative_path ?? ''}`);
    fanworkByPath.set(item.relative_path, item);
  }
  if (fanworkByPath.size !== candidateSummary.fanwork_file_records) throw new Error('090 逐卡索引数量与摘要不一致');

  const sourcePlanPath = resolve(candidateSummary.source_plan); const sourcePlanSha256 = await sha256File(sourcePlanPath);
  if (sourcePlanSha256 !== candidateSummary.source_plan_sha256) throw new Error('090 绑定的 080 计划已经变化');
  const sourcePlanDirectory = dirname(sourcePlanPath); const sourcePlanSummary = await readJson(join(sourcePlanDirectory, 'summary.json'));
  const sourceExecution = await readJson(resolve(candidateSummary.source_execution_summary));
  const copied = sourceExecution.result_counts?.find((item) => item.result === 'copied')?.count ?? 0;
  if (sourcePlanSummary.plan_sha256 !== sourcePlanSha256 || sourceExecution.plan_sha256 !== sourcePlanSha256 || copied !== sourcePlanSummary.files_planned || sourceExecution.records_read !== sourcePlanSummary.files_planned) throw new Error('090 绑定的 080 计划没有完整复制执行证据');

  const sourceRoot = resolve(positionals[1] ?? sourcePlanSummary.destination_root);
  if (normalizedPath(sourceRoot) !== normalizedPath(sourcePlanSummary.destination_root)) throw new Error('指定来源目录不是 080 已执行的目标目录');
  const destinationRoot = resolve(positionals[2] ?? join(root, 'data', '同人IP归并角色卡'));
  const reportsRoot = resolve(positionals[3] ?? join(root, 'reports', 'fanwork-ip-merge-plans'));
  if (normalizedPath(sourceRoot) === normalizedPath(destinationRoot) || isInside(destinationRoot, sourceRoot)) throw new Error('归并目标不能与来源相同或位于来源内部');
  await targetRootMustBeEmpty(destinationRoot);

  const sourcePlans = await readJsonlStrict(sourcePlanPath);
  if (sourcePlans.length !== sourcePlanSummary.files_planned) throw new Error('080 计划记录数与摘要不一致');
  const relativePaths = new Set(); const contexts = [];
  for (const plan of sourcePlans) {
    if (!plan.relative_path || relativePaths.has(plan.relative_path) || !/^[0-9a-f]{64}$/iu.test(String(plan.sha256 ?? ''))) throw new Error(`080 计划路径或哈希无效：${plan.relative_path ?? ''}`);
    if (plan.operation !== 'copy' || plan.status !== 'planned') throw new Error(`080 计划记录不是已执行复制项：${plan.relative_path}`);
    const sourcePath = resolve(plan.destination_path); const preservedRelativePath = relative(sourceRoot, sourcePath);
    if (!isInside(sourcePath, sourceRoot) || !preservedRelativePath || preservedRelativePath.startsWith(`..${sep}`) || isAbsolute(preservedRelativePath)) throw new Error(`080 目标路径越界：${plan.relative_path}`);
    const fanwork = fanworkByPath.get(plan.relative_path) ?? null;
    if ((plan.parent_category === FANWORK_PARENT) !== Boolean(fanwork)) throw new Error(`080 与 090 同人范围不一致：${plan.relative_path}`);
    if (fanwork && (fanwork.sha256 !== plan.sha256 || fanwork.current_directory !== plan.subcategory)) throw new Error(`080 与 090 同人记录不一致：${plan.relative_path}`);
    relativePaths.add(plan.relative_path); contexts.push({ plan, sourcePath, preservedRelativePath, fanwork });
  }
  if (contexts.filter((item) => item.fanwork).length !== fanworkByPath.size) throw new Error('080 与 090 的同人路径集合不一致');

  const sourceChecks = await verifySourceRecords(contexts);
  const { runId, batchDirectory } = await createBatchDirectory(reportsRoot);
  const planPath = join(batchDirectory, 'plan.jsonl'); const planHandle = await open(planPath, 'w'); const csvHandle = await open(join(batchDirectory, 'plan.csv'), 'w'); const planHash = createHash('sha256');
  await csvHandle.write(csv(['operation', 'relative_path', 'parent_category', 'current_fanwork_directory', 'canonical_name', 'approved_target', 'source_path', 'destination_path', 'sha256', 'status', 'detail']));
  const allocated = new Set(); const destinationCounts = new Map(); let missingOrChanged = 0; let collisionRenames = 0;
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index]; const check = sourceChecks[index]; let mapping = null; let initialDestination;
    if (context.fanwork) {
      mapping = mappings.get(context.fanwork.current_directory);
      initialDestination = join(destinationRoot, FANWORK_PARENT, mapping.approved_target, basename(context.sourcePath));
    } else initialDestination = join(destinationRoot, context.preservedRelativePath);
    const destinationPath = await availableDestination(initialDestination, context.plan.sha256, allocated);
    if (destinationPath !== initialDestination) collisionRenames += 1;
    if (!validatePlanPath(context.sourcePath, destinationPath, destinationRoot)) throw new Error(`生成的目标路径无效：${context.plan.relative_path}`);
    if (check.status !== 'planned') missingOrChanged += 1;
    const record = {
      operation: 'copy', merge_scope: MERGE_SCOPE, relative_path: context.plan.relative_path,
      parent_category: context.plan.parent_category, current_fanwork_directory: context.fanwork?.current_directory ?? null,
      canonical_name: mapping?.canonical_name ?? null, approved_target: mapping?.approved_target ?? null,
      mapping_approval_source: mapping?.approval_source ?? null, source_path: context.sourcePath,
      destination_path: destinationPath, sha256: context.plan.sha256, card_sha256: context.plan.card_sha256 ?? null,
      status: check.status, detail: check.detail,
    };
    const line = `${JSON.stringify(record)}\n`; planHash.update(line); await planHandle.write(line);
    await csvHandle.write(csv(['copy', record.relative_path, record.parent_category, record.current_fanwork_directory, record.canonical_name, record.approved_target, record.source_path, record.destination_path, record.sha256, record.status, record.detail]));
    const destinationKey = record.approved_target ? `${FANWORK_PARENT}/${record.approved_target}` : dirname(context.preservedRelativePath) === '.' ? context.plan.parent_category : dirname(context.preservedRelativePath).split(sep).join('/');
    destinationCounts.set(destinationKey, (destinationCounts.get(destinationKey) ?? 0) + 1);
  }
  await planHandle.close(); await csvHandle.close(); const planSha256 = planHash.digest('hex');
  const approval = {
    plan_run_id: runId, approved: false, operation: 'copy', merge_scope: MERGE_SCOPE,
    source_root: sourceRoot, destination_root: destinationRoot, plan_sha256: planSha256,
    source_plan_sha256: sourcePlanSha256, candidate_run_id: candidateSummary.run_id,
    candidates_sha256: candidatesSha256, candidate_approval_sha256: candidateApprovalSha256,
    instruction: '人工检查 plan.csv、summary.json 和新的空目标目录后，将 approved 改为 true；再使用 --execute 执行。',
  };
  const waitingCount = [...mappings.values()].filter((item) => item.approved_target === '待确认原作').reduce((sum, item) => sum + item.file_count, 0);
  const summary = {
    run_id: runId, generated_utc: new Date().toISOString(), status: 'complete', merge_scope: MERGE_SCOPE,
    source_candidates: candidatesPath, candidates_sha256: candidatesSha256,
    source_candidate_approval: candidateApprovalPath, candidate_approval_sha256: candidateApprovalSha256,
    source_plan: sourcePlanPath, source_plan_sha256: sourcePlanSha256,
    source_root: sourceRoot, destination_root: destinationRoot, operation: 'copy',
    records_read: contexts.length, files_planned: contexts.length,
    fanwork_files_planned: fanworkByPath.size, non_fanwork_files_planned: contexts.length - fanworkByPath.size,
    approved_fanwork_targets: new Set([...mappings.values()].map((item) => item.approved_target)).size,
    waiting_bucket_file_count: waitingCount, below_minimum_canonical_groups: candidateApproval.below_minimum_policy.canonical_group_count,
    missing_or_changed_sources: missingOrChanged, collision_renames: collisionRenames,
    destination_leaf_counts: [...destinationCounts].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path, 'zh-CN')),
    plan_sha256: planSha256, executed: false,
  };
  await Promise.all([
    writeFile(join(batchDirectory, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8'),
    writeFile(join(batchDirectory, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8'),
  ]);
  console.log(`同人 IP 归并复制预览计划已生成：${batchDirectory}`);
  return { batchDirectory, summary };
}

async function execute(positionals) {
  const root = resolve(import.meta.dirname, '..');
  const planPath = await artifactFromArgument(positionals[0], join(root, 'reports', 'fanwork-ip-merge-plans'), 'plan.jsonl');
  const batchDirectory = dirname(planPath); const approvalPath = resolve(positionals[1] ?? join(batchDirectory, 'approval.json'));
  const [approval, summary] = await Promise.all([readJson(approvalPath), readJson(join(batchDirectory, 'summary.json'))]);
  const [actualCandidatesSha256, actualCandidateApprovalSha256, actualSourcePlanSha256] = await Promise.all([
    sha256File(resolve(summary.source_candidates)), sha256File(resolve(summary.source_candidate_approval)), sha256File(resolve(summary.source_plan)),
  ]);
  if (actualCandidatesSha256 !== summary.candidates_sha256 || actualCandidateApprovalSha256 !== summary.candidate_approval_sha256 || actualSourcePlanSha256 !== summary.source_plan_sha256) throw new Error('归并计划绑定的候选、候选批准或 080 来源计划已经变化');
  await targetRootMustBeEmpty(summary.destination_root);
  const logPath = await executeApprovedPlan({
    planPath, approval, summary, batchDirectory, allowedOperations: ['copy'], operationBeforeHash: true,
    approvalError: '计划尚未批准：请先人工检查 plan.csv 和 summary.json', operationError: '同人 IP 归并整理只允许 copy',
    validateApproval({ approval: approved, summary: batchSummary }) {
      if (approved.merge_scope !== MERGE_SCOPE || batchSummary.merge_scope !== MERGE_SCOPE || approved.plan_run_id !== batchSummary.run_id) throw new Error('批准文件与归并计划范围或批次不一致');
      if (approved.candidates_sha256 !== batchSummary.candidates_sha256 || approved.candidate_approval_sha256 !== batchSummary.candidate_approval_sha256 || approved.source_plan_sha256 !== batchSummary.source_plan_sha256) throw new Error('批准文件与归并计划来源不一致');
      if (normalizedPath(approved.source_root) !== normalizedPath(batchSummary.source_root) || normalizedPath(approved.destination_root) !== normalizedPath(batchSummary.destination_root)) throw new Error('批准文件与归并计划路径不一致');
    },
    validatePlan({ plan, sourcePath, destinationPath, destinationRoot }) {
      if (plan.merge_scope !== MERGE_SCOPE || plan.operation !== 'copy' || plan.status !== 'planned') throw new Error('单条归并计划范围、操作或状态无效');
      if (!isInside(sourcePath, summary.source_root) || !validatePlanPath(sourcePath, destinationPath, destinationRoot)) throw new Error('单条归并计划路径无效或越界');
      if (plan.parent_category === FANWORK_PARENT ? !validDirectoryName(plan.approved_target) : plan.approved_target != null) throw new Error('单条归并计划的同人目标无效');
    },
  });
  console.log(`同人 IP 归并复制计划执行完成：${logPath}`);
  return { logPath };
}

export async function main(args = process.argv.slice(2)) {
  const executeMode = args.includes('--execute'); const positionals = args.filter((item) => item !== '--execute');
  if (executeMode && positionals.length > 2) throw new Error('执行用法：node .\\src\\100-organize-merged-character-cards.mjs --execute [计划批次或plan.jsonl] [approval.json]');
  if (!executeMode && positionals.length > 4) throw new Error('预览用法：node .\\src\\100-organize-merged-character-cards.mjs [090批次] [来源目录] [新目标目录] [报告根目录]');
  return executeMode ? execute(positionals) : preview(positionals);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
