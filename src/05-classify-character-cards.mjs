#!/usr/bin/env node
/*
 * 第五阶段：使用已批准的 taxonomy，让便宜小模型对每个唯一角色卡内容进行单一主分类。
 * 成功结果立即写入 checkpoint.jsonl；--resume=<批次目录> 只重试未完成项。
 */
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readJsonlRecords } from './lib/read-jsonl.mjs';
import { cardHashOf } from './lib/card-hash.mjs';
import {
  cardModelInput, compact, hasSemanticContent, modelSettingsFromEnv, requestModelJson, runWorkers, sha256Text,
} from './lib/model-client.mjs';

const root = resolve(import.meta.dirname, '..');
const scansDirectory = join(root, 'reports', 'scans');
const taxonomyReportsDirectory = join(root, 'reports', 'classification-trials');
const defaultReportsDirectory = join(root, 'reports', 'classifications');
const promptVersion = 'classification-v2';

const rawArguments = process.argv.slice(2); const positionals = []; let resumeArgument = null;
for (let index = 0; index < rawArguments.length; index += 1) {
  const argument = rawArguments[index];
  if (argument === '--resume') { resumeArgument = rawArguments[index + 1]; index += 1; }
  else if (argument.startsWith('--resume=')) resumeArgument = argument.slice('--resume='.length);
  else positionals.push(argument);
}
if (resumeArgument === '') throw new Error('--resume 必须指定已有分类批次目录');

function csv(values) { return values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',') + '\n'; }
function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}
function normalized(value) { return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN'); }

async function latestFile(directory, fileName, approved = false) {
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, fileName);
    try {
      if (!(await stat(path)).isFile()) continue;
      if (approved) {
        const approval = JSON.parse(await readFile(join(directory, entry.name, 'approval.json'), 'utf8'));
        if (approval.approved !== true) continue;
      }
      candidates.push(path);
    } catch { /* Ignore incomplete batches. */ }
  }
  candidates.sort((a, b) => basename(dirname(b)).localeCompare(basename(dirname(a))));
  if (!candidates.length) throw new Error(`找不到${approved ? '已批准的' : ''} ${fileName}：${directory}`);
  return candidates[0];
}

async function fileFromArgument(argument, defaultDirectory, fileName, approved = false) {
  if (!argument) return latestFile(defaultDirectory, fileName, approved);
  const path = resolve(argument); const info = await stat(path);
  return info.isDirectory() ? join(path, fileName) : path;
}

function baseResult(record) {
  const cardHash = cardHashOf(record);
  return {
    relative_path: record.relative_path,
    file_name: record.file_name,
    sha256: record.sha256,
    card_sha256: cardHash.hash,
    card_hash_source: cardHash.source,
    spec_version: record.card.spec_version,
    name: record.card.name,
    creator: record.card.creator,
    character_version: record.card.character_version,
    tags: record.card.tags ?? [],
  };
}

function manualResult(record, reason, modelVersion = null) {
  return {
    ...baseResult(record),
    category: null,
    classification_source: 'manual_review',
    model_decision: 'review',
    reason,
    confidence: 0,
    needs_review: true,
    model_version: modelVersion,
    prompt_version: promptVersion,
  };
}

function normalizeDecision(raw, categoryNames, modelVersion) {
  const id = String(raw?.id ?? raw?.card_sha256 ?? '');
  const decision = String(raw?.decision ?? '');
  const confidence = Number(raw?.confidence);
  const reason = compact(raw?.reason, 300);
  if (!id || !['classify', 'exclude', 'review'].includes(decision) || !(confidence >= 0 && confidence <= 1) || !reason) return null;
  let category = null;
  if (decision === 'classify') {
    category = String(raw?.category ?? '');
    if (!categoryNames.has(category)) return null;
  } else if (decision === 'exclude') category = '__排除复核__';
  return { card_sha256: id, decision, category, confidence, reason, model_version: modelVersion, prompt_version: promptVersion };
}

async function readCheckpoint(path, categoryNames, modelVersion) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const completed = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const result = normalizeDecision(JSON.parse(line), categoryNames, modelVersion);
      if (result && result.model_version === modelVersion) completed.set(result.card_sha256, result);
    } catch { /* A killed process may leave one partial trailing line. */ }
  }
  return completed;
}

const modelSettings = modelSettingsFromEnv();
let batchDirectory; let runMetadata; let indexPath; let taxonomyPath; let runId;
if (resumeArgument) {
  batchDirectory = resolve(resumeArgument);
  runMetadata = JSON.parse(await readFile(join(batchDirectory, 'run.json'), 'utf8'));
  runId = runMetadata.run_id;
  indexPath = resolve(runMetadata.source_index);
  taxonomyPath = resolve(runMetadata.taxonomy_file);
  if (runMetadata.model_version !== modelSettings.model) throw new Error(`续跑必须使用原模型 ${runMetadata.model_version}`);
  if (positionals[0] && resolve(positionals[0]) !== indexPath) throw new Error('续跑时指定的扫描索引与原批次不一致');
} else {
  indexPath = await fileFromArgument(positionals[0], scansDirectory, 'index.jsonl');
  taxonomyPath = await fileFromArgument(positionals[1], taxonomyReportsDirectory, 'taxonomy.json', !positionals[1]);
  runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  batchDirectory = join(resolve(positionals[2] ?? defaultReportsDirectory), runId);
}

