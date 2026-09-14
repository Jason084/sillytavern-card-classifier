import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readJsonlRecords } from '../src/lib/read-jsonl.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'character-card-pipeline-'));
const input = join(temporary, 'input'); const scan = join(temporary, 'scan'); await mkdir(input); await mkdir(scan);
const standards = join(temporary, '分类标准.md');
const standardsText = '# 避雷偏好\n- 不接受扶她、男娘、R18G 或纯英文卡。\n\n# 明确可以接受\n- 同人、规则类、网红和现实人物可以正常分类。\n\n# 第一优先级\n同人\n规则模拟\n';
await writeFile(standards, standardsText, 'utf8');

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function card(name, tags = [], creator = '作者') {
  return { spec_version: '3.0', name, creator, tags, description: '', personality: '', scenario: '', creator_notes: '', first_mes: '', character_version: '' };
}
const definitions = [
  ['a/同名.png', 'same-file', 'card-one', { ...card('甲', ['同人']), description: '合法分隔符\u2028必须保留' }],
  ['b/同名.png', 'same-file', 'card-one', card('甲', ['同人'])],
  ['c/封面不同.png', 'other-cover', 'card-one', card('甲', ['同人'])],
  ['d/同名.png', 'new-version', 'card-two', { ...card('甲', ['规则']), description: '关键词不直接决定结果 line one\nline two' }],
  ['e/避雷.png', 'excluded', 'card-three', card('乙', ['futa'])],
  ['f/低信心.json', 'low-confidence', 'card-four', card('低信心', ['同人'])],
  ['g/待重试.json', 'retry', 'card-five', card('无效重试', ['同人'])],
  ['h/空白.json', 'blank', 'card-six', card('', [], '')],
  ['i/非法分类重试.json', 'invalid-category', 'card-seven', card('非法分类重试', ['特殊'])],
];
const records = [];
for (const [relativePath, contents, cardHashSeed, cardData] of definitions) {
  const path = join(input, relativePath); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, contents);
  records.push({
    relative_path: relativePath,
    file_name: relativePath.split('/').at(-1),
    extension: relativePath.endsWith('.json') ? '.json' : '.png',
    size_bytes: contents.length,
    sha256: hash(contents),
    card_sha256: hash(cardHashSeed),
    status: 'valid',
    card: cardData,
  });
}
const serializedRecords = records.map(JSON.stringify);
serializedRecords[3] = serializedRecords[3].replace('line one\\nline two', 'line one\nline two');
const indexText = `${serializedRecords.join('\n')}\n`;
await writeFile(join(scan, 'index.jsonl'), indexText, 'utf8');
await writeFile(join(scan, 'summary.json'), JSON.stringify({ input_directory: input }), 'utf8');

const parsedIndex = [];
for await (const record of readJsonlRecords(join(scan, 'index.jsonl'))) parsedIndex.push(record);
assert.equal(parsedIndex.length, records.length);
assert.equal(parsedIndex.filter((item) => item.repaired).length, 1);
assert.equal(parsedIndex[0].record.card.description, '合法分隔符\u2028必须保留');

