#!/usr/bin/env node
/*
 * 第十一阶段：依据已批准且完整执行的 100 计划，为角色卡追加分类标签。
 * 预览只写报告；只有计划再次获批后，--execute 才会把带标签副本写入新的空目录。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addTagsToCardFile } from './lib/card-parser.mjs';
import { isInside, normalizedPath, targetRootMustBeEmpty, validatePlanPath } from './lib/organization-plan.mjs';
import { csv, latestArtifact, writeAll } from './lib/report-io.mjs';
import { createBatchDirectory, newRunId, sha256File } from './lib/run-files.mjs';

const TAGGING_SCOPE = 'classification-tags-from-approved-merge-plan-v1';
const SOURCE_SCOPE = 'approved-fanwork-ip-merge-plan-v1';
const FANWORK_PARENT = '同人';
const COPY_UNCHANGED_OPTION = '--copy-unchanged=';

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

function sha256Buffer(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

function resultCount(summary, result) {
  return summary.result_counts?.find((item) => item.result === result)?.count ?? 0;
}

async function completeSourceExecution(batchDirectory, summary) {
  const names = (await readdir(batchDirectory)).filter((name) => /^execution-summary-.+\.json$/u.test(name)).sort().reverse();
  for (const name of names) {
    try {
      const path = join(batchDirectory, name); const execution = await readJson(path);
      if (execution.plan_sha256 === summary.plan_sha256
        && execution.records_read === summary.files_planned
        && resultCount(execution, 'copied') === summary.files_planned) return { path, execution };
    } catch { /* 尝试更早的执行摘要。 */ }
  }
  return null;
}

async function acceptableSourcePlan(batchDirectory, planPath) {
  try {
    const [summary, approval, planSha256] = await Promise.all([
      readJson(join(batchDirectory, 'summary.json')), readJson(join(batchDirectory, 'approval.json')), sha256File(planPath),
    ]);
    return summary.status === 'complete' && summary.merge_scope === SOURCE_SCOPE
      && approval.approved === true && approval.merge_scope === SOURCE_SCOPE
      && summary.plan_sha256 === planSha256 && approval.plan_sha256 === planSha256
      && Boolean(await completeSourceExecution(batchDirectory, summary));
  } catch { return false; }
}

async function artifactFromArgument(argument, defaultDirectory, fileName, acceptable = async () => true) {
  if (!argument) return latestArtifact(defaultDirectory, fileName, acceptable);
  const path = resolve(argument); return (await stat(path)).isDirectory() ? join(path, fileName) : path;
}

function tagsFor(plan) {
  const parent = String(plan.parent_category ?? '').normalize('NFKC').trim();
  if (!parent) throw new Error(`100 计划缺少一级分类：${plan.relative_path ?? ''}`);
  const target = plan.approved_target == null ? null : String(plan.approved_target).normalize('NFKC').trim();
  if (parent === FANWORK_PARENT ? !target : target !== null) throw new Error(`100 计划的同人目标无效：${plan.relative_path ?? ''}`);
  return target && target !== parent ? [parent, target] : [parent];
}

async function inspectSources(contexts, concurrency = 12) {
  const results = new Array(contexts.length); let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor; cursor += 1; if (index >= contexts.length) return;
      const context = contexts[index];
      try {
        const buffer = await readFile(context.sourcePath);
        if (sha256Buffer(buffer) !== context.source.sha256) throw new Error('来源文件 SHA-256 已变化');
        if (context.copyUnchanged) {
          results[index] = {
            status: 'ready', detail: '用户批准的显式例外：原样复制，不写入分类标签', outputSha256: context.source.sha256,
            originalTagCount: null, finalTagCount: null, addedTags: [], metadataChunksUpdated: 0,
          };
          continue;
        }
        const tagged = addTagsToCardFile(buffer, extname(context.sourcePath), context.tagsToAdd);
        results[index] = {
          status: 'ready', detail: '', outputSha256: sha256Buffer(tagged.buffer),
          originalTagCount: tagged.originalTags.length, finalTagCount: tagged.tags.length,
          addedTags: tagged.addedTags, metadataChunksUpdated: tagged.metadataChunksUpdated,
        };
      } catch (error) {
        results[index] = { status: 'source_invalid', detail: error.message, outputSha256: null, originalTagCount: null, finalTagCount: null, addedTags: [], metadataChunksUpdated: null };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, contexts.length || 1) }, () => worker()));
  return results;
}

