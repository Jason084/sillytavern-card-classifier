import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { findPublicContentFailures } from '../scripts/check-public-content.mjs';

async function fixtureDirectory() {
  return mkdtemp(join(tmpdir(), 'public-content-check-'));
}

test('公开内容检查器拦截通用敏感内容模式', async () => {
  const directory = await fixtureDirectory();
  const endpoint = ['https://', 'fictional-service.invalid', '/v1'].join('');
  const credential = ['FIXTURE', '_API_KEY'].join('');
  const promptMarker = ['不受', '限制', '模式'].join('');
  const privatePath = ['C:', '\\', 'fixture', '\\', 'Private Folder', '\\', 'card.json'].join('');
  const email = ['fixture', '@', 'private.invalid'].join('');
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'endpoint.txt'), endpoint, 'utf8');
  await writeFile(join(directory, 'credential.txt'), credential, 'utf8');
  await writeFile(join(directory, 'prompt.txt'), promptMarker, 'utf8');
  await writeFile(join(directory, 'nested', 'path.txt'), privatePath, 'utf8');
  await writeFile(join(directory, 'email.txt'), email, 'utf8');

  const failures = await findPublicContentFailures(directory);

  assert.deepEqual(
    new Set(failures.map((failure) => failure.split(': ', 2)[1])),
    new Set([
      'external API endpoint',
      'credential variable',
      'unsafe prompt marker',
      'private-looking Windows path',
      'email address',
    ]),
  );
});

test('公开内容检查器不误报公共示例', async () => {
  const directory = await fixtureDirectory();
  await writeFile(
    join(directory, 'README.md'),
    [
      '模型地址：https://provider.example/v1',
      '本地地址：http://127.0.0.1:1234/v1',
      '仓库地址：https://github.com/example/project',
      '示例路径：D:\\Cards\\Selected',
      '示例变量：MODEL_API_KEY=replace-me',
      '示例邮箱：reader@example.com',
    ].join('\n'),
    'utf8',
  );

  assert.deepEqual(await findPublicContentFailures(directory), []);
});