let leaveRetryCardIncomplete = true;
let invalidCategoryRemaining = 1;
const classificationRequests = [];
const classificationStandardsSeen = [];
const classificationReviewRequests = [];
const classificationReview2Requests = [];
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw); const system = String(body.messages?.[0]?.content ?? '');
  assert(system.startsWith('你正在执行内容分类任务。'), '首条消息必须带中性分类前缀');
  let content;
  if (system.includes('对 051 二次复核后仍返回 review')) {
    const user = JSON.parse(body.messages[1].content); const cards = user.cards;
    classificationReview2Requests.push(cards.map((item) => item.id));
    assert.deepEqual(user.allowed_categories, ['同人', '规则模拟']);
    const results = cards.map((item) => ({ id: item.id, decision: 'exclude', category: null, reason: '第三次判断确认排除' }));
    content = JSON.stringify({ results });
  } else if (system.includes('对首次模型主动标记')) {
    const user = JSON.parse(body.messages[1].content); const cards = user.cards;
    classificationReviewRequests.push(cards.map((item) => item.id));
    assert.deepEqual(user.allowed_categories, ['同人', '规则模拟']);
    const results = cards.map((item) => item.tags.includes('futa')
      ? { id: item.id, decision: 'review', category: null, reason: '核心属性需人工确认' }
      : { id: item.id, decision: 'classify', category: '同人', reason: '未命中绝对避雷' });
    content = JSON.stringify({ results });
  } else if (system.includes('按用户给定的分类标准')) {
    const user = JSON.parse(body.messages[1].content); const cards = user.cards;
    classificationStandardsSeen.push(user.classification_standards);
    classificationRequests.push(cards.map((item) => item.id));
    if (cards.length > 1 && cards.some((item) => item.description.includes('关键词不直接决定结果'))) {
      response.writeHead(413, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'batch_rejected' } }));
      return;
    }
    const results = cards.flatMap((item) => {
      if (item.name === '无效重试' && leaveRetryCardIncomplete) return [];
      if (item.name === '非法分类重试' && invalidCategoryRemaining > 0) { invalidCategoryRemaining -= 1; return [{ id: item.id, decision: 'classify', category: '__模型内部__' }]; }
      if (item.name === '非法分类重试') return [{ id: item.id, decision: 'classify', category: '特殊设定' }];
      if (item.tags.includes('futa')) return [{ id: item.id, decision: 'exclude', category: null }];
      if (item.name === '低信心') return [{ id: item.id, decision: 'review', category: null }];
      if (item.description.includes('关键词不直接决定结果')) return [{ id: item.id, decision: 'classify', category: '现代都市' }];
      return [{ id: item.id, decision: 'classify', category: '同人' }];
    });
    content = JSON.stringify({ results });
  } else content = JSON.stringify({ error: 'unknown prompt' });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
const address = server.address();
const modelEnvironment = {
  MODEL_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  MODEL_NAME: 'mock-cheap-model',
  MODEL_BATCH_SIZE: '2',
  MODEL_CONCURRENCY: '2',
  MODEL_CONFIDENCE_THRESHOLD: '0.8',
};

