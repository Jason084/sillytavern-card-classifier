import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function newRunId() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export async function createBatchDirectory(reportsDirectory) {
  await mkdir(reportsDirectory, { recursive: true });
  for (;;) {
    const runId = newRunId();
    const batchDirectory = join(reportsDirectory, runId);
    try {
      await mkdir(batchDirectory);
      return { runId, batchDirectory };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
