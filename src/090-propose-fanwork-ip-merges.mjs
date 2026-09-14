#!/usr/bin/env node
/*
 * 第九阶段：只读取已完成的 070 结果和已完整执行的 080 计划，生成同人 IP 归并候选。
 * 不调用外部模型，不读取角色卡正文，不修改 data/，也不执行任何归并。
 */
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBatchDirectory, sha256File } from './lib/run-files.mjs';
import { csv, latestArtifact } from './lib/report-io.mjs';
import {
  buildFanworkIpCandidates, FANWORK_IP_MERGE_SCOPE, INDEPENDENT_DIRECTORY_MINIMUM,
  LONG_TAIL_BUCKETS, LONG_TAIL_MAXIMUM,
} from './lib/fanwork-ip-merge.mjs';

const FANWORK_PARENT = '同人';
const ACCEPTED_REFINEMENT_SCOPES = new Set([
  'fanwork-ip-and-special-groups-v1',
  'fanwork-source-ip-and-special-groups-v2',
]);

function normalizedPath(value) {
  return normalize(resolve(value)).toLocaleLowerCase('en-US');
}

async function artifactFromArgument(argument, defaultDirectory, fileName, acceptable) {
  if (!argument) return latestArtifact(defaultDirectory, fileName, acceptable);
  const path = resolve(argument);
  return (await stat(path)).isDirectory() ? join(path, fileName) : path;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonlStrict(path) {
  const records = [];
  let lineNumber = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch (error) { throw new Error(`${path} 第 ${lineNumber} 行不是有效 JSON：${error.message}`); }
  }
  return records;
}

async function completeRefinementBatch(batchDirectory) {
  try {
    const [run, summary] = await Promise.all([readJson(join(batchDirectory, 'run.json')), readJson(join(batchDirectory, 'summary.json'))]);
    return run.status === 'complete' && summary.status === 'complete' && summary.unique_failed_or_incomplete === 0
      && ACCEPTED_REFINEMENT_SCOPES.has(run.refinement_scope) && run.refinement_scope === summary.refinement_scope;
  } catch { return false; }
}

async function successfulPlanBatch(batchDirectory, planPath) {
  try {
    const summary = await readJson(join(batchDirectory, 'summary.json'));
    if (!ACCEPTED_REFINEMENT_SCOPES.has(summary.refinement_scope) || summary.missing_or_changed_sources !== 0) return false;
    const planSha256 = await sha256File(planPath);
    if (summary.plan_sha256 !== planSha256) return false;
    const executions = (await readdir(batchDirectory)).filter((name) => /^execution-summary-.*\.json$/u.test(name)).sort().reverse();
    for (const name of executions) {
      const execution = await readJson(join(batchDirectory, name));
      const copied = execution.result_counts?.find((item) => item.result === 'copied')?.count ?? 0;
      if (execution.plan_sha256 === planSha256 && execution.records_read === summary.files_planned && copied === summary.files_planned) return true;
    }
    return false;
  } catch { return false; }
}

function validateRefinementRecord(record, seenPaths) {
  const relativePath = String(record.relative_path ?? '');
  if (!relativePath || seenPaths.has(relativePath)) throw new Error(`070 结果存在空路径或重复路径：${relativePath}`);
  if (!/^[0-9a-f]{64}$/iu.test(String(record.sha256 ?? ''))) throw new Error(`070 结果缺少有效文件哈希：${relativePath}`);
  if (typeof record.selected_for_refinement !== 'boolean') throw new Error(`070 结果缺少范围标记：${relativePath}`);
  if (record.parent_category === FANWORK_PARENT && (!record.selected_for_refinement || !String(record.subcategory ?? '').trim())) throw new Error(`070 同人结果缺少 IP 目录：${relativePath}`);
  seenPaths.add(relativePath);
}

