import { createHash } from 'node:crypto';

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized);
  if (!isObject(value)) return value;
  const ignored = new Set(['creation_date', 'modification_date', 'create_date']);
  return Object.fromEntries(Object.keys(value).filter((key) => !ignored.has(key)).sort().map((key) => [key, normalized(value[key])]));
}

export function cardHashOf(record) {
  if (record.card_sha256) return { hash: record.card_sha256, source: 'scan_index' };
  if (!isObject(record.card)) return { hash: null, source: null };
  return { hash: createHash('sha256').update(JSON.stringify(normalized(record.card))).digest('hex'), source: 'derived_from_extracted_card' };
}
