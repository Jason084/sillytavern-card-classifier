import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBatchDirectory } from '../src/lib/run-files.mjs';

test('并发创建的批次目录必须唯一', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'character-card-runs-'));
  const reports = join(temporary, 'reports');
  const batches = await Promise.all(Array.from({ length: 20 }, () => createBatchDirectory(reports)));
  assert.equal(new Set(batches.map((item) => item.runId)).size, batches.length);
  assert.equal(new Set(batches.map((item) => item.batchDirectory)).size, batches.length);
});
