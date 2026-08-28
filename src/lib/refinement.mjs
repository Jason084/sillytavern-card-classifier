import { createHash } from 'node:crypto';

export const REFINEMENT_THRESHOLD = 100;
export const REFINEMENT_SCOPE = 'fanwork-ip-and-special-groups-v1';
export const FANWORK_PARENT = '同人';
export const EXCLUDED_PARENT = '排除';
export const UNRESOLVED_PARENT = '未分类';
export const NONSTANDARD_PARENT = '标准外';
export const FALLBACK_SUBCATEGORY = '其他';

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function validDirectoryName(value, maximumLength = 40) {
  const output = String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!output || output.length > maximumLength || output === '.' || output === '..') return null;
  if (/[<>:"/\\|?*\u0000-\u001F]/u.test(output) || /[. ]$/u.test(output) || WINDOWS_RESERVED.test(output)) return null;
  return output;
}

export function parentCategory(record, allowedCategories) {
  if (record?.model_decision === 'exclude') return EXCLUDED_PARENT;
  if (record?.model_decision === 'review') return UNRESOLVED_PARENT;
  if (record?.model_decision !== 'classify' || !record.category) throw new Error(`分类状态无效：${record?.relative_path ?? ''}`);
  return allowedCategories?.has(record.category) ? String(record.category).trim() : NONSTANDARD_PARENT;
}

export function refinementGroupId(parent, cardSha256) {
  return createHash('sha256').update(`${parent}\0${cardSha256}`).digest('hex');
}

export function reasonText(record) {
  return String(record?.recheck_2_reason ?? record?.third_reason ?? record?.recheck_reason ?? record?.reason ?? '').normalize('NFKC').trim();
}

export function specialSubcategory(parent, record) {
  if (parent === NONSTANDARD_PARENT) return validDirectoryName(record?.category) ?? FALLBACK_SUBCATEGORY;
  const reason = reasonText(record);
  if (parent === EXCLUDED_PARENT) {
    if (/英文|英语|日文|日语|外文|外语|非中文|中文内容不足|长期阅读/u.test(reason)) return '外文内容';
    if (/R18G|血腥|猎奇|肢解|断肢|内脏|虐杀|食人|尸体|奸尸|血肉|重口|排泄物|身体破坏/u.test(reason)) return 'R18G与血腥猎奇';
    if (/未成年|幼女|幼态|儿童|孩童|婴幼儿|萝莉|正太|小学|初中|高中|国中|\b(?:[0-9]|1[0-7])\s*岁|(?:十[一二三四五六七]?|[一二三四五六七八九])岁/u.test(reason)) return '未成年或幼态内容';
    if (/男娘|扶她|伪娘|女装男性|性转|雌雄同体/u.test(reason)) return '核心性别属性';
    return '其他排除原因';
  }
  if (parent === UNRESOLVED_PARENT) {
    if (/男娘|扶她|伪娘|女装男性|性转|雌雄同体|男性灵魂|女性身体/u.test(reason)) return '核心性别属性';
    if (/加密|信息不足|内容不足|无法读取|裁剪不足|正文/u.test(reason)) return '信息不足或加密';
    if (/年龄|未成年|幼态|视觉年龄|\b(?:[0-9]|1[0-7])\s*岁|(?:十[一二三四五六七]?|[一二三四五六七八九])岁/u.test(reason)) return '年龄边界';
    if (/英文|英语|外文|非中文|中英文|语言/u.test(reason)) return '中外文边界';
    if (/R18G|血腥|猎奇|肢解|内脏|重口/u.test(reason)) return 'R18G边界';
    return '其他待复核';
  }
  return null;
}

export function refinementMode(parent) {
  if (parent === FANWORK_PARENT) return 'model';
  if ([EXCLUDED_PARENT, UNRESOLVED_PARENT, NONSTANDARD_PARENT].includes(parent)) return 'deterministic';
  return null;
}

function aliasKey(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s·・—_\-:：,，.。'"“”‘’()（）\[\]【】]/gu, '');
}

const FANWORK_ALIASES = [
  [/^(?:原神|genshin(?:impact)?)(?:同人)?$/iu, '原神'],
  [/^(?:绝区零|zenlesszonezero|zzz)(?:同人)?$/iu, '绝区零'],
  [/^(?:崩坏星穹铁道|星穹铁道|honkaistarrail|hsr)(?:同人)?$/iu, '崩坏星穹铁道'],
  [/^(?:崩坏3|崩坏三|honkaiimpact3rd?)(?:同人)?$/iu, '崩坏3'],
  [/^(?:蔚蓝档案|碧蓝档案|bluearchive|ba)(?:同人)?$/iu, '蔚蓝档案'],
  [/^(?:明日方舟|arknights)(?:同人)?$/iu, '明日方舟'],
  [/^(?:碧蓝航线|azurlane)(?:同人)?$/iu, '碧蓝航线'],
  [/^(?:少女前线|girlsfrontline)(?:同人)?$/iu, '少女前线'],
  [/^(?:战双帕弥什|战双)(?:同人)?$/iu, '战双帕弥什'],
  [/^(?:鸣潮|wutheringwaves)(?:同人)?$/iu, '鸣潮'],
  [/^(?:宝可梦|口袋妖怪|精灵宝可梦|pokemon)(?:同人)?$/iu, '宝可梦'],
  [/^(?:火影忍者|火影|naruto)(?:同人)?$/iu, '火影忍者'],
  [/^(?:海贼王|航海王|onepiece)(?:同人)?$/iu, '海贼王'],
  [/^(?:英雄联盟|leagueoflegends|lol)(?:同人)?$/iu, '英雄联盟'],
  [/^(?:最终幻想|finalfantasy|ff)(?:同人)?$/iu, '最终幻想'],
  [/^(?:东方project|东方|touhou)(?:同人)?$/iu, '东方Project'],
  [/^(?:fate|fate系列|命运系列)(?:同人)?$/iu, 'Fate系列'],
];

export function normalizeSubcategory(parent, value) {
  if (parent !== FANWORK_PARENT) return null;
  let output = validDirectoryName(value);
  if (!output) return null;
  const key = aliasKey(output);
  if (['其他', '其他同人', '其他作品', '未知作品', '原创或未知'].includes(key)) return FALLBACK_SUBCATEGORY;
  for (const [pattern, canonical] of FANWORK_ALIASES) if (pattern.test(key)) return canonical;
  return output.replace(/(?:作品)?同人$/u, '').trim() || FALLBACK_SUBCATEGORY;
}

export function selectedParentsFromCounts(parentCounts, threshold = REFINEMENT_THRESHOLD) {
  return new Set([...parentCounts]
    .filter(([parent, count]) => count > threshold && refinementMode(parent))
    .map(([parent]) => parent));
}

export function parentSpecificInstruction(parent) {
  if (parent !== FANWORK_PARENT) throw new Error(`当前只允许“${FANWORK_PARENT}”调用模型生成二级分类`);
  return '按原作作品或系列 IP 归档，使用通行的简短中文作品名；同一系列不要按单个角色、地区或版本拆散。确实无法确认原作时使用“其他”。';
}