const taxonomyText = await readFile(taxonomyPath, 'utf8');
const taxonomySha256 = sha256Text(taxonomyText);
const taxonomy = JSON.parse(taxonomyText);
const approvalPath = join(dirname(taxonomyPath), 'approval.json');
const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
if (approval.approved !== true) throw new Error('分类体系尚未批准：请先人工检查 taxonomy.json 和 review.md，再将 approval.json 中的 approved 改为 true');
if (approval.taxonomy_sha256 !== taxonomySha256) throw new Error('taxonomy.json 已在批准后变化，拒绝使用失效的批准文件');
if (!Array.isArray(taxonomy.categories) || taxonomy.categories.length < 12 || taxonomy.categories.length > 20) throw new Error('taxonomy.json 必须包含 12–20 个主分类');
const categoryNames = new Set(taxonomy.categories.map((category) => String(category.name ?? '').trim()).filter(Boolean));
if (categoryNames.size !== taxonomy.categories.length) throw new Error('taxonomy.json 中存在空白或重复分类名');
if (resumeArgument && runMetadata.taxonomy_sha256 !== taxonomySha256) throw new Error('续跑时的 taxonomy 与原批次不一致');

await stat(indexPath);
if (!resumeArgument) {
  await mkdir(batchDirectory, { recursive: true });
  runMetadata = {
    run_id: runId,
    started_utc: new Date().toISOString(),
    source_index: indexPath,
    taxonomy_file: taxonomyPath,
    taxonomy_sha256: taxonomySha256,
    model_version: modelSettings.model,
    prompt_version: promptVersion,
  };
  await writeFile(join(batchDirectory, 'run.json'), JSON.stringify(runMetadata, null, 2), 'utf8');
}

let sourceInputDirectory = join(root, 'data', '角色卡', '未分类');
try { sourceInputDirectory = JSON.parse(await readFile(join(dirname(indexPath), 'summary.json'), 'utf8')).input_directory ?? sourceInputDirectory; } catch { /* Use default. */ }
const records = []; const groups = new Map(); const indexErrors = [];
let recordsRead = 0; let validCards = 0; let repairedIndexRecords = 0;
for await (const input of readJsonlRecords(indexPath)) {
  recordsRead += 1;
  if (!input.record) { indexErrors.push({ start_line: input.start_line, end_line: input.end_line, error: input.error }); continue; }
  if (input.repaired) repairedIndexRecords += 1;
  const record = input.record;
  if (!record.card || !['valid', 'valid_with_warnings'].includes(record.status)) continue;
  validCards += 1;
  const cardHash = cardHashOf(record).hash;
  records.push({ record, cardHash });
  const group = groups.get(cardHash) ?? { cardHash, records: [], model_input: cardModelInput(record.card, cardHash) };
  group.records.push(record); groups.set(cardHash, group);
}

const checkpointPath = join(batchDirectory, 'checkpoint.jsonl');
const completed = await readCheckpoint(checkpointPath, categoryNames, modelSettings.model);
// Rewrite only valid complete lines before appending, removing a possible partial trailing write.
await writeFile(checkpointPath, [...completed.values()].map((item) => JSON.stringify(item)).join('\n') + (completed.size ? '\n' : ''), 'utf8');
const checkpointHandle = await open(checkpointPath, 'a');
let checkpointQueue = Promise.resolve();
function saveCheckpoint(result) {
  const task = checkpointQueue.then(() => checkpointHandle.write(`${JSON.stringify(result)}\n`));
  checkpointQueue = task.catch(() => {}); return task;
}

const groupsWithoutContent = new Set();
const pending = [];
for (const group of groups.values()) {
  if (!hasSemanticContent(group.model_input)) groupsWithoutContent.add(group.cardHash);
  else if (!completed.has(group.cardHash)) pending.push(group);
}

