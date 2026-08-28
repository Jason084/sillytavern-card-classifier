import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { csv } from './report-io.mjs';
import { newRunId, sha256File } from './run-files.mjs';

export function normalizedPath(path) { return resolve(path).toLocaleLowerCase('en-US'); }

export function isInside(path, directory) {
  const target = normalizedPath(path);
  const parent = normalizedPath(directory);
  return target === parent || target.startsWith(`${parent}${sep.toLocaleLowerCase('en-US')}`);
}

export async function targetRootMustBeEmpty(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`目标不是目录：${path}`);
    if ((await readdir(path)).length) throw new Error(`目标目录不是空目录：${path}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function availableDestination(initialPath, fileHash, allocated, { rejectExisting = false } = {}) {
  const extension = extname(initialPath);
  const stem = basename(initialPath, extension);
  const directory = dirname(initialPath);
  let candidate = initialPath;
  let number = 1;
  while (allocated.has(normalizedPath(candidate)) || (rejectExisting && await stat(candidate).then(() => true, () => false))) {
    const suffix = number === 1 ? `__${fileHash.slice(0, 12)}` : `__${fileHash.slice(0, 12)}-${number}`;
    candidate = `${directory}${sep}${stem}${suffix}${extension}`;
    number += 1;
  }
  allocated.add(normalizedPath(candidate));
  return candidate;
}

export function validatePlanPath(sourcePath, destinationPath, destinationRoot) {
  return isAbsolute(sourcePath)
    && isAbsolute(destinationPath)
    && isInside(destinationPath, destinationRoot)
    && normalizedPath(destinationPath) !== normalizedPath(destinationRoot);
}

export async function executeApprovedPlan(options) {
  const {
    planPath, approval, summary = null, batchDirectory,
    allowedOperations, mapPath = (path) => resolve(path),
    approvalError, validateApproval = () => {}, validatePlan,
    includeOperationInLog = false,
  } = options;
  const actualPlanHash = await sha256File(planPath);
  if (approval.approved !== true) throw new Error(approvalError);
  if (options.operationBeforeHash && !allowedOperations.includes(approval.operation)) throw new Error(options.operationError);
  if (approval.plan_sha256 !== actualPlanHash) throw new Error('计划哈希与批准文件不一致，拒绝执行');
  if (!options.operationBeforeHash && !allowedOperations.includes(approval.operation)) throw new Error(options.operationError);
  validateApproval({ approval, summary, actualPlanHash });

  const destinationRoot = mapPath(approval.destination_root);
  const executionRunId = newRunId();
  const logPath = `${batchDirectory}${sep}execution-${executionRunId}.jsonl`;
  const logHandle = await open(logPath, 'wx');
  const csvHandle = await open(`${batchDirectory}${sep}execution-${executionRunId}.csv`, 'wx');
  const header = includeOperationInLog
    ? ['executed_utc', 'operation', 'source_path', 'destination_path', 'sha256', 'result', 'detail']
    : ['executed_utc', 'source_path', 'destination_path', 'sha256', 'result', 'detail'];
  await csvHandle.write(csv(header));

  const counts = new Map();
  let recordsRead = 0;
  for await (const line of createInterface({ input: createReadStream(planPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const plan = JSON.parse(line);
    recordsRead += 1;
    const sourcePath = mapPath(plan.source_path);
    const destinationPath = mapPath(plan.destination_path);
    let result = 'skipped'; let detail = ''; let destinationCreated = false; let destinationVerified = false;
    try {
      validatePlan({ plan, approval, sourcePath, destinationPath, destinationRoot });
      if (await sha256File(sourcePath) !== plan.sha256) throw new Error('来源文件已变化，SHA-256 不匹配');
      try { await stat(destinationPath); throw new Error('目标文件已存在，拒绝覆盖'); }
      catch (error) { if (error.message === '目标文件已存在，拒绝覆盖') throw error; if (error.code !== 'ENOENT') throw error; }
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      destinationCreated = true;
      if (await sha256File(destinationPath) !== plan.sha256) throw new Error('复制后哈希校验失败');
      destinationVerified = true;
      if (approval.operation === 'move') await unlink(sourcePath);
      result = approval.operation === 'move' ? 'moved' : 'copied';
    } catch (error) {
      if (destinationCreated && destinationVerified && approval.operation === 'move') {
        result = 'copied_source_delete_failed';
        detail = `目标副本已校验，但删除来源失败：${error.message}`;
      } else {
        result = 'failed'; detail = error.message;
        if (destinationCreated && !destinationVerified) {
          try { await unlink(destinationPath); detail += '；已清理未完成目标'; }
          catch (cleanupError) { detail += `；清理未完成目标失败：${cleanupError.message}`; }
        }
      }
    }
    const executedUtc = new Date().toISOString();
    const record = includeOperationInLog
      ? { executed_utc: executedUtc, operation: approval.operation, source_path: sourcePath, destination_path: destinationPath, sha256: plan.sha256, result, detail }
      : { executed_utc: executedUtc, source_path: sourcePath, destination_path: destinationPath, sha256: plan.sha256, result, detail };
    await logHandle.write(`${JSON.stringify(record)}\n`);
    await csvHandle.write(csv(includeOperationInLog
      ? [executedUtc, approval.operation, sourcePath, destinationPath, plan.sha256, result, detail]
      : [executedUtc, sourcePath, destinationPath, plan.sha256, result, detail]));
    counts.set(result, (counts.get(result) ?? 0) + 1);
  }
  await logHandle.close();
  await csvHandle.close();
  await writeFile(`${batchDirectory}${sep}execution-summary-${executionRunId}.json`, JSON.stringify({
    plan_run_id: approval.plan_run_id,
    executed_utc: new Date().toISOString(),
    plan_sha256: actualPlanHash,
    records_read: recordsRead,
    result_counts: [...counts.entries()].map(([result, count]) => ({ result, count })),
  }, null, 2), 'utf8');
  return logPath;
}
