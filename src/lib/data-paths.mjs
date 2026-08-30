import { join, relative, resolve, sep } from 'node:path';

function normalizedPath(path) { return resolve(path).toLocaleLowerCase('en-US'); }
function isInside(path, directory) {
  const target = normalizedPath(path); const parent = normalizedPath(directory);
  return target === parent || target.startsWith(`${parent}${sep.toLocaleLowerCase('en-US')}`);
}

export function currentProjectDataPath(projectRoot, path) {
  const absolutePath = resolve(path);
  const migratedDirectories = [
    [join(projectRoot, 'data', '角色卡', '未分类'), join(projectRoot, 'data', '未分类角色卡')],
    [join(projectRoot, 'data', '角色卡', '挑选好'), join(projectRoot, 'data', '挑选好角色卡')],
    [join(projectRoot, 'data', '角色卡', '已分类'), join(projectRoot, 'data', '已分类角色卡')],
  ];
  for (const [legacyRoot, currentRoot] of migratedDirectories) {
    if (isInside(absolutePath, legacyRoot)) return resolve(currentRoot, relative(legacyRoot, absolutePath));
  }
  return absolutePath;
}
