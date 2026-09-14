import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { addTagsToCardFile, parseCardFile } from '../src/lib/card-parser.mjs';
import { main as taggingMain } from '../src/110-write-classification-tags.mjs';

const root = resolve(import.meta.dirname, '..');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii'); const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function card(name, tags) {
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name, description: '', personality: '', scenario: '', first_mes: '你好', mes_example: '',
      creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags,
      creator: '测试', character_version: '1',
    },
  };
}

function cardPng(cardData) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const metadata = Buffer.from(`chara\0${Buffer.from(JSON.stringify(cardData)).toString('base64')}`, 'latin1');
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('tEXt', metadata), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

test('PNG 与 JSON 角色卡保留原标签并追加去重后的分类标签', () => {
  const json = Buffer.from(JSON.stringify(card('JSON 卡', ['已有标签', '同人'])));
  const taggedJson = addTagsToCardFile(json, '.json', ['同人', '原神']);
  assert.deepEqual(taggedJson.originalTags, ['已有标签', '同人']);
  assert.deepEqual(taggedJson.addedTags, ['原神']);
  assert.deepEqual(parseCardFile(taggedJson.buffer, '.json').card.data.tags, ['已有标签', '同人', '原神']);

  const png = cardPng(card('PNG 卡', ['已有标签']));
  const taggedPng = addTagsToCardFile(png, '.png', ['同人', '原神']);
  assert.deepEqual(taggedPng.addedTags, ['同人', '原神']);
  assert.deepEqual(parseCardFile(taggedPng.buffer, '.png').card.data.tags, ['已有标签', '同人', '原神']);
});

test('110 根据已执行的 100 计划生成待批准计划，并在批准后写入新副本', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'classification-tags-'));
  const sourceRoot = join(temporary, 'merged'); const destinationRoot = join(temporary, 'tagged');
  const sourceBatch = join(temporary, 'source-plan'); const reportsRoot = join(temporary, 'reports');
  await Promise.all([mkdir(join(sourceRoot, '同人', '原神'), { recursive: true }), mkdir(join(sourceRoot, '校园'), { recursive: true }), mkdir(sourceBatch)]);
  const fanworkPath = join(sourceRoot, '同人', '原神', 'fan.png'); const schoolPath = join(sourceRoot, '校园', 'school.json');
  const fanworkBuffer = cardPng(card('同人卡', ['旧标签'])); const schoolBuffer = Buffer.from(JSON.stringify(card('校园卡', ['日常'])));
  await Promise.all([writeFile(fanworkPath, fanworkBuffer), writeFile(schoolPath, schoolBuffer)]);
  const sourceRecords = [
    { operation: 'copy', status: 'planned', relative_path: 'fan.png', parent_category: '同人', approved_target: '原神', destination_path: fanworkPath, sha256: sha256(fanworkBuffer) },
    { operation: 'copy', status: 'planned', relative_path: 'school.json', parent_category: '校园', approved_target: null, destination_path: schoolPath, sha256: sha256(schoolBuffer) },
  ];
  const sourcePlanText = `${sourceRecords.map(JSON.stringify).join('\n')}\n`; const sourcePlanSha256 = sha256(Buffer.from(sourcePlanText));
  await Promise.all([
    writeFile(join(sourceBatch, 'plan.jsonl'), sourcePlanText),
    writeFile(join(sourceBatch, 'summary.json'), JSON.stringify({ status: 'complete', merge_scope: 'approved-fanwork-ip-merge-plan-v1', plan_sha256: sourcePlanSha256, files_planned: 2, destination_root: sourceRoot })),
    writeFile(join(sourceBatch, 'approval.json'), JSON.stringify({ approved: true, merge_scope: 'approved-fanwork-ip-merge-plan-v1', plan_sha256: sourcePlanSha256 })),
    writeFile(join(sourceBatch, 'execution-summary-test.json'), JSON.stringify({ plan_sha256: sourcePlanSha256, records_read: 2, result_counts: [{ result: 'copied', count: 2 }] })),
  ]);

  const { batchDirectory, summary } = await taggingMain([sourceBatch, sourceRoot, destinationRoot, reportsRoot]);
  assert.equal(summary.files_planned, 2); assert.equal(summary.invalid_sources, 0);
  assert.deepEqual(await readdir(reportsRoot), [batchDirectory.split(/[\\/]/u).at(-1)]);
  const planRows = (await readFile(join(batchDirectory, 'plan.jsonl'), 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(planRows[0].tags_to_add, ['同人', '原神']);
  assert.deepEqual(planRows[1].tags_to_add, ['校园']);
  const approvalPath = join(batchDirectory, 'approval.json'); const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  approval.approved = true; await writeFile(approvalPath, JSON.stringify(approval, null, 2));
  await taggingMain(['--execute', batchDirectory]);

  const taggedFanwork = parseCardFile(await readFile(join(destinationRoot, '同人', '原神', 'fan.png')), '.png');
  const taggedSchool = parseCardFile(await readFile(join(destinationRoot, '校园', 'school.json')), '.json');
  assert.deepEqual(taggedFanwork.card.data.tags, ['旧标签', '同人', '原神']);
  assert.deepEqual(taggedSchool.card.data.tags, ['日常', '校园']);
  assert.deepEqual(parseCardFile(await readFile(fanworkPath), '.png').card.data.tags, ['旧标签'], '来源卡不能被修改');
});

