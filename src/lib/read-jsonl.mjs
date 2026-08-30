import { createReadStream } from 'node:fs';

// node:readline treats U+2028 and U+2029 as line endings. Both characters are
// valid inside JSON strings, so JSONL records must be split only on an actual
// LF byte. Setting the stream encoding keeps UTF-8 characters intact when a
// multibyte sequence crosses a chunk boundary.
async function* readLfLines(path) {
  let parts = [];
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    let start = 0; let separator;
    while ((separator = chunk.indexOf('\n', start)) !== -1) {
      parts.push(chunk.slice(start, separator));
      let line = parts.length === 1 ? parts[0] : parts.join('');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
      parts = []; start = separator + 1;
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  }
  if (parts.length) yield parts.length === 1 ? parts[0] : parts.join('');
}

function escapeControlCharactersInStrings(text) {
  let output = ''; let inString = false; let escaped = false;
  for (const character of text) {
    if (!inString) {
      output += character; if (character === '"') inString = true; continue;
    }
    if (escaped) { output += character; escaped = false; continue; }
    if (character === '\\') { output += character; escaped = true; continue; }
    if (character === '"') { output += character; inString = false; continue; }
    const code = character.codePointAt(0);
    if (code < 0x20) {
      const escapes = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };
      output += escapes[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
    } else output += character;
  }
  return output;
}

function parseRecord(text, startLine, endLine) {
  try { return { record: JSON.parse(text), start_line: startLine, end_line: endLine, repaired: false, error: null }; }
  catch (firstError) {
    try { return { record: JSON.parse(escapeControlCharactersInStrings(text)), start_line: startLine, end_line: endLine, repaired: true, error: null }; }
    catch (error) { return { record: null, start_line: startLine, end_line: endLine, repaired: false, error: `${firstError.message}; repair failed: ${error.message}` }; }
  }
}

// Historical scan batches may contain literal line breaks inside JSON strings. Records always
// begin with relative_path, so accumulate to the next record boundary and repair only controls.
export async function* readJsonlRecords(path, recordPrefix = '{"relative_path":') {
  let recordLines = []; let startLine = 0; let lineNumber = 0;
  for await (let line of readLfLines(path)) {
    lineNumber += 1; if (lineNumber === 1) line = line.replace(/^\uFEFF/, '');
    if (line.startsWith(recordPrefix)) {
      if (recordLines.length) yield parseRecord(recordLines.join('\n'), startLine, lineNumber - 1);
      recordLines = [line]; startLine = lineNumber;
    } else if (recordLines.length) recordLines.push(line);
    else if (line.trim()) yield { record: null, start_line: lineNumber, end_line: lineNumber, repaired: false, error: 'orphan content before first JSON record' };
  }
  if (recordLines.length) yield parseRecord(recordLines.join('\n'), startLine, lineNumber);
}
