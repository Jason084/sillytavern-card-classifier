import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseModelPhaseArguments, parseOrganizationArguments } from '../src/lib/cli.mjs';
import { jsonlAppender, readJsonl } from '../src/lib/report-io.mjs';
import { resolveSplittableBatch } from '../src/lib/model-phase.mjs';
import { sha256File } from '../src/lib/run-files.mjs';
import { executeApprovedPlan, validatePlanPath } from '../src/lib/organization-plan.mjs';
import { REFINEMENT_SCOPE } from '../src/lib/refinement.mjs';

const root = resolve(import.meta.dirname, '..');

test('所有 Node 阶段可安全导入并导出 main', async () => {
  const scripts = [
    '020-scan-character-cards.mjs',
    '030-detect-duplicates.mjs',
    '050-classify-character-cards.mjs',
    '051-classify-character-cards.mjs',
    '052-classify-character-cards.mjs',
    '060-organize-character-cards.mjs',
    '070-refine-character-cards.mjs',
    '080-organize-refined-character-cards.mjs',
    '090-propose-fanwork-ip-merges.mjs',
    '100-organize-merged-character-cards.mjs',
  ];
  for (const script of scripts) {
    const module = await import(`${pathToFileURL(join(root, 'src', script)).href}?import-safety`);
    assert.equal(typeof module.main, 'function', `${script} 应导出 main`);
  }
});

test('公共 CLI 解析保持原选项和位置参数语义', () => {
  assert.deepEqual(
    parseModelPhaseArguments(['input', '--dry-run', '--resume=batch'], 'missing'),
    { positionals: ['input'], resumeArgument: 'batch', dryRun: true, allowRemoteModel: false },
  );
  assert.deepEqual(
    parseModelPhaseArguments(['input', '--allow-remote-model'], 'missing'),
    { positionals: ['input'], resumeArgument: null, dryRun: false, allowRemoteModel: true },
  );
  assert.deepEqual(
    parseOrganizationArguments(['--execute', 'plan', '--operation=move'], { allowOperation: true }),
    { execute: true, operation: 'move', positionals: ['plan'] },
  );
  assert.throws(() => parseModelPhaseArguments(['--resume'], 'missing'), /missing/);
});

