import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii'); const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function card(createDate) {
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '测试角色', description: '描述', personality: '', scenario: '', first_mes: '你好', mes_example: '',
      creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '测试', character_version: '1', create_date: createDate,
    },
  };
}

function cardPng(cardData) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const metadata = Buffer.from(`chara\0${Buffer.from(JSON.stringify(cardData)).toString('base64')}`, 'latin1');
  return Buffer.concat([
    signature, chunk('IHDR', ihdr), chunk('tEXt', metadata), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('扫描器校验 PNG CRC，并统一忽略 create_date 生成内容哈希', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'character-card-scanner-'));
  const input = join(temporary, 'input'); const reports = join(temporary, 'reports'); await mkdir(input);
  const png = cardPng(card('2026-01-01'));
  await writeFile(join(input, 'valid.png'), png);
  const corrupt = Buffer.from(png); corrupt[40] ^= 1; await writeFile(join(input, 'corrupt.png'), corrupt);
  await writeFile(join(input, 'same-card.json'), JSON.stringify(card('2026-12-31')));

  await run(process.execPath, [join(root, 'src', '02-scan-character-cards.mjs'), input, reports]);
  const batches = await readdir(reports); assert.equal(batches.length, 1);
  const records = (await readFile(join(reports, batches[0], 'index.jsonl'), 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
  const byName = new Map(records.map((record) => [record.file_name, record]));
  assert.equal(byName.get('valid.png').status, 'valid');
  assert.equal(byName.get('corrupt.png').status, 'corrupt_png');
  assert.match(byName.get('corrupt.png').detail, /CRC/u);
  assert.equal(byName.get('valid.png').card_sha256, byName.get('same-card.json').card_sha256);
  assert.equal(byName.get('valid.png').card_sha256.length, createHash('sha256').digest('hex').length);
});
