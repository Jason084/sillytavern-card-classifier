#!/usr/bin/env node
/*
 * 第四阶段：从去重后的代表性样本中，由便宜小模型归纳 12–20 个互斥主分类。
 * 输出 taxonomy.json、review.md 和默认未批准的 approval.json，不修改角色卡或分类标准。
 */
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { readJsonlRecords } from './lib/read-jsonl.mjs';
import { cardHashOf } from './lib/card-hash.mjs';
import {
  cardModelInput, modelSettingsFromEnv, requestModelJson, runWorkers, sha256Text,
} from './lib/model-client.mjs';

const root = resolve(import.meta.dirname, '..');
const scansDirectory = join(root, 'reports', 'scans');
const indexArgument = process.argv[2];
const standardsPath = resolve(process.argv[3] ?? join(root, '分类标准.md'));
const reportsDirectory = resolve(process.argv[4] ?? join(root, 'reports', 'classification-trials'));
const sampleSize = Number.parseInt(process.argv[5] ?? '800', 10);
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const batchDirectory = join(reportsDirectory, runId);
const promptVersion = 'taxonomy-v2';
if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new Error('样本数必须是正整数');

function score(value) { return sha256Text(value); }
function normalized(value) { return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN'); }
function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function latestIndex(directory) {
  const candidates = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, 'index.jsonl');
    try { if ((await stat(path)).isFile()) candidates.push(path); } catch { /* Ignore incomplete batches. */ }
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

function normalizeCategory(raw) {
  const name = String(raw?.name ?? '').trim();
  const description = String(raw?.description ?? '').trim();
  const include = Array.isArray(raw?.include) ? raw.include.map(String).map((item) => item.trim()).filter(Boolean) : [];
  const exclude = Array.isArray(raw?.exclude) ? raw.exclude.map(String).map((item) => item.trim()).filter(Boolean) : [];
  if (!name || !description || !include.length || !exclude.length) return null;
  return { name, description, include, exclude };
}

const modelSettings = modelSettingsFromEnv();
const indexPath = await inputIndex(indexArgument);
const policy = await readFile(standardsPath, 'utf8');
await stat(indexPath);

const uniqueCards = new Map(); const tagCounts = new Map();
let recordsRead = 0; let validCards = 0; let repairedIndexRecords = 0; let invalidIndexRecords = 0;
for await (const input of readJsonlRecords(indexPath)) {
  recordsRead += 1;
  if (!input.record) { invalidIndexRecords += 1; continue; }
  if (input.repaired) repairedIndexRecords += 1;
  const record = input.record;
  if (!record.card || !['valid', 'valid_with_warnings'].includes(record.status)) continue;
  validCards += 1;
  const cardHash = cardHashOf(record).hash;
  if (uniqueCards.has(cardHash)) continue;
  const tags = (record.card.tags ?? []).map((tag) => String(tag).trim()).filter(Boolean);
  const item = {
    card_sha256: cardHash,
    relative_path: record.relative_path,
    spec_version: record.card.spec_version,
    status: record.status,
    tags,
    sample_score: score(`${cardHash}\u0000${record.relative_path}`),
    model_input: cardModelInput(record.card, cardHash),
  };
  uniqueCards.set(cardHash, item);
  for (const tag of new Set(tags.map(normalized).filter(Boolean))) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
}

const items = [...uniqueCards.values()];
if (!items.length) throw new Error('扫描索引中没有可用于归纳分类的有效角色卡');
const frequentTags = new Set([...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 60).map(([tag]) => tag));
const rareTags = new Set([...tagCounts].filter(([, count]) => count <= 5).sort((a, b) => score(a[0]).localeCompare(score(b[0]))).slice(0, 80).map(([tag]) => tag));
const strata = new Map();
function addToStratum(name, item) { const values = strata.get(name) ?? []; values.push(item); strata.set(name, values); }
for (const item of items) {
  addToStratum(`spec:${item.spec_version}`, item);
  addToStratum(`status:${item.status}`, item);
  if (!item.tags.length) addToStratum('tags:none', item);
  for (const tag of new Set(item.tags.map(normalized))) {
    if (frequentTags.has(tag)) addToStratum(`frequent-tag:${tag}`, item);
    if (rareTags.has(tag)) addToStratum(`rare-tag:${tag}`, item);
  }
  addToStratum('all', item);
}
for (const values of strata.values()) values.sort((a, b) => a.sample_score.localeCompare(b.sample_score));
const selected = []; const selectedHashes = new Set(); const positions = new Map();
const stratumNames = [...strata.keys()].sort((a, b) => {
  const rank = (name) => name.startsWith('spec:') ? 0 : name.startsWith('status:') ? 1 : name.startsWith('frequent-tag:') ? 2 : name.startsWith('rare-tag:') ? 3 : name === 'tags:none' ? 4 : 5;
  return rank(a) - rank(b) || a.localeCompare(b);
});
while (selected.length < Math.min(sampleSize, items.length)) {
  let added = false;
  for (const name of stratumNames) {
    const values = strata.get(name); let position = positions.get(name) ?? 0;
    while (position < values.length && selectedHashes.has(values[position].card_sha256)) position += 1;
    positions.set(name, position + 1);
    if (position >= values.length) continue;
    selected.push({ ...values[position], sample_stratum: name }); selectedHashes.add(values[position].card_sha256); added = true;
    if (selected.length >= Math.min(sampleSize, items.length)) break;
  }
  if (!added) break;
}

await mkdir(batchDirectory, { recursive: true });
const sampleHandle = await open(join(batchDirectory, 'sample.jsonl'), 'w');
for (const item of selected) {
  const { sample_score: ignored, ...output } = item;
  await sampleHandle.write(`${JSON.stringify(output)}\n`);
}
await sampleHandle.close();

const sampleBatches = chunks(selected, modelSettings.batchSize);
const proposals = new Array(sampleBatches.length);
await runWorkers(sampleBatches, modelSettings.concurrency, async (batch, index) => {
  const response = await requestModelJson(modelSettings, [
    { role: 'system', content: '你负责从角色卡样本中归纳便于文件夹整理的主题分类候选。分类依据必须是整体语义，不能把词语是否出现当作确定性规则。返回严格 JSON：{"categories":[{"name":"中文短名称","description":"边界说明","include":["应纳入的语义"],"exclude":["易混淆但不纳入的语义"]}]}。本批提出 6–12 个候选。' },
    { role: 'user', content: JSON.stringify({ preference_policy: policy, samples: batch.map((item) => item.model_input) }) },
  ]);
  if (!Array.isArray(response?.categories) || !response.categories.length) throw new Error(`第 ${index + 1} 个样本批次未返回分类候选`);
  proposals[index] = response.categories.map(normalizeCategory).filter(Boolean);
  if (!proposals[index].length) throw new Error(`第 ${index + 1} 个样本批次的分类候选全部无效`);
});

const proposalHandle = await open(join(batchDirectory, 'proposals.jsonl'), 'w');
for (let index = 0; index < proposals.length; index += 1) await proposalHandle.write(`${JSON.stringify({ batch: index, categories: proposals[index] })}\n`);
await proposalHandle.close();

// Keep the final consolidation request within the context window of inexpensive models.
let consolidationInput = proposals; let consolidationRounds = 0;
while (JSON.stringify(consolidationInput).length > 50_000) {
  consolidationRounds += 1;
  if (consolidationRounds > 4) throw new Error('分类候选在四轮压缩后仍过大，请降低 MODEL_BATCH_SIZE 或样本数');
  const inputGroups = chunks(consolidationInput, 10); const reduced = new Array(inputGroups.length);
  await runWorkers(inputGroups, modelSettings.concurrency, async (group, index) => {
    const response = await requestModelJson(modelSettings, [
      { role: 'system', content: '你负责压缩多批角色卡分类候选：合并同义项并保留重要的纳入、排除边界，返回 8–16 个候选。严格返回 JSON：{"categories":[{"name":"中文短名称","description":"边界说明","include":["应纳入的语义"],"exclude":["易混淆但不纳入的语义"]}]}。' },
      { role: 'user', content: JSON.stringify({ preference_policy: policy, candidate_batches: group }) },
    ]);
    reduced[index] = Array.isArray(response?.categories) ? response.categories.map(normalizeCategory).filter(Boolean) : [];
    if (!reduced[index].length) throw new Error(`第 ${consolidationRounds} 轮第 ${index + 1} 组候选压缩失败`);
  });
  consolidationInput = reduced;
  const reducedHandle = await open(join(batchDirectory, `consolidation-round-${consolidationRounds}.jsonl`), 'w');
  for (let index = 0; index < reduced.length; index += 1) await reducedHandle.write(`${JSON.stringify({ group: index, categories: reduced[index] })}\n`);
  await reducedHandle.close();
}

const consolidated = await requestModelJson(modelSettings, [
  { role: 'system', content: '你负责把多批角色卡分类候选合并为 12–20 个互斥、稳定、适合文件夹整理的中文主分类。合并同义类别，明确相邻类别边界，不把“排除”“其他”“待复核”列为主分类。必须返回严格 JSON：{"categories":[{"name":"中文短名称","description":"边界说明","include":["应纳入的语义"],"exclude":["易混淆但不纳入的语义"]}]}。' },
  { role: 'user', content: JSON.stringify({ preference_policy: policy, candidate_batches: consolidationInput }) },
]);
const categories = Array.isArray(consolidated?.categories) ? consolidated.categories.map(normalizeCategory).filter(Boolean) : [];
const uniqueNames = new Set(categories.map((category) => normalized(category.name)));
if (categories.length < 12 || categories.length > 20 || uniqueNames.size !== categories.length) {
  throw new Error(`模型汇总的主分类必须为 12–20 个且名称唯一，实际得到 ${categories.length} 个`);
}

const taxonomy = {
  schema_version: 1,
  generated_utc: new Date().toISOString(),
  run_id: runId,
  model_version: modelSettings.model,
  prompt_version: promptVersion,
  source_index: indexPath,
  policy_file: standardsPath,
  policy_sha256: sha256Text(policy),
  preference_policy: policy,
  requested_sample_size: sampleSize,
  actual_sample_size: selected.length,
  unique_valid_cards: items.length,
  categories,
};
const taxonomyText = `${JSON.stringify(taxonomy, null, 2)}\n`;
const taxonomySha256 = sha256Text(taxonomyText);
await writeFile(join(batchDirectory, 'taxonomy.json'), taxonomyText, 'utf8');
const review = [
  '# 模型归纳的主分类', '',
  `- 模型：${modelSettings.model}`,
  `- 去重样本：${selected.length} / ${items.length}`,
  `- taxonomy SHA-256：${taxonomySha256}`, '',
  ...categories.flatMap((category, index) => [
    `## ${index + 1}. ${category.name}`, '', category.description, '',
    `纳入：${category.include.join('；')}`, '', `排除：${category.exclude.join('；')}`, '',
  ]),
  '确认这些类别及边界后，将 approval.json 中的 approved 改为 true。若修改 taxonomy.json，必须重新生成本批次，不能沿用原批准文件。', '',
].join('\n');
await writeFile(join(batchDirectory, 'review.md'), review, 'utf8');
await writeFile(join(batchDirectory, 'approval.json'), JSON.stringify({
  taxonomy_run_id: runId,
  approved: false,
  taxonomy_sha256: taxonomySha256,
  instruction: '人工检查 review.md 和 taxonomy.json 后，将 approved 改为 true；修改 taxonomy.json 后原批准文件失效。',
}, null, 2), 'utf8');
await writeFile(join(batchDirectory, 'summary.json'), JSON.stringify({
  run_id: runId,
  generated_utc: new Date().toISOString(),
  source_index: indexPath,
  records_read: recordsRead,
  valid_cards: validCards,
  unique_valid_cards: items.length,
  repaired_index_records: repairedIndexRecords,
  invalid_index_records: invalidIndexRecords,
  requested_sample_size: sampleSize,
  actual_sample_size: selected.length,
  model_version: modelSettings.model,
  prompt_version: promptVersion,
  proposal_batches: proposals.length,
  consolidation_rounds: consolidationRounds,
  category_count: categories.length,
  taxonomy_sha256: taxonomySha256,
}, null, 2), 'utf8');
console.log(`模型分类体系已生成，等待人工批准：${batchDirectory}`);
