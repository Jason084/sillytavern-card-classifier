import { createHash } from 'node:crypto';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const V1_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function string(value, fallback = '') { return value == null ? fallback : typeof value === 'string' ? value : String(value); }
function array(value) {
  if (value == null) return [];
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return Array.isArray(value) ? value.map(String) : [];
}

export function normalizedCardHash(card) {
  const ignoredKeys = new Set(['creation_date', 'modification_date', 'create_date']);
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!isObject(value)) return value;
    return Object.fromEntries(Object.keys(value).filter((key) => !ignoredKeys.has(key)).sort().map((key) => [key, normalize(value[key])]));
  };
  return createHash('sha256').update(JSON.stringify(normalize(card))).digest('hex');
}

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function versionOf(card) {
  if (!isObject(card)) return null;
  if (card.spec === 'chara_card_v2') return 2;
  if (card.spec === 'chara_card_v3') return 3;
  return !has(card, 'spec') && V1_FIELDS.every((field) => has(card, field)) ? 1 : null;
}

export function extractCard(card, version) {
  const data = version === 1 ? card : card.data;
  if (!isObject(data)) throw new Error('supported card has no object-valued data field');
  let creatorNotes = version === 1 ? string(data.creator_notes ?? data.creatorcomment) : string(data.creator_notes);
  if (version === 3 && isObject(data.creator_notes_multilingual)) {
    creatorNotes = typeof data.creator_notes_multilingual.en === 'string'
      ? data.creator_notes_multilingual.en
      : typeof data.creator_notes_multilingual.creator_notes === 'string'
        ? data.creator_notes_multilingual.creator_notes : creatorNotes;
  }
  return {
    spec_version: `${version}.0`, name: string(data.name), description: string(data.description),
    personality: string(data.personality), scenario: string(data.scenario), first_mes: string(data.first_mes),
    mes_example: string(data.mes_example), fav: typeof card.fav === 'boolean' ? card.fav : false,
    creator_notes: creatorNotes, system_prompt: version === 1 ? '' : string(data.system_prompt),
    post_history_instructions: version === 1 ? '' : string(data.post_history_instructions),
    alternate_greetings: array(data.alternate_greetings), tags: array(data.tags), creator: string(data.creator),
    character_version: string(data.character_version),
    group_only_greetings: version === 3 ? array(data.group_only_greetings) : null,
    nickname: version === 3 ? string(data.nickname) : null,
    character_book: version === 1 ? null : (data.character_book ?? null),
    extensions: isObject(data.extensions) ? data.extensions : null,
  };
}

export function warningsFor(card, version) {
  const data = version === 1 ? card : card.data;
  const warnings = [];
  if (!isObject(data)) return ['data is missing or is not an object'];
  for (const field of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'creator', 'character_version', 'system_prompt', 'post_history_instructions']) {
    if (data[field] != null && typeof data[field] !== 'string') warnings.push(`${field} is not a string`);
  }
  for (const field of ['tags', 'alternate_greetings', ...(version === 3 ? ['group_only_greetings'] : [])]) {
    if (data[field] != null && typeof data[field] !== 'string' && !Array.isArray(data[field])) warnings.push(`${field} is neither a string nor an array`);
  }
  return warnings;
}

function decodeMetadata(text) {
  const bytes = Buffer.from(text, 'base64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('invalid Base64');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(raw);
}

function normalizedTag(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function appendCardTags(card, version, additions) {
  const data = version === 1 ? card : card.data;
  if (!isObject(data)) throw new Error('supported card has no object-valued data field');
  const originalTags = array(data.tags);
  const tags = [...originalTags];
  const seen = new Set(tags.map(normalizedTag).filter(Boolean));
  const addedTags = [];
  for (const addition of additions) {
    const tag = normalizedTag(addition);
    if (!tag || seen.has(tag)) continue;
    tags.push(tag); seen.add(tag); addedTags.push(tag);
  }
  data.tags = tags;
  return { originalTags, tags, addedTags };
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body, 0, body.length));
  return Buffer.concat([length, body, crc]);
}