test('JSONL 追加器清理尾部残缺行并串行追加', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'report-io-'));
  const path = join(directory, 'checkpoint.jsonl');
  try {
    await writeFile(path, '{"id":1}\n{"partial":', 'utf8');
    const existing = await readJsonl(path);
    assert.deepEqual(existing, [{ id: 1 }]);
    const appender = await jsonlAppender(path, existing);
    await Promise.all([appender.append({ id: 2 }), appender.append({ id: 3 })]);
    await appender.close();
    assert.deepEqual(await readJsonl(path), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('共享模型批次流程重试遗漏项并拆分不可接受批次', async () => {
  const accepted = [];
  const calls = [];
  const failures = await resolveSplittableBatch([{ id: 1 }, { id: 2 }], {
    maxRounds: 1,
    async request(items, round, batchId) {
      calls.push({ ids: items.map((item) => item.id), round, batchId });
      return items.length > 1 ? { invalid: true } : { results: items };
    },
    async accept(response, items) {
      if (!response.results) return { unresolved: items, splitOnFailure: true, error: new Error('split') };
      accepted.push(...response.results.map((item) => item.id));
      return { unresolved: [], splitOnFailure: false, error: null };
    },
  }, 'batch-0');
  assert.deepEqual(failures, []);
  assert.deepEqual(accepted, [1, 2]);
  assert.deepEqual(calls.map((call) => call.ids), [[1, 2], [1], [2]]);
});

test('070 拒绝旧范围 prepared 批次，当前范围 dry-run 不改元数据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prepared-refinement-'));
  try {
    const classificationDirectory = join(directory, 'classification');
    const scanDirectory = join(directory, 'scan');
    const batchDirectory = join(directory, 'prepared');
    await Promise.all([mkdir(classificationDirectory), mkdir(scanDirectory), mkdir(batchDirectory)]);
    const indexPath = join(scanDirectory, 'index.jsonl');
    const classificationsPath = join(classificationDirectory, 'classifications.jsonl');
    const cardHash = 'a'.repeat(64); const fileHash = 'b'.repeat(64);
    await writeFile(indexPath, `${JSON.stringify({ relative_path: 'one.json', file_name: 'one.json', sha256: fileHash, card_sha256: cardHash, status: 'valid', card: { spec_version: '3.0', name: '测试', description: '测试内容' } })}\n`, 'utf8');
    await writeFile(classificationsPath, `${JSON.stringify({ relative_path: 'one.json', file_name: 'one.json', sha256: fileHash, card_sha256: cardHash, category: '同人', model_decision: 'classify', needs_review: false })}\n`, 'utf8');
    await writeFile(join(classificationDirectory, 'summary.json'), JSON.stringify({ source_index: indexPath, source_file_records: 1, unique_failed_or_incomplete: 0, allowed_categories: ['同人'] }), 'utf8');
    await writeFile(join(classificationDirectory, 'run.json'), JSON.stringify({ status: 'complete' }), 'utf8');
    const run = {
      run_id: 'legacy-prepared', status: 'prepared',
      source_classifications: classificationsPath,
      source_classifications_sha256: await sha256File(classificationsPath),
      source_index: indexPath,
      source_index_sha256: await sha256File(indexPath),
      threshold: 100, api_base_url: 'http://127.0.0.1:9999/v1', model_version: 'mock-model',
      prompt_version: 'refinement-v1-single-level-parent-adaptive', batch_size: 30,
      concurrency: 1, max_attempts: 2, max_output_tokens: 4_096, max_http_requests: 2_000,
    };
    const runPath = join(batchDirectory, 'run.json');
    const originalRun = JSON.stringify(run, null, 2);
    await writeFile(runPath, originalRun, 'utf8');
    async function runDry() {
      return new Promise((accept, reject) => {
        const child = spawn(process.execPath, [join(root, 'src', '070-refine-character-cards.mjs'), `--resume=${batchDirectory}`, '--dry-run'], {
          env: { ...process.env, MODEL_API_BASE_URL: 'http://127.0.0.1:9999/v1', MODEL_NAME: 'mock-model', MODEL_BATCH_SIZE: '30', MODEL_CONCURRENCY: '1', MODEL_MAX_ATTEMPTS: '2', MODEL_MAX_OUTPUT_TOKENS: '4096', MODEL_MAX_HTTP_REQUESTS: '2000', MODEL_API_KEY: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
        child.once('error', reject); child.once('exit', (code) => accept({ code, output }));
      });
    }

    const legacyResult = await runDry();
    assert.equal(legacyResult.code, 1, legacyResult.output);
    assert.match(legacyResult.output, /refinement_scope/u);
    assert.equal(await readFile(runPath, 'utf8'), originalRun);

    const currentRun = JSON.stringify({
      ...run,
      refinement_scope: REFINEMENT_SCOPE,
      prompt_version: 'refinement-v6-provider-neutral',
      source_prompt_version: 'fanwork-source-v2-provider-neutral',
    }, null, 2);
    await writeFile(runPath, currentRun, 'utf8');
    const result = await runDry();
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /"mode": "dry-run"/);
    assert.equal(await readFile(runPath, 'utf8'), currentRun);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('共享整理执行器坚持审批、哈希和 move 的复制后删除语义', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'organization-plan-'));
  try {
    const sourcePath = join(directory, 'source.txt');
    const destinationRoot = join(directory, 'destination');
    const destinationPath = join(destinationRoot, 'source.txt');
    const planPath = join(directory, 'plan.jsonl');
    await writeFile(sourcePath, 'content', 'utf8');
    const fileHash = await sha256File(sourcePath);
    await writeFile(planPath, `${JSON.stringify({ operation: 'move', status: 'planned', source_path: sourcePath, destination_path: destinationPath, sha256: fileHash })}\n`, 'utf8');
    const approval = { plan_run_id: 'plan', approved: false, operation: 'move', destination_root: destinationRoot, plan_sha256: await sha256File(planPath) };
    const options = {
      planPath, approval, batchDirectory: directory, allowedOperations: ['copy', 'move'],
      approvalError: '未批准', operationError: '操作无效', includeOperationInLog: true,
      validatePlan({ plan, sourcePath: source, destinationPath: destination, destinationRoot: target }) {
        if (plan.status !== 'planned' || !validatePlanPath(source, destination, target)) throw new Error('计划无效');
      },
    };
    await assert.rejects(executeApprovedPlan(options), /未批准/);
    approval.approved = true;
    await executeApprovedPlan(options);
    assert.equal(await readFile(destinationPath, 'utf8'), 'content');
    await assert.rejects(readFile(sourcePath, 'utf8'), { code: 'ENOENT' });
    const summaries = (await readdir(directory)).filter((name) => name.startsWith('execution-summary-'));
    assert.equal(summaries.length, 1);
    const summary = JSON.parse(await readFile(join(directory, summaries[0]), 'utf8'));
    assert.deepEqual(summary.result_counts, [{ result: 'moved', count: 1 }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