test('110 仅对显式指定的异常卡原样复制并在报告中记录例外', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'classification-tags-exception-'));
  const sourceRoot = join(temporary, 'merged'); const destinationRoot = join(temporary, 'tagged');
  const sourceBatch = join(temporary, 'source-plan'); const reportsRoot = join(temporary, 'reports');
  await Promise.all([mkdir(join(sourceRoot, '古风历史'), { recursive: true }), mkdir(sourceBatch)]);
  const sourcePath = join(sourceRoot, '古风历史', '异常卡.png');
  const sourceBuffer = Buffer.from(cardPng(card('异常卡', ['旧标签'])));
  const textTypeOffset = sourceBuffer.indexOf(Buffer.from('tEXt'));
  const textLength = sourceBuffer.readUInt32BE(textTypeOffset - 4);
  sourceBuffer[textTypeOffset + 4 + textLength] ^= 0xff;
  await writeFile(sourcePath, sourceBuffer);
  const sourceRecord = { operation: 'copy', status: 'planned', relative_path: '异常卡.png', parent_category: '古风历史', approved_target: null, destination_path: sourcePath, sha256: sha256(sourceBuffer) };
  const sourcePlanText = `${JSON.stringify(sourceRecord)}\n`; const sourcePlanSha256 = sha256(Buffer.from(sourcePlanText));
  await Promise.all([
    writeFile(join(sourceBatch, 'plan.jsonl'), sourcePlanText),
    writeFile(join(sourceBatch, 'summary.json'), JSON.stringify({ status: 'complete', merge_scope: 'approved-fanwork-ip-merge-plan-v1', plan_sha256: sourcePlanSha256, files_planned: 1, destination_root: sourceRoot })),
    writeFile(join(sourceBatch, 'approval.json'), JSON.stringify({ approved: true, merge_scope: 'approved-fanwork-ip-merge-plan-v1', plan_sha256: sourcePlanSha256 })),
    writeFile(join(sourceBatch, 'execution-summary-test.json'), JSON.stringify({ plan_sha256: sourcePlanSha256, records_read: 1, result_counts: [{ result: 'copied', count: 1 }] })),
  ]);

  const exceptionPath = '古风历史/异常卡.png';
  const { batchDirectory, summary } = await taggingMain([sourceBatch, sourceRoot, destinationRoot, reportsRoot, `--copy-unchanged=${exceptionPath}`]);
  assert.equal(summary.files_planned, 1); assert.equal(summary.invalid_sources, 0); assert.equal(summary.unchanged_copy_files, 1);
  assert.deepEqual(summary.unchanged_copy_paths, [exceptionPath]);
  const [plan] = (await readFile(join(batchDirectory, 'plan.jsonl'), 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(plan.operation, 'copy_unchanged'); assert.equal(plan.output_sha256, plan.source_sha256);
  assert.match(plan.detail, /原样复制/u);
  const approvalPath = join(batchDirectory, 'approval.json'); const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  approval.approved = true; await writeFile(approvalPath, JSON.stringify(approval, null, 2));
  await taggingMain(['--execute', batchDirectory]);
  assert.deepEqual(await readFile(join(destinationRoot, '古风历史', '异常卡.png')), sourceBuffer);
  const executionSummaryName = (await readdir(batchDirectory)).find((name) => name.startsWith('execution-summary-'));
  const executionSummary = JSON.parse(await readFile(join(batchDirectory, executionSummaryName), 'utf8'));
  assert.deepEqual(executionSummary.result_counts, [{ result: 'unchanged_copy_written', count: 1 }]);
});
