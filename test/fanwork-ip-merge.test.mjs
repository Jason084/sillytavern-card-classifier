import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFanworkIpCandidates, canonicalFanworkIpName, fanworkIpComparisonKey } from '../src/lib/fanwork-ip-merge.mjs';
import { main } from '../src/090-propose-fanwork-ip-merges.mjs';
import { sha256File } from '../src/lib/run-files.mjs';

const LEGACY_REFINEMENT_SCOPE = 'fanwork-ip-and-special-groups-v1';

test('同名变体会移除无意义后缀并忽略标点差异', () => {
  assert.equal(canonicalFanworkIpName(' 原神系列 '), '原神');
  assert.equal(fanworkIpComparisonKey('碧蓝航线同人'), fanworkIpComparisonKey('碧蓝航线系列'));
  assert.equal(canonicalFanworkIpName('BanG Dream'), 'BanG Dream!');
  assert.notEqual(fanworkIpComparisonKey('C++'), fanworkIpComparisonKey('C#'));
});

test('候选映射按合并后数量判断门槛并保留型月人工规则', () => {
  const candidates = buildFanworkIpCandidates([
    { current_directory: '原神', file_count: 4 },
    { current_directory: '原神系列', file_count: 7 },
    { current_directory: 'Fate系列', file_count: 49 },
    { current_directory: 'FGO', file_count: 2 },
    { current_directory: '月姬', file_count: 1 },
    { current_directory: '小众游戏', file_count: 5, source_categories: ['游戏'] },
    { current_directory: '六张作品', file_count: 6 },
    { current_directory: '其他', file_count: 357 },
  ]);
  const byName = new Map(candidates.map((item) => [item.current_directory, item]));
  assert.equal(byName.get('原神系列').canonical_name, '原神');
  assert.equal(byName.get('原神系列').suggested_target, '原神');
  assert.equal(byName.get('原神系列').canonical_group_file_count, 11);
  assert.equal(byName.get('Fate系列').suggested_target, '型月世界');
  assert.equal(byName.get('FGO').suggested_target_file_count, 52);
  assert.equal(byName.get('小众游戏').suggested_target, '其他游戏同人');
  assert.equal(byName.get('六张作品').recommendation, '门槛待审核');
  assert.equal(byName.get('其他').suggested_target, '待确认原作');
});

test('来源类型缺失或冲突的不足六张目录进入待确认原作', () => {
  const candidates = buildFanworkIpCandidates([
    { current_directory: '作品A', file_count: 2 },
    { current_directory: '作品B', file_count: 2, source_categories: ['游戏', '小说'] },
  ]);
  assert.deepEqual(candidates.map((item) => item.suggested_target), ['待确认原作', '待确认原作']);
});

test('090 交叉校验完整执行的 070/080 产物并只生成未批准报告', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'fanwork-ip-merge-phase-'));
  try {
    const refinementDirectory = join(temporary, '070'); const planDirectory = join(temporary, '080'); const reportsRoot = join(temporary, '090');
    await Promise.all([mkdir(refinementDirectory), mkdir(planDirectory), mkdir(reportsRoot)]);
    const refinementsPath = join(refinementDirectory, 'refinements.jsonl'); const planPath = join(planDirectory, 'plan.jsonl');
    const rows = [
      { relative_path: 'a.png', sha256: 'a'.repeat(64), card_sha256: '1'.repeat(64), parent_category: '同人', selected_for_refinement: true, subcategory: '原神', fanwork_source_category: '游戏' },
      { relative_path: 'b.png', sha256: 'b'.repeat(64), card_sha256: '2'.repeat(64), parent_category: '同人', selected_for_refinement: true, subcategory: '原神系列', fanwork_source_category: '游戏' },
      { relative_path: 'c.png', sha256: 'c'.repeat(64), card_sha256: '3'.repeat(64), parent_category: '校园', selected_for_refinement: false, subcategory: null },
    ];
    await writeFile(refinementsPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    await writeFile(join(refinementDirectory, 'run.json'), JSON.stringify({ status: 'complete', refinement_scope: LEGACY_REFINEMENT_SCOPE }), 'utf8');
    await writeFile(join(refinementDirectory, 'summary.json'), JSON.stringify({ status: 'complete', refinement_scope: LEGACY_REFINEMENT_SCOPE, unique_failed_or_incomplete: 0, source_file_records: rows.length }), 'utf8');
    const plans = rows.map((row) => ({ operation: 'copy', status: 'planned', ...row }));
    await writeFile(planPath, plans.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    const refinementsSha256 = await sha256File(refinementsPath); const planSha256 = await sha256File(planPath);
    await writeFile(join(planDirectory, 'summary.json'), JSON.stringify({ refinement_scope: LEGACY_REFINEMENT_SCOPE, source_refinements: refinementsPath, source_refinements_sha256: refinementsSha256, plan_sha256: planSha256, files_planned: rows.length, missing_or_changed_sources: 0 }), 'utf8');
    await writeFile(join(planDirectory, 'execution-summary-test.json'), JSON.stringify({ plan_sha256: planSha256, records_read: rows.length, result_counts: [{ result: 'copied', count: rows.length }] }), 'utf8');

    const result = await main([refinementDirectory, planDirectory, reportsRoot]);
    const summary = JSON.parse(await readFile(join(result.batchDirectory, 'summary.json'), 'utf8'));
    const approval = JSON.parse(await readFile(join(result.batchDirectory, 'approval.json'), 'utf8'));
    const names = await readdir(result.batchDirectory);
    assert.equal(summary.fanwork_file_records, 2);
    assert.equal(summary.current_fanwork_directories, 2);
    assert.equal(summary.canonical_names, 1);
    assert.equal(summary.external_model_called, false);
    assert.equal(summary.data_modified, false);
    assert.equal(approval.approved, false);
    assert.deepEqual(names.sort(), ['approval.json', 'candidates.csv', 'candidates.jsonl', 'fanwork-index.jsonl', 'run.json', 'summary.json']);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
