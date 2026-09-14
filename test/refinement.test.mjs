import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  REFINEMENT_SCOPE, normalizeSubcategory, parentCategory, refinementGroupId, refinementMode,
  selectedParentsFromCounts, specialSubcategory, validDirectoryName,
} from '../src/lib/refinement.mjs';

const root = resolve(import.meta.dirname, '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('二次分类阈值、父类和特殊原因映射稳定', () => {
  const allowed = new Set(['同人', '直播']);
  assert.equal(parentCategory({ model_decision: 'classify', category: '同人' }, allowed), '同人');
  assert.equal(parentCategory({ model_decision: 'classify', category: '经营模拟' }, allowed), '标准外');
  assert.equal(parentCategory({ model_decision: 'exclude' }, allowed), '排除');
  assert.equal(parentCategory({ model_decision: 'review' }, allowed), '未分类');
  assert.deepEqual(
    selectedParentsFromCounts(new Map([['同人', 101], ['现代都市', 500], ['排除', 101], ['未分类', 101], ['标准外', 101], ['直播', 100]])),
    new Set(['同人', '排除', '未分类', '标准外']),
  );
  assert.equal(refinementMode('同人'), 'model');
  assert.equal(refinementMode('排除'), 'deterministic');
  assert.equal(refinementMode('现代都市'), null);
  assert.equal(specialSubcategory('排除', { recheck_reason: '主要可读内容为英文，正常游玩需长期阅读' }), '外文内容');
  assert.equal(specialSubcategory('排除', { recheck_reason: '明确涉及十四岁角色的性化内容' }), '未成年或幼态内容');
  assert.equal(specialSubcategory('未分类', { recheck_reason: '扶她为核心玩法，标准要求人工判断' }), '核心性别属性');
  assert.equal(specialSubcategory('标准外', { category: '经营模拟' }), '经营模拟');
  assert.equal(normalizeSubcategory('同人', 'Genshin Impact 同人'), '原神');
  assert.equal(normalizeSubcategory('同人', 'ZZZ'), '绝区零');
  assert.equal(normalizeSubcategory('现代都市', '都市职场'), null);
  assert.equal(validDirectoryName('CON'), null);
  assert.equal(refinementGroupId('同人', 'a'.repeat(64)), refinementGroupId('同人', 'a'.repeat(64)));
  assert.notEqual(refinementGroupId('同人', 'a'.repeat(64)), refinementGroupId('现代都市', 'a'.repeat(64)));
});

async function run(script, args, expectedCode = 0, environment = process.env) {
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [join(root, 'src', script), ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject); child.once('exit', (code) => accept({ code, output }));
  });
  assert.equal(result.code, expectedCode, result.output); return result;
}