const taxonomyForPrompt = taxonomy.categories.map(({ name, description, include, exclude }) => ({ name, description, include, exclude }));
const failed = new Map(); let modelRequestBatches = 0;
async function classifyBatch(batch) {
  let unresolved = batch;
  let lastError = null;
  for (let round = 1; round <= 3 && unresolved.length; round += 1) {
    try {
      modelRequestBatches += 1;
      const response = await requestModelJson(modelSettings, [
        { role: 'system', content: '你负责按已批准的分类体系整理角色卡。必须依据整体语义判断，词语是否出现不能作为确定性规则。返回严格 JSON：{"results":[{"id":"输入 id","decision":"classify|exclude|review","category":"classify 时必须是给定分类名，否则为 null","confidence":0到1,"reason":"简短中文理由"}]}。符合偏好政策中的避雷语义时用 exclude；信息不足、无法归入或真正不确定时用 review；其余必须且只能选择一个主分类。' },
        { role: 'user', content: JSON.stringify({ preference_policy: taxonomy.preference_policy ?? '', taxonomy: taxonomyForPrompt, cards: unresolved.map((group) => group.model_input) }) },
      ]);
      const rawResults = Array.isArray(response?.results) ? response.results : [];
      const byId = new Map(rawResults.map((item) => [String(item?.id ?? ''), item]));
      const next = [];
      for (const group of unresolved) {
        const result = normalizeDecision(byId.get(group.cardHash), categoryNames, modelSettings.model);
        if (!result || result.card_sha256 !== group.cardHash) { next.push(group); continue; }
        completed.set(group.cardHash, result); failed.delete(group.cardHash); await saveCheckpoint(result);
      }
      unresolved = next;
      if (unresolved.length) lastError = new Error(`模型响应遗漏或包含无效结果：${unresolved.length} 项`);
    } catch (error) { lastError = error; break; }
  }
  for (const group of unresolved) failed.set(group.cardHash, lastError?.message ?? '模型响应持续无效');
}

await runWorkers(chunks(pending, modelSettings.batchSize), modelSettings.concurrency, classifyBatch);
await checkpointQueue; await checkpointHandle.close();

const classificationsHandle = await open(join(batchDirectory, 'classifications.jsonl'), 'w');
const reviewHandle = await open(join(batchDirectory, 'review.csv'), 'w');
const errorsHandle = await open(join(batchDirectory, 'model-errors.jsonl'), 'w');
const indexErrorsHandle = await open(join(batchDirectory, 'index-errors.jsonl'), 'w');
await reviewHandle.write(csv(['relative_path', 'name', 'suggested_category', 'decision', 'confidence', 'needs_review', 'reason', 'human_category', 'review_notes']));
for (const error of indexErrors) await indexErrorsHandle.write(`${JSON.stringify(error)}\n`);
for (const [cardHash, error] of failed) await errorsHandle.write(`${JSON.stringify({ card_sha256: cardHash, error })}\n`);
const counts = new Map();
for (const { record, cardHash } of records) {
  let result;
  if (groupsWithoutContent.has(cardHash)) result = manualResult(record, '没有可供模型判断的语义字段');
  else if (completed.has(cardHash)) {
    const decision = completed.get(cardHash);
    result = {
      ...baseResult(record),
      category: decision.category,
      classification_source: 'model',
      model_decision: decision.decision,
      reason: decision.reason,
      confidence: decision.confidence,
      needs_review: decision.decision !== 'classify' || decision.confidence < modelSettings.confidenceThreshold,
      model_version: decision.model_version,
      prompt_version: decision.prompt_version,
    };
  } else result = manualResult(record, `模型调用未完成：${failed.get(cardHash) ?? '进程中断或结果缺失'}`, modelSettings.model);
  await classificationsHandle.write(`${JSON.stringify(result)}\n`);
  await reviewHandle.write(csv([result.relative_path, result.name, result.category, result.model_decision, result.confidence, result.needs_review, result.reason, '', '']));
  const key = result.needs_review ? 'needs_review' : 'classified'; counts.set(key, (counts.get(key) ?? 0) + 1);
}
await classificationsHandle.close(); await reviewHandle.close(); await errorsHandle.close(); await indexErrorsHandle.close();

const summary = {
  run_id: runId,
  generated_utc: new Date().toISOString(),
  source_index: indexPath,
  source_input_directory: sourceInputDirectory,
  taxonomy_file: taxonomyPath,
  taxonomy_sha256: taxonomySha256,
  records_read: recordsRead,
  valid_cards: validCards,
  unique_valid_cards: groups.size,
  unique_without_semantic_content: groupsWithoutContent.size,
  unique_completed_from_checkpoint: completed.size,
  unique_failed_or_incomplete: [...groups.keys()].filter((hash) => !completed.has(hash) && !groupsWithoutContent.has(hash)).length,
  repaired_index_records: repairedIndexRecords,
  invalid_index_records: indexErrors.length,
  suggestion_counts: [...counts.entries()].map(([type, count]) => ({ type, count })),
  categories: [...categoryNames],
  model_version: modelSettings.model,
  prompt_version: promptVersion,
  confidence_threshold: modelSettings.confidenceThreshold,
  model_request_batches_this_run: modelRequestBatches,
  resumed: Boolean(resumeArgument),
  resume_command: `node .\\src\\05-classify-character-cards.mjs --resume="${batchDirectory}"`,
};
await writeFile(join(batchDirectory, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(`全量模型分类建议已生成：${batchDirectory}`);
if (summary.unique_failed_or_incomplete) console.log(`仍有 ${summary.unique_failed_or_incomplete} 个唯一内容未完成，可使用 summary.json 中的 resume_command 断点续跑。`);