async function loadSourceContext(sourcePlanPath) {
  const sourceBatchDirectory = dirname(sourcePlanPath);
  const [sourceSummary, sourceApproval, sourcePlanSha256] = await Promise.all([
    readJson(join(sourceBatchDirectory, 'summary.json')), readJson(join(sourceBatchDirectory, 'approval.json')), sha256File(sourcePlanPath),
  ]);
  if (sourceSummary.status !== 'complete' || sourceSummary.merge_scope !== SOURCE_SCOPE
    || sourceApproval.approved !== true || sourceApproval.merge_scope !== SOURCE_SCOPE
    || sourceSummary.plan_sha256 !== sourcePlanSha256 || sourceApproval.plan_sha256 !== sourcePlanSha256) throw new Error('100 来源计划不完整、未批准或哈希不一致');
  const sourceExecution = await completeSourceExecution(sourceBatchDirectory, sourceSummary);
  if (!sourceExecution) throw new Error('100 来源计划缺少完整复制执行证据');
  return {
    sourceBatchDirectory, sourceSummary, sourceApproval, sourcePlanSha256,
    sourceApprovalPath: join(sourceBatchDirectory, 'approval.json'),
    sourceExecutionPath: sourceExecution.path,
  };
}

async function preview(positionals, copyUnchangedPaths = new Set()) {
  const root = resolve(import.meta.dirname, '..');
  const sourcePlanPath = await artifactFromArgument(positionals[0], join(root, 'reports', 'fanwork-ip-merge-plans'), 'plan.jsonl', acceptableSourcePlan);
  const sourceContext = await loadSourceContext(sourcePlanPath);
  const [sourceApprovalSha256, sourceExecutionSha256] = await Promise.all([
    sha256File(sourceContext.sourceApprovalPath), sha256File(sourceContext.sourceExecutionPath),
  ]);
  const sourceRoot = resolve(positionals[1] ?? sourceContext.sourceSummary.destination_root);
  if (normalizedPath(sourceRoot) !== normalizedPath(sourceContext.sourceSummary.destination_root)) throw new Error('指定来源目录不是 100 已执行的目标目录');
  const destinationRoot = resolve(positionals[2] ?? join(root, 'data', '带分类标签角色卡'));
  const reportsRoot = resolve(positionals[3] ?? join(root, 'reports', 'classification-tag-plans'));
  if (normalizedPath(sourceRoot) === normalizedPath(destinationRoot) || isInside(destinationRoot, sourceRoot)) throw new Error('标签写入目标不能与来源相同或位于来源内部');
  await targetRootMustBeEmpty(destinationRoot);

  const sourceRecords = await readJsonlStrict(sourcePlanPath);
  if (sourceRecords.length !== sourceContext.sourceSummary.files_planned) throw new Error('100 计划记录数与摘要不一致');
  const relativePaths = new Set(); const destinationPaths = new Set(); const contexts = []; const matchedCopyUnchangedPaths = new Set();
  for (const source of sourceRecords) {
    if (!source.relative_path || relativePaths.has(source.relative_path) || !/^[0-9a-f]{64}$/iu.test(String(source.sha256 ?? ''))) throw new Error(`100 计划路径或哈希无效：${source.relative_path ?? ''}`);
    if (source.operation !== 'copy' || source.status !== 'planned') throw new Error(`100 计划记录不是已执行复制项：${source.relative_path}`);
    const sourcePath = resolve(source.destination_path); const preservedPath = relative(sourceRoot, sourcePath);
    if (!isInside(sourcePath, sourceRoot) || !preservedPath || preservedPath.startsWith(`..${sep}`) || isAbsolute(preservedPath)) throw new Error(`100 目标路径越界：${source.relative_path}`);
    const destinationPath = resolve(destinationRoot, preservedPath); const destinationKey = normalizedPath(destinationPath);
    if (!validatePlanPath(sourcePath, destinationPath, destinationRoot) || destinationPaths.has(destinationKey)) throw new Error(`110 目标路径无效或重复：${source.relative_path}`);
    const preservedRelativePath = preservedPath.split(sep).join('/');
    const copyUnchanged = copyUnchangedPaths.has(preservedRelativePath);
    if (copyUnchanged) matchedCopyUnchangedPaths.add(preservedRelativePath);
    relativePaths.add(source.relative_path); destinationPaths.add(destinationKey);
    contexts.push({ source, sourcePath, destinationPath, preservedRelativePath, copyUnchanged, tagsToAdd: tagsFor(source) });
  }
  const unmatchedCopyUnchangedPaths = [...copyUnchangedPaths].filter((path) => !matchedCopyUnchangedPaths.has(path));
  if (unmatchedCopyUnchangedPaths.length) throw new Error(`原样复制例外未匹配到 100 计划目标：${unmatchedCopyUnchangedPaths.join(', ')}`);

  const inspections = await inspectSources(contexts);
  const { runId, batchDirectory } = await createBatchDirectory(reportsRoot);
  const planPath = join(batchDirectory, 'plan.jsonl'); const planHandle = await open(planPath, 'w');
  const csvHandle = await open(join(batchDirectory, 'plan.csv'), 'w'); const planHash = createHash('sha256');
  await writeAll(csvHandle, csv(['operation', 'relative_path', 'parent_category', 'ip_category', 'tags_to_add', 'tags_actually_added', 'original_tag_count', 'final_tag_count', 'source_path', 'destination_path', 'source_sha256', 'output_sha256', 'status', 'detail']));
  let invalidSources = 0; let alreadyTagged = 0; let tagsActuallyAdded = 0; let unchangedCopyFiles = 0;
  for (let index = 0; index < contexts.length; index += 1) {
    const context = contexts[index]; const inspection = inspections[index];
    if (inspection.status !== 'ready') invalidSources += 1;
    if (context.copyUnchanged && inspection.status === 'ready') unchangedCopyFiles += 1;
    if (!context.copyUnchanged && inspection.status === 'ready' && inspection.addedTags.length === 0) alreadyTagged += 1;
    tagsActuallyAdded += inspection.addedTags.length;
    const record = {
      operation: context.copyUnchanged ? 'copy_unchanged' : 'write_tagged_copy', tagging_scope: TAGGING_SCOPE,
      relative_path: context.source.relative_path, parent_category: context.source.parent_category,
      ip_category: context.source.approved_target ?? null, tags_to_add: context.tagsToAdd,
      tags_actually_added: inspection.addedTags, original_tag_count: inspection.originalTagCount,
      final_tag_count: inspection.finalTagCount, metadata_chunks_updated: inspection.metadataChunksUpdated,
      source_path: context.sourcePath, destination_path: context.destinationPath,
      source_sha256: context.source.sha256, output_sha256: inspection.outputSha256,
      status: inspection.status, detail: inspection.detail,
    };
    const line = `${JSON.stringify(record)}\n`; planHash.update(line); await writeAll(planHandle, line);
    await writeAll(csvHandle, csv([record.operation, record.relative_path, record.parent_category, record.ip_category, record.tags_to_add.join(' | '), record.tags_actually_added.join(' | '), record.original_tag_count, record.final_tag_count, record.source_path, record.destination_path, record.source_sha256, record.output_sha256, record.status, record.detail]));
  }
  await planHandle.close(); await csvHandle.close(); const planSha256 = planHash.digest('hex');
  const summary = {
    run_id: runId, generated_utc: new Date().toISOString(), status: 'complete', tagging_scope: TAGGING_SCOPE,
    source_plan: sourcePlanPath, source_plan_sha256: sourceContext.sourcePlanSha256,
    source_approval: sourceContext.sourceApprovalPath, source_approval_sha256: sourceApprovalSha256,
    source_execution_summary: sourceContext.sourceExecutionPath, source_execution_summary_sha256: sourceExecutionSha256,
    source_root: sourceRoot, destination_root: destinationRoot, records_read: contexts.length,
    files_planned: contexts.length, invalid_sources: invalidSources, already_fully_tagged: alreadyTagged,
    unchanged_copy_files: unchangedCopyFiles, unchanged_copy_paths: [...matchedCopyUnchangedPaths],
    tags_actually_added: tagsActuallyAdded, plan_sha256: planSha256, executed: false,
  };
  const approval = {
    plan_run_id: runId, approved: false, operation: 'write_tagged_copy', tagging_scope: TAGGING_SCOPE,
    source_root: sourceRoot, destination_root: destinationRoot, plan_sha256: planSha256,
    unchanged_copy_files: unchangedCopyFiles, unchanged_copy_paths: [...matchedCopyUnchangedPaths],
    source_plan_sha256: sourceContext.sourcePlanSha256, source_approval_sha256: sourceApprovalSha256,
    source_execution_summary_sha256: sourceExecutionSha256,
    instruction: '人工检查 plan.csv、summary.json 和新的空目标目录后，将 approved 改为 true；再使用 --execute 执行。',
  };
  await Promise.all([
    writeFile(join(batchDirectory, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8'),
    writeFile(join(batchDirectory, 'approval.json'), JSON.stringify(approval, null, 2), 'utf8'),
  ]);
  console.log(`角色卡分类标签写入预览计划已生成：${batchDirectory}`);
  return { batchDirectory, summary };
}

async function execute(positionals) {
  const root = resolve(import.meta.dirname, '..');
  const planPath = await artifactFromArgument(positionals[0], join(root, 'reports', 'classification-tag-plans'), 'plan.jsonl');
  const batchDirectory = dirname(planPath); const approvalPath = resolve(positionals[1] ?? join(batchDirectory, 'approval.json'));
  const [approval, summary, actualPlanSha256] = await Promise.all([readJson(approvalPath), readJson(join(batchDirectory, 'summary.json')), sha256File(planPath)]);
  if (approval.approved !== true) throw new Error('计划尚未批准：请先人工检查 plan.csv 和 summary.json');
  if (approval.operation !== 'write_tagged_copy' || approval.tagging_scope !== TAGGING_SCOPE || summary.tagging_scope !== TAGGING_SCOPE) throw new Error('批准文件或计划摘要的标签写入范围无效');
  if (approval.plan_run_id !== summary.run_id || approval.plan_sha256 !== actualPlanSha256 || summary.plan_sha256 !== actualPlanSha256) throw new Error('计划哈希与批准文件或摘要不一致');
  if (summary.invalid_sources !== 0) throw new Error('计划包含无效来源，拒绝执行');
  if (approval.unchanged_copy_files !== summary.unchanged_copy_files
    || JSON.stringify(approval.unchanged_copy_paths ?? []) !== JSON.stringify(summary.unchanged_copy_paths ?? [])) throw new Error('批准文件与摘要的原样复制例外不一致');
  const [sourcePlanSha256, sourceApprovalSha256, sourceExecutionSha256] = await Promise.all([
    sha256File(resolve(summary.source_plan)), sha256File(resolve(summary.source_approval)), sha256File(resolve(summary.source_execution_summary)),
  ]);
  if (sourcePlanSha256 !== summary.source_plan_sha256 || sourceApprovalSha256 !== summary.source_approval_sha256 || sourceExecutionSha256 !== summary.source_execution_summary_sha256
    || approval.source_plan_sha256 !== sourcePlanSha256 || approval.source_approval_sha256 !== sourceApprovalSha256 || approval.source_execution_summary_sha256 !== sourceExecutionSha256) throw new Error('110 计划绑定的 100 计划、批准或执行证据已经变化');
  if (normalizedPath(approval.source_root) !== normalizedPath(summary.source_root) || normalizedPath(approval.destination_root) !== normalizedPath(summary.destination_root)) throw new Error('批准文件与摘要路径不一致');
  await targetRootMustBeEmpty(summary.destination_root);

  const executionRunId = newRunId(); const logPath = join(batchDirectory, `execution-${executionRunId}.jsonl`);
  const logHandle = await open(logPath, 'wx'); const csvHandle = await open(join(batchDirectory, `execution-${executionRunId}.csv`), 'wx');
  await writeAll(csvHandle, csv(['executed_utc', 'source_path', 'destination_path', 'source_sha256', 'output_sha256', 'result', 'detail']));
  const counts = new Map(); let recordsRead = 0;
  for await (const line of createInterface({ input: createReadStream(planPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const plan = JSON.parse(line); recordsRead += 1;
    const sourcePath = resolve(plan.source_path); const destinationPath = resolve(plan.destination_path);
    let result = 'failed'; let detail = ''; let destinationCreated = false;
    try {
      if (!['write_tagged_copy', 'copy_unchanged'].includes(plan.operation) || plan.tagging_scope !== TAGGING_SCOPE || plan.status !== 'ready') throw new Error('单条标签计划范围、操作或状态无效');
      if (!isInside(sourcePath, summary.source_root) || !validatePlanPath(sourcePath, destinationPath, summary.destination_root)) throw new Error('单条标签计划路径无效或越界');
      const expectedTags = tagsFor({ relative_path: plan.relative_path, parent_category: plan.parent_category, approved_target: plan.ip_category });
      if (!Array.isArray(plan.tags_to_add) || JSON.stringify(plan.tags_to_add) !== JSON.stringify(expectedTags)) throw new Error('单条标签计划与一级分类或同人 IP 不一致');
      if (!/^[0-9a-f]{64}$/iu.test(String(plan.source_sha256 ?? '')) || !/^[0-9a-f]{64}$/iu.test(String(plan.output_sha256 ?? ''))) throw new Error('单条标签计划哈希无效');
      const buffer = await readFile(sourcePath);
      if (sha256Buffer(buffer) !== plan.source_sha256) throw new Error('来源文件已变化，SHA-256 不匹配');
      const outputBuffer = plan.operation === 'copy_unchanged'
        ? buffer
        : addTagsToCardFile(buffer, extname(sourcePath), plan.tags_to_add).buffer;
      if (sha256Buffer(outputBuffer) !== plan.output_sha256) throw new Error('标签写入结果与批准计划不一致');
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, outputBuffer, { flag: 'wx' }); destinationCreated = true;
      if (await sha256File(destinationPath) !== plan.output_sha256) throw new Error('写入后哈希校验失败');
      result = plan.operation === 'copy_unchanged' ? 'unchanged_copy_written' : 'tagged_copy_written';
      if (plan.operation === 'copy_unchanged') detail = '按已批准例外原样复制，未写入分类标签';
    } catch (error) {
      detail = error.message;
      if (destinationCreated) {
        try { await unlink(destinationPath); detail += '；已清理未完成目标'; }
        catch (cleanupError) { detail += `；清理未完成目标失败：${cleanupError.message}`; }
      }
    }
    const executedUtc = new Date().toISOString();
    await writeAll(logHandle, `${JSON.stringify({ executed_utc: executedUtc, source_path: sourcePath, destination_path: destinationPath, source_sha256: plan.source_sha256, output_sha256: plan.output_sha256, result, detail })}\n`);
    await writeAll(csvHandle, csv([executedUtc, sourcePath, destinationPath, plan.source_sha256, plan.output_sha256, result, detail]));
    counts.set(result, (counts.get(result) ?? 0) + 1);
  }
  await logHandle.close(); await csvHandle.close();
  await writeFile(join(batchDirectory, `execution-summary-${executionRunId}.json`), JSON.stringify({
    plan_run_id: approval.plan_run_id, executed_utc: new Date().toISOString(), plan_sha256: actualPlanSha256,
    records_read: recordsRead, result_counts: [...counts].map(([result, count]) => ({ result, count })),
  }, null, 2), 'utf8');
  console.log(`角色卡分类标签副本写入完成：${logPath}`);
  return { logPath };
}

export async function main(args = process.argv.slice(2)) {
  const executeMode = args.includes('--execute'); const positionals = args.filter((item) => item !== '--execute');
  const copyUnchangedArguments = args.filter((item) => item.startsWith(COPY_UNCHANGED_OPTION));
  const unknownOptions = args.filter((item) => item.startsWith('--') && item !== '--execute' && !item.startsWith(COPY_UNCHANGED_OPTION));
  if (unknownOptions.length) throw new Error(`未知选项：${unknownOptions.join(', ')}`);
  if (executeMode && copyUnchangedArguments.length) throw new Error('--copy-unchanged 只能在生成预览计划时指定');
  const copyUnchangedPaths = new Set(copyUnchangedArguments.map((item) => item.slice(COPY_UNCHANGED_OPTION.length).replaceAll('\\', '/')));
  if ([...copyUnchangedPaths].some((path) => !path || path.startsWith('/') || /^[a-z]:/iu.test(path) || path.split('/').includes('..'))) throw new Error('--copy-unchanged 必须是来源根目录下的安全相对路径');
  const filteredPositionals = positionals.filter((item) => !item.startsWith(COPY_UNCHANGED_OPTION));
  if (executeMode && filteredPositionals.length > 2) throw new Error('执行用法：node .\\src\\110-write-classification-tags.mjs --execute [计划批次或plan.jsonl] [approval.json]');
  if (!executeMode && filteredPositionals.length > 4) throw new Error('预览用法：node .\\src\\110-write-classification-tags.mjs [已执行100批次] [来源目录] [新目标目录] [报告根目录] [--copy-unchanged=<来源根目录下相对路径>]');
  return executeMode ? execute(filteredPositionals) : preview(filteredPositionals, copyUnchangedPaths);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