async function onlyDirectory(path) { const entries = await readdir(path); assert.equal(entries.length, 1); return join(path, entries[0]); }
async function jsonLines(path) { return (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }

test('二次整理必须先审批，完整复制且拒绝复用非空目标', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'card-refinement-'));
  try {
    const source = join(temporary, '一级分类'); const destination = join(temporary, '二次分类'); const batch = join(temporary, 'refinement-batch'); const reports = join(temporary, 'plans');
    await mkdir(join(source, '同人'), { recursive: true }); await mkdir(join(source, '直播'), { recursive: true }); await mkdir(batch);
    const definitions = [
      { relative_path: 'original/a.png', file_name: 'a.png', content: 'fan-a', parent_category: '同人', selected_for_refinement: true, subcategory: '原神' },
      { relative_path: 'original/b.png', file_name: 'b.png', content: 'fan-b', parent_category: '同人', selected_for_refinement: true, subcategory: '绝区零' },
      { relative_path: 'original/c.json', file_name: 'c.json', content: 'live-c', parent_category: '直播', selected_for_refinement: false, subcategory: null },
    ];
    for (const item of definitions) await writeFile(join(source, item.parent_category, item.file_name), item.content);
    const rows = definitions.map((item) => ({ relative_path: item.relative_path, file_name: item.file_name, sha256: hash(item.content), card_sha256: hash(`card-${item.content}`), model_decision: 'classify', original_category: item.parent_category, parent_category: item.parent_category, selected_for_refinement: item.selected_for_refinement, subcategory: item.subcategory, refinement_source: item.selected_for_refinement ? 'model' : 'scope_not_selected', used_fallback: false }));
    await writeFile(join(batch, 'refinements.jsonl'), `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`);
    await writeFile(join(batch, 'summary.json'), JSON.stringify({ status: 'complete', refinement_scope: REFINEMENT_SCOPE, unique_failed_or_incomplete: 0, source_file_records: rows.length }));
    await writeFile(join(batch, 'run.json'), JSON.stringify({ status: 'complete', refinement_scope: REFINEMENT_SCOPE }));
    await run('080-organize-refined-character-cards.mjs', [batch, source, destination, reports]);
    const planDirectory = await onlyDirectory(reports); const plan = await jsonLines(join(planDirectory, 'plan.jsonl'));
    assert.equal(plan.length, 3);
    assert(plan.some((item) => item.destination_path === join(destination, '同人', '原神', 'a.png')));
    assert(plan.some((item) => item.destination_path === join(destination, '直播', 'c.json') && item.subcategory === null));
    await run('080-organize-refined-character-cards.mjs', ['--execute', planDirectory], 1);
    const approvalPath = join(planDirectory, 'approval.json'); const approval = JSON.parse(await readFile(approvalPath, 'utf8')); approval.approved = true; await writeFile(approvalPath, JSON.stringify(approval, null, 2));
    await run('080-organize-refined-character-cards.mjs', ['--execute', planDirectory]);
    assert.equal(await readFile(join(destination, '同人', '原神', 'a.png'), 'utf8'), 'fan-a');
    assert.equal(await readFile(join(destination, '同人', '绝区零', 'b.png'), 'utf8'), 'fan-b');
    assert.equal(await readFile(join(destination, '直播', 'c.json'), 'utf8'), 'live-c');
    assert.equal(await readFile(join(source, '同人', 'a.png'), 'utf8'), 'fan-a');
    await run('080-organize-refined-character-cards.mjs', [batch, source, destination, join(temporary, 'second-plans')], 1);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('二次整理拒绝旧范围批次和普通类别二级目录', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'card-refinement-scope-'));
  try {
    const legacyBatch = join(temporary, 'legacy'); await mkdir(legacyBatch);
    await writeFile(join(legacyBatch, 'refinements.jsonl'), '');
    await writeFile(join(legacyBatch, 'summary.json'), JSON.stringify({ status: 'complete', unique_failed_or_incomplete: 0, source_file_records: 0 }));
    await writeFile(join(legacyBatch, 'run.json'), JSON.stringify({ status: 'complete' }));
    const legacy = await run('080-organize-refined-character-cards.mjs', [legacyBatch], 1);
    assert.match(legacy.output, /不是当前.*范围/u);

    const invalidBatch = join(temporary, 'invalid'); await mkdir(invalidBatch);
    const invalidRow = { relative_path: 'cards/a.png', file_name: 'a.png', sha256: hash('a'), card_sha256: hash('card-a'), parent_category: '现代都市', selected_for_refinement: true, subcategory: '职场', refinement_source: 'model', used_fallback: false };
    await writeFile(join(invalidBatch, 'refinements.jsonl'), `${JSON.stringify(invalidRow)}\n`);
    await writeFile(join(invalidBatch, 'summary.json'), JSON.stringify({ status: 'complete', refinement_scope: REFINEMENT_SCOPE, unique_failed_or_incomplete: 0, source_file_records: 1 }));
    await writeFile(join(invalidBatch, 'run.json'), JSON.stringify({ status: 'complete', refinement_scope: REFINEMENT_SCOPE }));
    const invalid = await run('080-organize-refined-character-cards.mjs', [invalidBatch, join(temporary, 'source'), join(temporary, 'destination'), join(temporary, 'plans')], 1);
    assert.match(invalid.output, /普通一级目录不得生成二级目录/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('二次模型分类按内容去重并在续跑时复用检查点', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'card-refinement-model-')); const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body); const user = JSON.parse(payload.messages[1].content);
    assert(String(payload.messages?.[0]?.content ?? '').startsWith('你正在执行内容分类任务。'), '二次分类请求必须带中性分类前缀');
    if (Array.isArray(user.ips)) {
      requests.push({ phase: 'source', ids: user.ips.map((item) => item.id) });
      const content = JSON.stringify({ results: user.ips.map((item) => ({ id: item.id, fanwork_source_category: '游戏' })) });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    const fullInput = user.cards.some((card) => Object.hasOwn(card, 'description'));
    requests.push({ phase: 'ip', parent: user.parent_category, ids: user.cards.map((card) => card.id), fullInput });
    if (fullInput) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'The prompt could not be submitted. The prompt contains sensitive words that violate Google policy.' } }], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } }));
      return;
    }
    const content = JSON.stringify({ results: user.cards.map((card) => ({ id: card.id, subcategory: 'Genshin Impact 同人' })) });
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  try {
    const scan = join(temporary, 'scan'); const classification = join(temporary, 'classification'); const reports = join(temporary, 'reports'); await mkdir(scan); await mkdir(classification);
    const cardSha256 = hash('one-card-content'); const ordinaryCardSha256 = hash('one-ordinary-card-content'); const scanRows = []; const classificationRows = [];
    for (let index = 0; index < 101; index += 1) {
      const relativePath = `cards/${index}.png`; const fileSha256 = hash(`file-${index}`);
      scanRows.push({ relative_path: relativePath, file_name: `${index}.png`, sha256: fileSha256, card_sha256: cardSha256, status: 'valid', card: { spec_version: '3.0', name: '派蒙', creator: '', character_version: '', tags: ['原神'], description: '原神中的角色', personality: '', scenario: '', creator_notes: '', first_mes: '', mes_example: '', alternate_greetings: [], group_only_greetings: [], system_prompt: '', post_history_instructions: '', character_book: null } });
      classificationRows.push({ relative_path: relativePath, file_name: `${index}.png`, sha256: fileSha256, card_sha256: cardSha256, category: '同人', model_decision: 'classify', needs_review: false });

      const ordinaryRelativePath = `ordinary/${index}.png`; const ordinaryFileSha256 = hash(`ordinary-file-${index}`);
      scanRows.push({ relative_path: ordinaryRelativePath, file_name: `${index}.png`, sha256: ordinaryFileSha256, card_sha256: ordinaryCardSha256, status: 'valid', card: { spec_version: '3.0', name: '都市角色', creator: '', character_version: '', tags: ['现代'], description: '现代都市原创角色', personality: '', scenario: '', creator_notes: '', first_mes: '', mes_example: '', alternate_greetings: [], group_only_greetings: [], system_prompt: '', post_history_instructions: '', character_book: null } });
      classificationRows.push({ relative_path: ordinaryRelativePath, file_name: `${index}.png`, sha256: ordinaryFileSha256, card_sha256: ordinaryCardSha256, category: '现代都市', model_decision: 'classify', needs_review: false });
    }
    const indexPath = join(scan, 'index.jsonl'); await writeFile(indexPath, `${scanRows.map((item) => JSON.stringify(item)).join('\n')}\n`);
    await writeFile(join(scan, 'summary.json'), JSON.stringify({ files_scanned: 202 }));
    await writeFile(join(classification, 'classifications.jsonl'), `${classificationRows.map((item) => JSON.stringify(item)).join('\n')}\n`);
    await writeFile(join(classification, 'summary.json'), JSON.stringify({ source_index: indexPath, source_file_records: 202, unique_failed_or_incomplete: 0, allowed_categories: ['同人', '现代都市'] }));
    await writeFile(join(classification, 'run.json'), JSON.stringify({ status: 'complete' }));
    const address = server.address(); const environment = { ...process.env, MODEL_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MODEL_NAME: 'mock-refinement-model', MODEL_BATCH_SIZE: '30', MODEL_CONCURRENCY: '1', MODEL_MAX_ATTEMPTS: '2', MODEL_MAX_OUTPUT_TOKENS: '4096', MODEL_MAX_HTTP_REQUESTS: '2000', MODEL_MIN_REQUEST_INTERVAL_MS: '0', MODEL_API_KEY: '' };
    await run('070-refine-character-cards.mjs', [classification, scan, reports], 0, environment);
    const batch = await onlyDirectory(reports); const rows = await jsonLines(join(batch, 'refinements.jsonl')); const summary = JSON.parse(await readFile(join(batch, 'summary.json'), 'utf8'));
    assert.equal(requests.length, 3, '正文过滤后应有一次元数据重试和一次来源类型请求');
    assert.equal(requests[0].parent, '同人', '普通一级类别不能发送给模型');
    assert.equal(requests[0].fullInput, true); assert.equal(requests[1].fullInput, false); assert.equal(requests[2].phase, 'source');
    assert.equal(rows.length, 202);
    const fanworkRows = rows.filter((item) => item.parent_category === '同人'); const ordinaryRows = rows.filter((item) => item.parent_category === '现代都市');
    assert.equal(fanworkRows.length, 101); assert(fanworkRows.every((item) => item.subcategory === '原神' && item.selected_for_refinement));
    assert.equal(ordinaryRows.length, 101); assert(ordinaryRows.every((item) => item.subcategory === null && !item.selected_for_refinement && item.refinement_source === 'scope_not_selected'));
    assert.equal((await jsonLines(join(batch, 'checkpoint.jsonl'))).length, 1); assert.equal(summary.refinement_scope, REFINEMENT_SCOPE); assert.equal(summary.selected_parent_count, 1); assert.equal(summary.unique_model_groups, 1); assert.equal(summary.status, 'complete');
    assert.equal(summary.unique_completed_with_metadata, 1);
    assert(fanworkRows.every((item) => item.fanwork_source_category === '游戏'));
    await run('070-refine-character-cards.mjs', [`--resume=${batch}`], 0, environment); assert.equal(requests.length, 3, '完整续跑不能重复请求模型');
  } finally { await new Promise((accept) => server.close(accept)); await rm(temporary, { recursive: true, force: true }); }
});
