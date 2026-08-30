import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { currentProjectDataPath } from '../src/lib/data-paths.mjs';

test('项目内旧角色卡目录映射到迁移后的目录', () => {
  const root = resolve('C:\\example', '角色卡分类');
  assert.equal(
    currentProjectDataPath(root, join(root, 'data', '角色卡', '未分类', '子目录', '卡片.png')),
    join(root, 'data', '未分类角色卡', '子目录', '卡片.png'),
  );
  assert.equal(
    currentProjectDataPath(root, join(root, 'data', '角色卡', '已分类', '同人', '卡片.png')),
    join(root, 'data', '已分类角色卡', '同人', '卡片.png'),
  );
  const externalPath = resolve('D:\\收藏', '未分类', '卡片.png');
  assert.equal(currentProjectDataPath(root, externalPath), externalPath);
});