function writePngCardTags(buffer, additions) {
  const parsed = parsePng(buffer);
  if (parsed.status !== 'ok') throw new Error(`无法写入 PNG 角色卡：${parsed.detail}`);
  const output = [buffer.subarray(0, 8)];
  let offset = 8; let primaryResult = null; let metadataChunksUpdated = 0;
  while (offset < buffer.length) {
    const chunkStart = offset;
    const length = buffer.readUInt32BE(offset); offset += 4;
    const type = buffer.toString('ascii', offset, offset + 4); offset += 4;
    const data = buffer.subarray(offset, offset + length); offset += length + 4;
    let replacement = null;
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0 && nul < data.length - 1) {
        const keyword = data.toString('ascii', 0, nul).toLowerCase();
        if (keyword === 'ccv3' || keyword === 'chara') {
          try {
            const card = decodeMetadata(data.toString('latin1', nul + 1));
            const version = versionOf(card);
            if (version) {
              const result = appendCardTags(card, version, additions);
              const encoded = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
              replacement = pngChunk(type, Buffer.from(`${data.toString('ascii', 0, nul)}\0${encoded}`, 'latin1'));
              metadataChunksUpdated += 1;
              if (keyword === parsed.metadata_chunk && !primaryResult) primaryResult = { ...result, version };
            }
          } catch { /* 保留无法解析的兼容元数据块。 */ }
        }
      }
    }
    output.push(replacement ?? buffer.subarray(chunkStart, offset));
    if (type === 'IEND') {
      if (offset < buffer.length) output.push(buffer.subarray(offset));
      break;
    }
  }
  if (!primaryResult || !metadataChunksUpdated) throw new Error('没有可写入的 PNG 角色卡元数据块');
  return { buffer: Buffer.concat(output), ...primaryResult, metadataChunksUpdated };
}

function parsePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { status: 'invalid_png', detail: 'PNG signature is missing or invalid' };
  let offset = 8; let sawIend = false; const chunks = [];
  while (offset < buffer.length) {
    if (buffer.length - offset < 12) return { status: 'corrupt_png', detail: 'PNG chunk header or CRC is truncated' };
    const length = buffer.readUInt32BE(offset); offset += 4;
    if (length > buffer.length - offset - 8) return { status: 'corrupt_png', detail: 'PNG chunk length exceeds remaining file data' };
    const typeOffset = offset; const type = buffer.toString('ascii', offset, offset + 4); offset += 4;
    const data = buffer.subarray(offset, offset + length);
    const expectedCrc = buffer.readUInt32BE(offset + length); const actualCrc = crc32(buffer, typeOffset, offset + length);
    if (actualCrc !== expectedCrc) return { status: 'corrupt_png', detail: `PNG ${type} chunk CRC does not match` };
    offset += length + 4;
    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0 && nul < data.length - 1) {
        const keyword = data.toString('ascii', 0, nul).toLowerCase();
        if (keyword === 'ccv3' || keyword === 'chara') chunks.push({ keyword, text: data.toString('latin1', nul + 1) });
      }
    }
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIend) return { status: 'corrupt_png', detail: 'PNG IEND chunk is missing' };
  if (!chunks.length) return { status: 'no_card_metadata', detail: 'No chara or ccv3 tEXt chunk exists' };
  let decodedAny = false;
  for (const keyword of ['ccv3', 'chara']) for (const chunk of chunks.filter((item) => item.keyword === keyword)) {
    try {
      const card = decodeMetadata(chunk.text); decodedAny = true;
      const version = versionOf(card);
      if (version) return { status: 'ok', card, version, metadata_chunk: keyword };
    } catch { /* Try the next metadata chunk. */ }
  }
  return decodedAny
    ? { status: 'unsupported_card_spec', detail: 'Metadata is readable but does not match supported V1, V2, or V3 card structures' }
    : { status: 'metadata_decode_failed', detail: 'chara/ccv3 metadata could not be Base64- and JSON-decoded' };
}

function parseJson(buffer) {
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer); const card = JSON.parse(raw); const version = versionOf(card);
    return version ? { status: 'ok', card, version, metadata_chunk: null }
      : { status: 'unsupported_card_spec', detail: 'JSON is readable but does not match supported V1, V2, or V3 card structures' };
  } catch (error) { return { status: 'json_decode_failed', detail: error.message }; }
}

export function parseCardFile(buffer, extension) {
  return extension.toLowerCase() === '.png' ? parsePng(buffer) : parseJson(buffer);
}

export function addTagsToCardFile(buffer, extension, additions) {
  const normalizedExtension = extension.toLowerCase();
  if (normalizedExtension === '.png') return writePngCardTags(buffer, additions);
  if (normalizedExtension !== '.json') throw new Error(`不支持的角色卡扩展名：${extension}`);
  const parsed = parseJson(buffer);
  if (parsed.status !== 'ok') throw new Error(`无法写入 JSON 角色卡：${parsed.detail}`);
  const result = appendCardTags(parsed.card, parsed.version, additions);
  return {
    buffer: Buffer.from(`${JSON.stringify(parsed.card, null, 2)}\n`, 'utf8'),
    ...result, version: parsed.version, metadataChunksUpdated: 0,
  };
}
