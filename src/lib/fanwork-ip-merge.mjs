export const FANWORK_IP_MERGE_SCOPE = 'fanwork-ip-merge-candidates-v1';
export const INDEPENDENT_DIRECTORY_MINIMUM = 10;
export const LONG_TAIL_MAXIMUM = 5;

export const LONG_TAIL_BUCKETS = Object.freeze([
  '其他动漫同人',
  '其他游戏同人',
  '其他小说同人',
  '其他电视剧同人',
  '待确认原作',
]);

const SOURCE_BUCKETS = new Map([
  ['动画与漫画', '其他动漫同人'],
  ['游戏', '其他游戏同人'],
  ['小说', '其他小说同人'],
  ['影视', '其他电视剧同人'],
]);

const PREFERRED_NAMES = new Map([
  ['bangdream', 'BanG Dream!'],
]);

const TYPE_MOON_KEYS = new Set([
  'fate',
  'fgo',
  '命运冠位指定',
  '月姬',
  '魔法使之夜',
  '魔法少女伊莉雅',
]);

function cleanText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function withoutGenericSuffix(value) {
  let output = cleanText(value);
  let previous;
  do {
    previous = output;
    output = output.replace(/(?:作品)?(?:系列|同人)$/u, '').trim();
  } while (output && output !== previous);
  return output || cleanText(value);
}

export function fanworkIpComparisonKey(value) {
  return withoutGenericSuffix(value)
    .toLocaleLowerCase('en-US')
    .replace(/[\s·・—–_\-:：,，.。'"“”‘’()（）\[\]【】!！?？]/gu, '');
}

export function canonicalFanworkIpName(value) {
  const cleaned = withoutGenericSuffix(value);
  return PREFERRED_NAMES.get(fanworkIpComparisonKey(cleaned)) ?? cleaned;
}

function preferredGroupName(entries) {
  const explicit = entries.map((entry) => PREFERRED_NAMES.get(entry.key)).find(Boolean);
  if (explicit) return explicit;
  return [...entries].sort((left, right) => (
    right.file_count - left.file_count
    || left.canonical.length - right.canonical.length
    || left.canonical.localeCompare(right.canonical, 'zh-CN')
  ))[0].canonical;
}

function sourceCategory(entries) {
  const values = new Set(entries.flatMap((entry) => entry.source_categories ?? []).filter(Boolean));
  return values.size === 1 ? [...values][0] : null;
}

function recommendationForGroup(entries, canonicalName, groupCount) {
  const keys = new Set(entries.map((entry) => entry.key));
  if ([...keys].some((key) => TYPE_MOON_KEYS.has(key))) {
    return {
      suggested_target: '型月世界',
      recommendation: '共享世界观归并',
      merge_basis: '用户指定的型月共享世界观：允许同一官方系列、正传、外传和手游衍生作品归并',
    };
  }

  if (entries.some((entry) => entry.current_directory === '其他')) {
    return {
      suggested_target: '待确认原作',
      recommendation: '兜底目录改名',
      merge_basis: '现有“其他”无法表达原作且已过载；单独改为“待确认原作”，不再接收所有长尾作品',
    };
  }

  if (groupCount <= LONG_TAIL_MAXIMUM) {
    const category = sourceCategory(entries);
    const bucket = SOURCE_BUCKETS.get(category) ?? '待确认原作';
    return {
      suggested_target: bucket,
      recommendation: '长尾归档',
      merge_basis: category
        ? `同名变体合计 ${groupCount} 张，不足 6 张；依据来源类型“${category}”进入有限长尾桶`
        : `同名变体合计 ${groupCount} 张，不足 6 张；现有产物没有唯一可用的来源类型，进入“待确认原作”`,
    };
  }

  if (groupCount < INDEPENDENT_DIRECTORY_MINIMUM) {
    return {
      suggested_target: canonicalName,
      recommendation: '门槛待审核',
      merge_basis: `同名变体合计 ${groupCount} 张，介于 6–9 张，未达到独立目录最低 10 张；保留规范名作为候选，等待人工决定`,
    };
  }

  const variant = entries.length > 1 || entries.some((entry) => entry.current_directory !== canonicalName);
  return {
    suggested_target: canonicalName,
    recommendation: variant ? '同名变体归并' : '保留独立目录',
    merge_basis: variant
      ? '移除无意义的“系列/同人”后缀，并忽略标点、空白和拉丁字母大小写差异后名称相同'
      : `规范 IP 合计 ${groupCount} 张，达到独立目录最低 10 张`,
  };
}

export function buildFanworkIpCandidates(directoryEntries) {
  const normalized = directoryEntries.map((raw) => {
    const currentDirectory = cleanText(raw.current_directory);
    const fileCount = Number(raw.file_count);
    if (!currentDirectory || !Number.isSafeInteger(fileCount) || fileCount <= 0) throw new Error('同人目录候选必须包含有效目录名和正整数文件数');
    const canonical = canonicalFanworkIpName(currentDirectory);
    return {
      current_directory: currentDirectory,
      file_count: fileCount,
      source_categories: [...new Set((raw.source_categories ?? []).map(cleanText).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
      canonical,
      key: fanworkIpComparisonKey(canonical),
    };
  });

  const seen = new Set();
  const groups = new Map();
  for (const entry of normalized) {
    if (seen.has(entry.current_directory)) throw new Error(`同人目录重复：${entry.current_directory}`);
    seen.add(entry.current_directory);
    const group = groups.get(entry.key) ?? [];
    group.push(entry);
    groups.set(entry.key, group);
  }

  const candidates = [];
  for (const entries of groups.values()) {
    const canonicalName = preferredGroupName(entries);
    const canonicalGroupCount = entries.reduce((sum, entry) => sum + entry.file_count, 0);
    const recommendation = recommendationForGroup(entries, canonicalName, canonicalGroupCount);
    for (const entry of entries) {
      candidates.push({
        current_directory: entry.current_directory,
        canonical_name: canonicalName,
        suggested_target: recommendation.suggested_target,
        file_count: entry.file_count,
        canonical_group_file_count: canonicalGroupCount,
        source_category: sourceCategory(entries),
        recommendation: recommendation.recommendation,
        merge_basis: recommendation.merge_basis,
      });
    }
  }

  const targetCounts = new Map();
  for (const candidate of candidates) targetCounts.set(candidate.suggested_target, (targetCounts.get(candidate.suggested_target) ?? 0) + candidate.file_count);
  return candidates
    .map((candidate) => ({ ...candidate, suggested_target_file_count: targetCounts.get(candidate.suggested_target) }))
    .sort((left, right) => right.file_count - left.file_count || left.current_directory.localeCompare(right.current_directory, 'zh-CN'));
}