async function findSuccessfulExecution(batchDirectory, planSha256, expectedRecords) {
  const names = (await readdir(batchDirectory)).filter((name) => /^execution-summary-.*\.json$/u.test(name)).sort().reverse();
  for (const name of names) {
    const execution = await readJson(join(batchDirectory, name));
    const counts = new Map((execution.result_counts ?? []).map((item) => [item.result, item.count]));
    if (execution.plan_sha256 === planSha256 && execution.records_read === expectedRecords && counts.get('copied') === expectedRecords && counts.size === 1) return { name, execution };
  }
  throw new Error('080 计划没有与当前计划哈希匹配的完整 copied 执行汇总');
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 3) throw new Error('用法：node .\\src\\090-propose-fanwork-ip-merges.mjs [070批次或refinements.jsonl] [080批次或plan.jsonl] [报告根目录]');
  const root = resolve(import.meta.dirname, '..');
  const refinementsPath = await artifactFromArgument(args[0], join(root, 'reports', 'refinements'), 'refinements.jsonl', (directory) => completeRefinementBatch(directory));
  const planPath = await artifactFromArgument(args[1], join(root, 'reports', 'refinement-plans'), 'plan.jsonl', (directory, candidate) => successfulPlanBatch(directory, candidate));
  const reportsRoot = resolve(args[2] ?? join(root, 'reports', 'fanwork-ip-merge-candidates'));
  const refinementDirectory = dirname(refinementsPath); const planDirectory = dirname(planPath);
  const [refinementRun, refinementSummary, planSummary, refinementsSha256, planSha256] = await Promise.all([
    readJson(join(refinementDirectory, 'run.json')),
    readJson(join(refinementDirectory, 'summary.json')),
    readJson(join(planDirectory, 'summary.json')),
    sha256File(refinementsPath),
    sha256File(planPath),
  ]);

  if (refinementRun.status !== 'complete' || refinementSummary.status !== 'complete' || refinementSummary.unique_failed_or_incomplete !== 0) throw new Error('070 批次不完整，拒绝生成归并候选');
  if (!ACCEPTED_REFINEMENT_SCOPES.has(refinementRun.refinement_scope) || refinementRun.refinement_scope !== refinementSummary.refinement_scope) throw new Error('070 批次范围无效或元数据不一致');
  if (planSummary.refinement_scope !== refinementRun.refinement_scope) throw new Error('070 与 080 的细分范围不一致');
  if (planSummary.source_refinements_sha256 !== refinementsSha256 || normalizedPath(planSummary.source_refinements) !== normalizedPath(refinementsPath)) throw new Error('080 计划没有绑定所选 070 结果');
  if (planSummary.plan_sha256 !== planSha256 || planSummary.missing_or_changed_sources !== 0) throw new Error('080 计划哈希不一致或生成时存在缺失来源');
  const execution = await findSuccessfulExecution(planDirectory, planSha256, planSummary.files_planned);

  const [refinementRecords, planRecords] = await Promise.all([readJsonlStrict(refinementsPath), readJsonlStrict(planPath)]);
  if (refinementRecords.length !== refinementSummary.source_file_records || planRecords.length !== planSummary.files_planned || planRecords.length !== refinementRecords.length) throw new Error('070 或 080 记录数与批次摘要不一致');

  const refinementsByPath = new Map(); const seenRefinementPaths = new Set();
  for (const record of refinementRecords) {
    validateRefinementRecord(record, seenRefinementPaths);
    refinementsByPath.set(record.relative_path, record);
  }

  const seenPlanPaths = new Set(); const directoryStats = new Map(); const fanworkIndex = [];
  for (const plan of planRecords) {
    const relativePath = String(plan.relative_path ?? '');
    if (!relativePath || seenPlanPaths.has(relativePath)) throw new Error(`080 计划存在空路径或重复路径：${relativePath}`);
    seenPlanPaths.add(relativePath);
    const refinement = refinementsByPath.get(relativePath);
    if (!refinement || plan.sha256 !== refinement.sha256 || plan.parent_category !== refinement.parent_category || plan.subcategory !== refinement.subcategory || plan.selected_for_refinement !== refinement.selected_for_refinement) throw new Error(`070 与 080 单条记录不一致：${relativePath}`);
    if (plan.status !== 'planned' || plan.operation !== 'copy') throw new Error(`080 单条计划不是可复制状态：${relativePath}`);
    if (plan.parent_category !== FANWORK_PARENT) continue;
    const currentDirectory = String(plan.subcategory).normalize('NFKC').trim();
    const sourceCategory = String(refinement.fanwork_source_category ?? '').normalize('NFKC').trim() || null;
    const stats = directoryStats.get(currentDirectory) ?? { current_directory: currentDirectory, file_count: 0, source_categories: new Set() };
    stats.file_count += 1; if (sourceCategory) stats.source_categories.add(sourceCategory); directoryStats.set(currentDirectory, stats);
    fanworkIndex.push({ relative_path: relativePath, sha256: plan.sha256, card_sha256: plan.card_sha256 ?? null, current_directory: currentDirectory, fanwork_source_category: sourceCategory });
  }

  if (seenPlanPaths.size !== refinementsByPath.size) throw new Error('070 与 080 的相对路径集合不一致');
  const directoryEntries = [...directoryStats.values()].map((item) => ({ ...item, source_categories: [...item.source_categories] }));
  const candidates = buildFanworkIpCandidates(directoryEntries);
  const candidateByDirectory = new Map(candidates.map((item) => [item.current_directory, item]));
  for (const record of fanworkIndex) {
    const candidate = candidateByDirectory.get(record.current_directory);
    record.canonical_name = candidate.canonical_name; record.suggested_target = candidate.suggested_target;
  }
  fanworkIndex.sort((left, right) => left.relative_path.localeCompare(right.relative_path, 'zh-CN'));

  const { runId, batchDirectory } = await createBatchDirectory(reportsRoot);
  const candidatesPath = join(batchDirectory, 'candidates.jsonl'); const csvPath = join(batchDirectory, 'candidates.csv'); const indexPath = join(batchDirectory, 'fanwork-index.jsonl');
  const candidatesHandle = await open(candidatesPath, 'w'); const csvHandle = await open(csvPath, 'w'); const indexHandle = await open(indexPath, 'w');
  await csvHandle.write(csv(['current_directory', 'canonical_name', 'suggested_target', 'file_count', 'canonical_group_file_count', 'suggested_target_file_count', 'source_category', 'recommendation', 'merge_basis']));
  for (const candidate of candidates) {
    await candidatesHandle.write(`${JSON.stringify(candidate)}\n`);
    await csvHandle.write(csv([candidate.current_directory, candidate.canonical_name, candidate.suggested_target, candidate.file_count, candidate.canonical_group_file_count, candidate.suggested_target_file_count, candidate.source_category, candidate.recommendation, candidate.merge_basis]));
  }
  for (const record of fanworkIndex) await indexHandle.write(`${JSON.stringify(record)}\n`);
  await Promise.all([candidatesHandle.close(), csvHandle.close(), indexHandle.close()]);

  const candidatesSha256 = await sha256File(candidatesPath); const indexSha256 = await sha256File(indexPath);
  const recommendationCounts = new Map(); const targetCounts = new Map();
  for (const candidate of candidates) {
    recommendationCounts.set(candidate.recommendation, (recommendationCounts.get(candidate.recommendation) ?? 0) + 1);
    targetCounts.set(candidate.suggested_target, (targetCounts.get(candidate.suggested_target) ?? 0) + candidate.file_count);
  }
  const summary = {
    run_id: runId, generated_utc: new Date().toISOString(), status: 'complete', merge_scope: FANWORK_IP_MERGE_SCOPE,
    source_refinements: refinementsPath, source_refinements_sha256: refinementsSha256,
    source_plan: planPath, source_plan_sha256: planSha256, source_execution_summary: join(planDirectory, execution.name),
    source_refinement_scope: refinementRun.refinement_scope, source_file_records: refinementRecords.length,
    fanwork_file_records: fanworkIndex.length, current_fanwork_directories: candidates.length,
    singleton_directories: candidates.filter((item) => item.file_count === 1).length,
    directories_at_most_5: candidates.filter((item) => item.file_count <= LONG_TAIL_MAXIMUM).length,
    canonical_names: new Set(candidates.map((item) => item.canonical_name)).size,
    suggested_target_directories: targetCounts.size,
    independent_directory_minimum: INDEPENDENT_DIRECTORY_MINIMUM, long_tail_maximum: LONG_TAIL_MAXIMUM,
    long_tail_buckets: LONG_TAIL_BUCKETS,
    recommendation_counts: [...recommendationCounts].map(([recommendation, directory_count]) => ({ recommendation, directory_count })),
    suggested_target_counts: [...targetCounts].map(([suggested_target, file_count]) => ({ suggested_target, file_count })).sort((a, b) => b.file_count - a.file_count || a.suggested_target.localeCompare(b.suggested_target, 'zh-CN')),
    candidates_sha256: candidatesSha256, fanwork_index_sha256: indexSha256,
    external_model_called: false, data_modified: false,
  };
  const approval = {
    candidate_run_id: runId, approved: false, merge_scope: FANWORK_IP_MERGE_SCOPE, candidates_sha256: candidatesSha256,
    independent_directory_minimum: INDEPENDENT_DIRECTORY_MINIMUM, long_tail_maximum: LONG_TAIL_MAXIMUM,
    allowed_merge_conditions: ['同一官方系列', '明确共享世界观', '正传、外传或手游衍生作品', '用户明确指定为同一收藏体系'],
    forbidden_as_sole_basis: ['同一厂商', '题材或画风相近', '仅有联动但世界观独立'],
    overrides: [],
    instruction: '人工审核 candidates.csv；接受全部建议时将 approved 改为 true。若需修改目标，在 overrides 中加入 {"current_directory":"原目录","approved_target":"目标目录","reason":"人工依据"}。本文件不会触发文件操作。',
  };
  const run = {
    run_id: runId, generated_utc: summary.generated_utc, status: 'complete', merge_scope: FANWORK_IP_MERGE_SCOPE,
    source_refinements: refinementsPath, source_refinements_sha256: refinementsSha256,
    source_plan: planPath, source_plan_sha256: planSha256, source_execution_summary: summary.source_execution_summary,
  };
  await Promise.all([
    writeFile(join(batchDirectory, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8'),
    writeFile(join(batchDirectory, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8'),
    writeFile(join(batchDirectory, 'run.json'), JSON.stringify(run, null, 2), 'utf8'),
  ]);
  console.log(`同人 IP 归并候选已生成：${batchDirectory}`);
  return { batchDirectory, summary };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