async function run(script, args, { expectedCode = 0, environment = modelEnvironment } = {}) {
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'src', script), ...args], {
      env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject); child.once('exit', (code) => accept({ code, output }));
  });
  assert.equal(result.code, expectedCode, result.output); return result;
}
async function onlyDirectory(path) { const entries = await readdir(path); assert.equal(entries.length, 1); return join(path, entries[0]); }
async function jsonLines(path) { return (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }

try {
  const duplicatesReports = join(temporary, 'duplicates'); await run('030-detect-duplicates.mjs', [scan, duplicatesReports], { environment: {} });
  const duplicateDirectory = await onlyDirectory(duplicatesReports); const duplicateGroups = await jsonLines(join(duplicateDirectory, 'duplicate-groups.jsonl'));
  assert.equal(JSON.parse(await readFile(join(duplicateDirectory, 'summary.json'), 'utf8')).repaired_index_records, 1);
  assert(duplicateGroups.some((group) => group.type === 'exact_file_duplicate'));
  assert(duplicateGroups.some((group) => group.type === 'same_card_different_file'));
  assert(duplicateGroups.some((group) => group.type === 'same_filename_different_content'));
  assert(duplicateGroups.some((group) => group.type === 'suspected_version'));

  const noConfigReports = join(temporary, 'no-config-classifications');
  const noConfigEnvironment = { MODEL_API_BASE_URL: '', MODEL_API_KEY: '', MODEL_NAME: '' };
  await run('050-classify-character-cards.mjs', [scan, standards, noConfigReports], { expectedCode: 1, environment: noConfigEnvironment });
  await assert.rejects(readdir(noConfigReports), { code: 'ENOENT' });

  const classificationDryRunReports = join(temporary, 'classification-dry-run');
  const classificationRequestsBeforeDryRun = classificationRequests.length;
  const classificationDryRun = await run('050-classify-character-cards.mjs', [scan, standards, classificationDryRunReports, '--dry-run']);
  assert.equal(classificationRequests.length, classificationRequestsBeforeDryRun, '第五阶段预检不能发送模型请求');
  assert(classificationDryRun.output.includes('"initial_request_batches": 3'));
  const classificationDryRunDirectory = await onlyDirectory(classificationDryRunReports);
  const dryRunMetadata = JSON.parse(await readFile(join(classificationDryRunDirectory, 'run.json'), 'utf8'));
  assert.equal(dryRunMetadata.batch_size, 2); assert.equal(dryRunMetadata.max_http_requests, 1300);
  assert.equal(dryRunMetadata.standards_file, standards);

  const budgetedReports = join(temporary, 'budgeted-classifications');
  const oneRequestEnvironment = { ...modelEnvironment, MODEL_MAX_HTTP_REQUESTS: '1' };
  const requestsBeforeBudgetStop = classificationRequests.length;
  await run('050-classify-character-cards.mjs', [scan, standards, budgetedReports], { expectedCode: 1, environment: oneRequestEnvironment });
  const budgetedDirectory = await onlyDirectory(budgetedReports);
  const budgetedUsage = await jsonLines(join(budgetedDirectory, 'usage.jsonl'));
  assert.equal(budgetedUsage.filter((event) => event.event === 'request_reserved').length, 1);
  assert.equal(classificationRequests.length, requestsBeforeBudgetStop + 1, '额度为 1 时只能发出一次请求');
  const requestsBeforeExhaustedResume = classificationRequests.length;
  await run('050-classify-character-cards.mjs', [`--resume=${budgetedDirectory}`], { expectedCode: 1, environment: oneRequestEnvironment });
  assert.equal(classificationRequests.length, requestsBeforeExhaustedResume, '额度耗尽后续跑不能再发出请求');

  const classificationReports = join(temporary, 'classifications');
  const classificationEnvironment = { ...modelEnvironment, MODEL_BATCH_SIZE: '3' };
  const classificationRequestStart = classificationRequests.length;
  await run('050-classify-character-cards.mjs', [scan, standards, classificationReports], { environment: classificationEnvironment });
  const classificationDirectory = await onlyDirectory(classificationReports);
  const firstRunClassificationRequests = classificationRequests.slice(classificationRequestStart);
  assert.equal(firstRunClassificationRequests.filter((ids) => ids.includes(hash('card-four'))).length, 1, '遗漏一项后不能重发同批已成功项');
  assert(firstRunClassificationRequests.some((ids) => ids.length === 1 && ids[0] === hash('card-five')), '遗漏项必须单独补发');
  const firstSummary = JSON.parse(await readFile(join(classificationDirectory, 'summary.json'), 'utf8'));
  assert(classificationStandardsSeen.every((value) => value.includes('# 避雷偏好')), '每次模型分类都必须携带分类标准');
  assert.equal(firstSummary.unique_failed_or_incomplete, 1);
  assert.equal(firstSummary.unique_completed_from_checkpoint, 5);
  assert.equal(firstSummary.http_requests_total, (await jsonLines(join(classificationDirectory, 'usage.jsonl'))).filter((event) => event.event === 'request_reserved').length);
  assert(!('confidence_threshold' in firstSummary));
  const firstCheckpoint = await jsonLines(join(classificationDirectory, 'checkpoint.jsonl'));
  assert(firstCheckpoint.every((item) => !('confidence' in item) && !('reason' in item)));
  const reviewHeader = (await readFile(join(classificationDirectory, 'review.csv'), 'utf8')).split(/\r?\n/, 1)[0];
  assert(!reviewHeader.includes('confidence') && !reviewHeader.includes('reason'));
  const firstClassifications = await jsonLines(join(classificationDirectory, 'classifications.jsonl'));
  assert(firstClassifications.some((item) => item.name === '无效重试' && item.needs_review));
  assert.equal(firstClassifications.filter((item) => item.card_sha256 === hash('card-one') && item.classification_source === 'model').length, 3);
  assert(firstClassifications.some((item) => item.relative_path === 'd/同名.png' && item.category === '现代都市'));
  assert(firstClassifications.some((item) => item.category === '__排除复核__' && item.needs_review));
  assert(firstClassifications.some((item) => item.name === '低信心' && item.needs_review));
  assert(firstClassifications.some((item) => item.name === '' && item.needs_review));
  assert(firstClassifications.some((item) => item.name === '非法分类重试' && item.category === '特殊设定' && !item.needs_review));
  assert(firstClassifications.every((item) => !('tags' in item)), '最终分类结果不能保留易误解为多分类的原始 tags');
  assert(firstClassifications.every((item) => !('confidence' in item) && !('reason' in item)));

  const requestCountBeforeResume = classificationRequests.length;
  leaveRetryCardIncomplete = false;
  await writeFile(join(scan, 'index.jsonl'), `${indexText}\n`, 'utf8');
  const changedIndexResume = await run('050-classify-character-cards.mjs', [`--resume=${classificationDirectory}`], { expectedCode: 1, environment: classificationEnvironment });
  assert(changedIndexResume.output.includes('扫描索引内容与原批次不一致'));
  await writeFile(join(scan, 'index.jsonl'), indexText, 'utf8');
  await writeFile(standards, `${standardsText}\n- 临时变化\n`, 'utf8');
  const changedStandardsResume = await run('050-classify-character-cards.mjs', [`--resume=${classificationDirectory}`], { expectedCode: 1, environment: classificationEnvironment });
  assert(changedStandardsResume.output.includes('分类标准与原批次不一致'));
  await writeFile(standards, standardsText, 'utf8');
  const runMetadataPath = join(classificationDirectory, 'run.json');
  const runMetadata = JSON.parse(await readFile(runMetadataPath, 'utf8'));
  await writeFile(runMetadataPath, JSON.stringify({ ...runMetadata, prompt_version: 'obsolete-prompt' }, null, 2), 'utf8');
  const changedPromptResume = await run('050-classify-character-cards.mjs', [`--resume=${classificationDirectory}`], { expectedCode: 1, environment: classificationEnvironment });
  assert(changedPromptResume.output.includes('原提示词版本'));
  await writeFile(runMetadataPath, JSON.stringify(runMetadata, null, 2), 'utf8');
  await run('050-classify-character-cards.mjs', [`--resume=${classificationDirectory}`], { environment: classificationEnvironment });
  const resumedRequests = classificationRequests.slice(requestCountBeforeResume).flat();
  assert.deepEqual(new Set(resumedRequests), new Set([hash('card-five')]), '续跑只能请求此前未完成的唯一内容');
  const resumedSummary = JSON.parse(await readFile(join(classificationDirectory, 'summary.json'), 'utf8'));
  assert.equal(resumedSummary.resumed, true);
  assert.equal(resumedSummary.unique_failed_or_incomplete, 0);
  assert.equal(resumedSummary.unique_completed_from_checkpoint, 6);
  const classifications = await jsonLines(join(classificationDirectory, 'classifications.jsonl'));
  assert.equal(classifications.length, definitions.length, '续跑后最终结果不能重复');
  assert(classifications.some((item) => item.name === '无效重试' && item.category === '同人' && !item.needs_review));

  const classificationReviewReports = join(temporary, 'classification-reviews');
  const classificationReviewEnvironment = { ...modelEnvironment, MODEL_BATCH_SIZE: '2', MODEL_CONCURRENCY: '2' };
  const reviewRequestStart = classificationReviewRequests.length;
  await run('051-classify-character-cards.mjs', [classificationDirectory, standards, classificationReviewReports], { environment: classificationReviewEnvironment });
  const classificationReviewDirectory = await onlyDirectory(classificationReviewReports);
  const recheckRequests = classificationReviewRequests.slice(reviewRequestStart).flat();
  assert.deepEqual(new Set(recheckRequests), new Set([hash('card-three'), hash('card-four')]), '051 只能请求首次模型标记且有语义内容的唯一卡');
  const classificationReviewSummary = JSON.parse(await readFile(join(classificationReviewDirectory, 'summary.json'), 'utf8'));
  assert.equal(classificationReviewSummary.target_file_records, 3);
  assert.equal(classificationReviewSummary.target_unique_cards, 3);
  assert.equal(classificationReviewSummary.target_unique_without_semantic_content, 1);
  assert.equal(classificationReviewSummary.unique_completed_from_checkpoint, 2);
  assert.equal(classificationReviewSummary.unique_failed_or_incomplete, 0);
  assert.equal(classificationReviewSummary.remaining_needs_review_file_records, 2);
  assert.equal(classificationReviewSummary.http_request_limit, null);
  const mergedReviewClassifications = await jsonLines(join(classificationReviewDirectory, 'classifications.jsonl'));
  assert.equal(mergedReviewClassifications.length, definitions.length, '051 必须输出可供第六阶段使用的完整合并结果');
  assert(mergedReviewClassifications.some((item) => item.name === '低信心' && item.category === '同人' && !item.needs_review && item.classification_source === 'model_recheck'));
  assert(mergedReviewClassifications.some((item) => item.name === '乙' && item.model_decision === 'review' && item.recheck_reason));
  assert(mergedReviewClassifications.some((item) => item.name === '' && item.recheck_status === 'no_semantic_content'));
  assert.equal((await jsonLines(join(classificationReviewDirectory, 'rechecked-classifications.jsonl'))).length, 3);

  const classificationReview2Reports = join(temporary, 'classification-reviews-052');
  const classificationReview2Environment = { ...modelEnvironment, MODEL_BATCH_SIZE: '2', MODEL_CONCURRENCY: '2', MODEL_MAX_ATTEMPTS: '3' };
  const review2RequestStart = classificationReview2Requests.length;
  await run('052-classify-character-cards.mjs', [classificationReviewDirectory, standards, classificationReview2Reports], { environment: classificationReview2Environment });
  const classificationReview2Directory = await onlyDirectory(classificationReview2Reports);
  const recheck2Requests = classificationReview2Requests.slice(review2RequestStart).flat();
  assert.deepEqual(new Set(recheck2Requests), new Set([hash('card-three')]), '052 只能请求 051 完成后仍为 review 的唯一卡');
  const classificationReview2Summary = JSON.parse(await readFile(join(classificationReview2Directory, 'summary.json'), 'utf8'));
  assert.equal(classificationReview2Summary.target_file_records, 1);
  assert.equal(classificationReview2Summary.target_unique_cards, 1);
  assert.equal(classificationReview2Summary.unique_completed_from_checkpoint, 1);
  assert.equal(classificationReview2Summary.unique_failed_or_incomplete, 0);
  assert.equal(classificationReview2Summary.remaining_model_review_file_records, 1, '无语义内容的旧 review 不应被 052 假装解决');
  assert.equal(classificationReview2Summary.max_attempts, 3);
  const mergedReview2Classifications = await jsonLines(join(classificationReview2Directory, 'classifications.jsonl'));
  assert.equal(mergedReview2Classifications.length, definitions.length, '052 必须输出完整合并结果');
  assert(mergedReview2Classifications.some((item) => item.name === '乙' && item.model_decision === 'exclude' && item.classification_source === 'model_recheck_2' && item.recheck_2_reason));
  assert(mergedReview2Classifications.some((item) => item.name === '' && item.recheck_status === 'no_semantic_content'));
  assert.equal((await jsonLines(join(classificationReview2Directory, 'rechecked-classifications.jsonl'))).length, 1);

  const destination = join(temporary, 'organized'); const planReports = join(temporary, 'plans');
  await run('060-organize-character-cards.mjs', [classificationReview2Directory, destination, planReports], { environment: {} });
  const planDirectory = await onlyDirectory(planReports); const plan = await jsonLines(join(planDirectory, 'plan.jsonl'));
  assert.equal(plan.length, 9);
  assert.equal(new Set(plan.map((item) => item.destination_path)).size, 9);
  assert.equal(plan.filter((item) => item.model_decision === 'classify').length, 7);
  assert.equal(plan.find((item) => item.model_decision === 'exclude').category, '排除');
  assert.equal(plan.find((item) => item.model_decision === 'review').category, '未分类');
  assert.deepEqual(new Set(plan.filter((item) => item.category === '标准外').map((item) => item.original_category)), new Set(['现代都市', '特殊设定']));
  const organizationSummary = JSON.parse(await readFile(join(planDirectory, 'summary.json'), 'utf8'));
  assert.equal(organizationSummary.files_to_excluded_folder, 1);
  assert.equal(organizationSummary.files_to_unclassified_folder, 1);
  assert.equal(organizationSummary.files_classified, 7);
  assert.equal(organizationSummary.files_to_standard_categories, 5);
  assert.equal(organizationSummary.files_to_nonstandard_folder, 2);
  assert.equal(organizationSummary.files_planned, 9);
  const organizationApprovalPath = join(planDirectory, 'approval.json');
  const organizationApproval = JSON.parse(await readFile(organizationApprovalPath, 'utf8')); organizationApproval.approved = true;
  await writeFile(organizationApprovalPath, JSON.stringify(organizationApproval, null, 2), 'utf8');
  await run('060-organize-character-cards.mjs', ['--execute', planDirectory], { environment: {} });
  assert.equal((await readdir(join(destination, '同人'))).length, 5);
  assert.equal((await readdir(join(destination, '标准外'))).length, 2);
  assert.equal((await readdir(join(destination, '排除'))).length, 1);
  assert.equal((await readdir(join(destination, '未分类'))).length, 1);

  const collisionClassification = join(temporary, 'collision-classification'); await mkdir(collisionClassification);
  const collisionRows = [
    { ...classifications[0], category: '奇幻/冒险', needs_review: false },
    { ...classifications.find((item) => item.relative_path === 'd/同名.png'), category: '奇幻:冒险', needs_review: false },
  ];
  await writeFile(join(collisionClassification, 'classifications.jsonl'), `${collisionRows.map(JSON.stringify).join('\n')}\n`, 'utf8');
  await writeFile(join(collisionClassification, 'summary.json'), JSON.stringify({ source_input_directory: input, categories: ['奇幻/冒险', '奇幻:冒险'] }), 'utf8');
  const collisionPlanReports = join(temporary, 'collision-plans');
  const collisionResult = await run('060-organize-character-cards.mjs', [collisionClassification, join(temporary, 'collision-output'), collisionPlanReports], { expectedCode: 1, environment: {} });
  assert(collisionResult.output.includes('分类目录名冲突'));
  await assert.rejects(readdir(collisionPlanReports), { code: 'ENOENT' });

  const reservedClassification = join(temporary, 'reserved-classification'); await mkdir(reservedClassification);
  await writeFile(join(reservedClassification, 'classifications.jsonl'), `${JSON.stringify({ ...classifications[0], category: 'CON', needs_review: false })}\n`, 'utf8');
  await writeFile(join(reservedClassification, 'summary.json'), JSON.stringify({ source_input_directory: input, categories: ['CON'] }), 'utf8');
  const reservedResult = await run('060-organize-character-cards.mjs', [reservedClassification, join(temporary, 'reserved-output'), join(temporary, 'reserved-plans')], { expectedCode: 1, environment: {} });
  assert(reservedResult.output.includes('无效分类目录名'));

  console.log('第三、第五、第六阶段纯模型流水线及断点续跑测试通过');
} finally {
  await new Promise((accept) => server.close(accept));
}
