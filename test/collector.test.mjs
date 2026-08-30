import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function runPowerShell(command, environment = {}) {
  return new Promise((accept, reject) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-Command', command], {
      env: { ...process.env, COLLECT_SCRIPT: join(root, 'src', '010-collect-character-cards.ps1'), ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => accept({ code, output }));
  });
}

test('010 接受多个来源、保留同名版本且不修改来源', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'card-collector-'));
  try {
    const sourceA = join(temporary, 'source-a');
    const sourceB = join(temporary, 'source-b');
    const destination = join(temporary, 'destination');
    const reports = join(temporary, 'reports');
    await Promise.all([mkdir(sourceA), mkdir(sourceB)]);
    await writeFile(join(sourceA, 'same.json'), '{"name":"A"}', 'utf8');
    await writeFile(join(sourceB, 'same.json'), '{"name":"B"}', 'utf8');
    await writeFile(join(sourceB, 'ignored.txt'), 'ignored', 'utf8');

    const result = await runPowerShell(
      '& $env:COLLECT_SCRIPT -SourceDirectory @($env:SOURCE_A, $env:SOURCE_B) -Destination $env:COLLECT_DESTINATION -ReportDirectory $env:COLLECT_REPORTS',
      { SOURCE_A: sourceA, SOURCE_B: sourceB, COLLECT_DESTINATION: destination, COLLECT_REPORTS: reports },
    );
    assert.equal(result.code, 0, result.output);
    const collected = (await readdir(destination)).sort();
    assert.equal(collected.length, 2);
    assert(collected.includes('same.json'));
    assert(collected.some((name) => /^same__[0-9a-f]{12}\.json$/u.test(name)));
    assert.equal(await readFile(join(sourceA, 'same.json'), 'utf8'), '{"name":"A"}');
    assert.equal(await readFile(join(sourceB, 'same.json'), 'utf8'), '{"name":"B"}');
    assert.equal((await readdir(reports)).filter((name) => name.endsWith('.csv')).length, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('010 没有来源参数时拒绝运行', async () => {
  const result = await runPowerShell('& $env:COLLECT_SCRIPT');
  assert.notEqual(result.code, 0);
  assert.match(result.output, /SourceDirectory/u);
});
