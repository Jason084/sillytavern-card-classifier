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
await writeFile(standards, '# 避雷偏好\n- 不接受扶她、男娘、R18G 或纯英文卡。\n\n# 明确可以接受\n- 同人、规则类、网红和现实人物可以正常分类。\n', 'utf8');

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
await writeFile(join(scan, 'index.jsonl'), `${serializedRecords.join('\n')}\n`, 'utf8');
await writeFile(join(scan, 'summary.json'), JSON.stringify({ input_directory: input }), 'utf8');

const parsedIndex = [];
for await (const record of readJsonlRecords(join(scan, 'index.jsonl'))) parsedIndex.push(record);
assert.equal(parsedIndex.length, records.length);
assert.equal(parsedIndex.filter((item) => item.repaired).length, 1);
assert.equal(parsedIndex[0].record.card.description, '合法分隔符\u2028必须保留');

const categoryNames = ['同人', '规则机制', '现代都市', '科幻未来', '奇幻冒险', '校园青春', '恐怖悬疑', '历史古风', '恋爱陪伴', '战斗冒险', '日常生活', '特殊设定'];
const categories = categoryNames.map((name) => ({ name, description: `${name}的明确语义边界`, include: [`属于${name}的内容`], exclude: [`仅与${name}表面相似的内容`] }));
let taxonomyInvalidJsonRemaining = 1;
let leaveRetryCardIncomplete = true;
const classificationRequests = [];
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw); const system = String(body.messages?.[0]?.content ?? '');
  let content;
  if (system.includes('归纳便于文件夹整理')) {
    if (taxonomyInvalidJsonRemaining > 0) { taxonomyInvalidJsonRemaining -= 1; content = 'not-json'; }
    else content = JSON.stringify({ categories: categories.slice(0, 8) });
  } else if (system.includes('合并为 12–20 个')) content = JSON.stringify({ categories });
  else if (system.includes('已批准的分类体系')) {
    const user = JSON.parse(body.messages[1].content); const cards = user.cards;
    classificationRequests.push(cards.map((item) => item.id));
    const results = cards.flatMap((item) => {
      if (item.name === '无效重试' && leaveRetryCardIncomplete) return [];
      if (item.tags.includes('futa')) return [{ id: item.id, decision: 'exclude', category: null, confidence: 0.99, reason: '整体语义符合避雷偏好' }];
      if (item.name === '低信心') return [{ id: item.id, decision: 'classify', category: '同人', confidence: 0.5, reason: '可能属于同人，但证据不足' }];
      if (item.description.includes('关键词不直接决定结果')) return [{ id: item.id, decision: 'classify', category: '现代都市', confidence: 0.95, reason: '整体场景更接近现代都市' }];
      return [{ id: item.id, decision: 'classify', category: '同人', confidence: 0.96, reason: '整体语义属于同人' }];
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
  const duplicatesReports = join(temporary, 'duplicates'); await run('03-detect-duplicates.mjs', [scan, duplicatesReports], { environment: {} });
  const duplicateDirectory = await onlyDirectory(duplicatesReports); const duplicateGroups = await jsonLines(join(duplicateDirectory, 'duplicate-groups.jsonl'));
  assert.equal(JSON.parse(await readFile(join(duplicateDirectory, 'summary.json'), 'utf8')).repaired_index_records, 1);
  assert(duplicateGroups.some((group) => group.type === 'exact_file_duplicate'));
  assert(duplicateGroups.some((group) => group.type === 'same_card_different_file'));
  assert(duplicateGroups.some((group) => group.type === 'same_filename_different_content'));
  assert(duplicateGroups.some((group) => group.type === 'suspected_version'));

  const noConfigReports = join(temporary, 'no-config-trials');
  const noConfigEnvironment = { MODEL_API_BASE_URL: '', MODEL_NAME: '' };
  await run('04-classification-trial.mjs', [scan, standards, noConfigReports, '8'], { expectedCode: 1, environment: noConfigEnvironment });

  const trialReports = join(temporary, 'trials'); await run('04-classification-trial.mjs', [scan, standards, trialReports, '8']);
  const trialDirectory = await onlyDirectory(trialReports);
  const taxonomy = JSON.parse(await readFile(join(trialDirectory, 'taxonomy.json'), 'utf8'));
  assert.equal(taxonomy.categories.length, 12);
  assert.equal((await jsonLines(join(trialDirectory, 'sample.jsonl'))).length, 6);
  assert.equal(taxonomyInvalidJsonRemaining, 0, '模型 JSON 失败后应重试');

  const unapprovedReports = join(temporary, 'unapproved-classifications');
  await run('05-classify-character-cards.mjs', [scan, trialDirectory, unapprovedReports], { expectedCode: 1 });
  await assert.rejects(readdir(unapprovedReports), { code: 'ENOENT' });

  const approvalPath = join(trialDirectory, 'approval.json'); const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  approval.approved = true; await writeFile(approvalPath, JSON.stringify(approval, null, 2), 'utf8');

  const classificationReports = join(temporary, 'classifications');
  await run('05-classify-character-cards.mjs', [scan, trialDirectory, classificationReports]);
  const classificationDirectory = await onlyDirectory(classificationReports);
  const firstSummary = JSON.parse(await readFile(join(classificationDirectory, 'summary.json'), 'utf8'));
  assert.equal(firstSummary.unique_failed_or_incomplete, 1);
  assert.equal(firstSummary.unique_completed_from_checkpoint, 4);
  const firstClassifications = await jsonLines(join(classificationDirectory, 'classifications.jsonl'));
  assert(firstClassifications.some((item) => item.name === '无效重试' && item.reason.includes('未完成')));
  assert.equal(firstClassifications.filter((item) => item.card_sha256 === hash('card-one') && item.classification_source === 'model').length, 3);
  assert(firstClassifications.some((item) => item.relative_path === 'd/同名.png' && item.category === '现代都市'));
  assert(firstClassifications.some((item) => item.category === '__排除复核__' && item.needs_review));
  assert(firstClassifications.some((item) => item.name === '低信心' && item.needs_review));
  assert(firstClassifications.some((item) => item.name === '' && item.reason.includes('没有可供模型判断')));

  const requestCountBeforeResume = classificationRequests.length;
  leaveRetryCardIncomplete = false;
  await run('05-classify-character-cards.mjs', [`--resume=${classificationDirectory}`]);
  const resumedRequests = classificationRequests.slice(requestCountBeforeResume).flat();
  assert.deepEqual(new Set(resumedRequests), new Set([hash('card-five')]), '续跑只能请求此前未完成的唯一内容');
  const resumedSummary = JSON.parse(await readFile(join(classificationDirectory, 'summary.json'), 'utf8'));
  assert.equal(resumedSummary.resumed, true);
  assert.equal(resumedSummary.unique_failed_or_incomplete, 0);
  assert.equal(resumedSummary.unique_completed_from_checkpoint, 5);
  const classifications = await jsonLines(join(classificationDirectory, 'classifications.jsonl'));
  assert.equal(classifications.length, definitions.length, '续跑后最终结果不能重复');
  assert(classifications.some((item) => item.name === '无效重试' && item.category === '同人' && !item.needs_review));

  const destination = join(temporary, 'organized'); const planReports = join(temporary, 'plans');
  await run('06-organize-character-cards.mjs', [classificationDirectory, destination, planReports], { environment: {} });
  const planDirectory = await onlyDirectory(planReports); const plan = await jsonLines(join(planDirectory, 'plan.jsonl'));
  assert.equal(plan.length, 5);
  assert.equal(new Set(plan.map((item) => item.destination_path)).size, 5);
  const organizationApprovalPath = join(planDirectory, 'approval.json');
  const organizationApproval = JSON.parse(await readFile(organizationApprovalPath, 'utf8')); organizationApproval.approved = true;
  await writeFile(organizationApprovalPath, JSON.stringify(organizationApproval, null, 2), 'utf8');
  await run('06-organize-character-cards.mjs', ['--execute', planDirectory], { environment: {} });
  assert.equal((await readdir(join(destination, '同人'))).length, 4);

  console.log('第三至第六阶段纯模型流水线及断点续跑测试通过');
} finally {
  await new Promise((accept) => server.close(accept));
}
