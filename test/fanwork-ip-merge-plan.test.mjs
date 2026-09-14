import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/100-organize-merged-character-cards.mjs';
import { sha256File } from '../src/lib/run-files.mjs';

test('100 使用已批准门槛策略生成完整且默认未批准的复制计划', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'fanwork-ip-plan-'));
  try {
    const sourceRoot = join(temporary, 'source'); const candidateDirectory = join(temporary, '090'); const sourcePlanDirectory = join(temporary, '080');
    const destinationRoot = join(temporary, 'destination'); const reportsRoot = join(temporary, 'plans');
    await Promise.all([mkdir(join(sourceRoot, '同人', '六张作品'), { recursive: true }), mkdir(join(sourceRoot, '同人', '其他'), { recursive: true }), mkdir(join(sourceRoot, '校园'), { recursive: true }), mkdir(candidateDirectory), mkdir(sourcePlanDirectory), mkdir(reportsRoot)]);
    const files = [
      { relative_path: 'a.png', parent_category: '同人', subcategory: '六张作品', content: 'a', destination_path: join(sourceRoot, '同人', '六张作品', 'same.png') },
      { relative_path: 'b.png', parent_category: '同人', subcategory: '其他', content: 'b', destination_path: join(sourceRoot, '同人', '其他', 'same.png') },
      { relative_path: 'c.png', parent_category: '校园', subcategory: null, content: 'c', destination_path: join(sourceRoot, '校园', 'c.png') },
    ];
    for (const file of files) { await writeFile(file.destination_path, file.content); file.sha256 = await sha256File(file.destination_path); }
    const sourcePlanPath = join(sourcePlanDirectory, 'plan.jsonl');
    const sourcePlans = files.map((file) => ({ operation: 'copy', status: 'planned', relative_path: file.relative_path, parent_category: file.parent_category, subcategory: file.subcategory, selected_for_refinement: file.parent_category === '同人', destination_path: file.destination_path, sha256: file.sha256 }));
    await writeFile(sourcePlanPath, sourcePlans.map((item) => JSON.stringify(item)).join('\n') + '\n'); const sourcePlanSha256 = await sha256File(sourcePlanPath);
    await writeFile(join(sourcePlanDirectory, 'summary.json'), JSON.stringify({ plan_sha256: sourcePlanSha256, files_planned: 3, destination_root: sourceRoot }));
    await writeFile(join(sourcePlanDirectory, 'execution-summary-test.json'), JSON.stringify({ plan_sha256: sourcePlanSha256, records_read: 3, result_counts: [{ result: 'copied', count: 3 }] }));

    const candidates = [
      { current_directory: '六张作品', canonical_name: '六张作品', suggested_target: '六张作品', file_count: 1, recommendation: '门槛待审核' },
      { current_directory: '其他', canonical_name: '其他', suggested_target: '待确认原作', file_count: 1, recommendation: '兜底目录改名' },
    ];
    const candidatesPath = join(candidateDirectory, 'candidates.jsonl'); await writeFile(candidatesPath, candidates.map((item) => JSON.stringify(item)).join('\n') + '\n'); const candidatesSha256 = await sha256File(candidatesPath);
    const indexPath = join(candidateDirectory, 'fanwork-index.jsonl');
    await writeFile(indexPath, files.filter((item) => item.parent_category === '同人').map((item) => JSON.stringify({ relative_path: item.relative_path, sha256: item.sha256, current_directory: item.subcategory })).join('\n') + '\n'); const indexSha256 = await sha256File(indexPath);
    const executionPath = join(sourcePlanDirectory, 'execution-summary-test.json');
    await writeFile(join(candidateDirectory, 'run.json'), JSON.stringify({ status: 'complete', merge_scope: 'fanwork-ip-merge-candidates-v1' }));
    await writeFile(join(candidateDirectory, 'summary.json'), JSON.stringify({ run_id: 'candidate', status: 'complete', merge_scope: 'fanwork-ip-merge-candidates-v1', candidates_sha256: candidatesSha256, fanwork_index_sha256: indexSha256, fanwork_file_records: 2, source_plan: sourcePlanPath, source_plan_sha256: sourcePlanSha256, source_execution_summary: executionPath }));
    await writeFile(join(candidateDirectory, 'approval.json'), JSON.stringify({ approved: true, candidates_sha256: candidatesSha256, below_minimum_policy: { recommendation: '门槛待审核', canonical_group_count: 1, current_directory_count: 1, file_count: 1, approved_target: '待确认原作' }, expected_waiting_bucket_file_count: 2, overrides: [] }));

    const result = await main([candidateDirectory, sourceRoot, destinationRoot, reportsRoot]);
    const [summary, approval, plans] = await Promise.all([
      readFile(join(result.batchDirectory, 'summary.json'), 'utf8').then(JSON.parse),
      readFile(join(result.batchDirectory, 'approval.json'), 'utf8').then(JSON.parse),
      readFile(join(result.batchDirectory, 'plan.jsonl'), 'utf8').then((text) => text.trim().split(/\r?\n/u).map(JSON.parse)),
    ]);
    assert.equal(summary.files_planned, 3); assert.equal(summary.fanwork_files_planned, 2); assert.equal(summary.waiting_bucket_file_count, 2);
    assert.equal(summary.collision_renames, 1); assert.equal(summary.missing_or_changed_sources, 0); assert.equal(approval.approved, false);
    assert(plans.filter((item) => item.parent_category === '同人').every((item) => item.approved_target === '待确认原作'));
    assert.equal(new Set(plans.map((item) => item.destination_path)).size, 3);
    await assert.rejects(main(['--execute', result.batchDirectory]), /计划尚未批准/u);
    assert.deepEqual((await readdir(destinationRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))), []);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

