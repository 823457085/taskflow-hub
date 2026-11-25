const FILE_LIMIT = 8 * 1024 * 1024;
const XML_MEMBER_LIMIT = 4 * 1024 * 1024;
const XML_TOTAL_LIMIT = 12 * 1024 * 1024;
const CONTENT_LIMIT = 65_536;
const JSON_TEXT_LIMIT = 120 * 1024;
const encoder = new TextEncoder();

const invalidXlsx = () => new Error('无法读取 XLSX 文件，请用 Excel 重新保存后再上传。');
const oversized = () => new Error('用例内容过多，无法完整放入评审。请拆分工作表后上传。');

function checkedContent(text: string): string {
  if (!text.trim()) throw new Error('文件中没有可读取的测试用例。');
  // Reserve room for the other JSON request fields within the 128 KiB body limit.
  if (text.length > CONTENT_LIMIT || encoder.encode(JSON.stringify(text)).length > JSON_TEXT_LIMIT) throw oversized();
  return text;
}

/** Reads only requested ZIP members and stops inflation at their validated size. */
function zipXml(bytes: ArrayBuffer) {
  const zip = new DataView(bytes);
  const decode = new TextDecoder('utf-8', { fatal: true });
  let end = bytes.byteLength - 22;
  const earliest = Math.max(0, end - 65_535);
  while (end >= earliest && (zip.getUint32(end, true) !== 0x06054b50 || end + 22 + zip.getUint16(end + 20, true) !== bytes.byteLength)) end--;
  if (end < earliest || zip.getUint16(end + 4, true) || zip.getUint16(end + 6, true)) throw invalidXlsx();
  const count = zip.getUint16(end + 10, true);
  const directorySize = zip.getUint32(end + 12, true);
  const directoryStart = zip.getUint32(end + 16, true);
  if (count !== zip.getUint16(end + 8, true) || directoryStart + directorySize > end) throw invalidXlsx();

  const entries = new Map<string, { offset: number; packed: number; size: number; method: number; flags: number }>();
  const directoryEnd = directoryStart + directorySize;
  let offset = directoryStart;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || zip.getUint32(offset, true) !== 0x02014b50) throw invalidXlsx();
    const nameLength = zip.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + zip.getUint16(offset + 30, true) + zip.getUint16(offset + 32, true);
    if (next > directoryEnd) throw invalidXlsx();
    const name = decode.decode(new Uint8Array(bytes, offset + 46, nameLength));
    if (entries.has(name)) throw invalidXlsx();
    entries.set(name, {
      offset: zip.getUint32(offset + 42, true),
      packed: zip.getUint32(offset + 20, true),
      size: zip.getUint32(offset + 24, true),
      method: zip.getUint16(offset + 10, true),
      flags: zip.getUint16(offset + 8, true),
    });
    offset = next;
  }

  let extractedBytes = 0;
  return async (path: string): Promise<Document> => {
    const entry = entries.get(path);
    if (!entry || entry.flags & 0x41 || (entry.method !== 0 && entry.method !== 8)) throw invalidXlsx();
    extractedBytes += entry.size;
    if (entry.size > XML_MEMBER_LIMIT || extractedBytes > XML_TOTAL_LIMIT) throw oversized();
    const start = entry.offset;
    if (start + 30 > directoryStart || zip.getUint32(start, true) !== 0x04034b50) throw invalidXlsx();
    const dataStart = start + 30 + zip.getUint16(start + 26, true) + zip.getUint16(start + 28, true);
    if (dataStart + entry.packed > directoryStart) throw invalidXlsx();
    const packed = new Uint8Array(bytes, dataStart, entry.packed);
    let data = packed;
    if (entry.method === 8) {
      data = new Uint8Array(entry.size);
      const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (length + value.length > entry.size) {
            await reader.cancel();
            throw invalidXlsx();
          }
          data.set(value, length);
          length += value.length;
        }
        if (length !== entry.size) throw invalidXlsx();
      } finally {
        reader.releaseLock();
      }
    }
    if (data.length !== entry.size) throw invalidXlsx();
    const xml = decode.decode(data);
    if (/<!DOCTYPE/i.test(xml)) throw invalidXlsx();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagNameNS('*', 'parsererror').length) throw invalidXlsx();
    return doc;
  };
}

function relationPath(source: string, target: string): string {
  const base = 'https://xlsx.invalid';
  const url = new URL(target, base + '/' + source);
  if (url.origin !== base || url.search || url.hash) throw invalidXlsx();
  return decodeURIComponent(url.pathname.slice(1));
}

function children(el: Element | null, tag: string): Element[] {
  return el ? Array.from(el.children).filter(child => child.localName === tag) : [];
}

function cellText(el: Element | null): string {
  return children(el, 't').concat(children(el, 'r').flatMap(run => children(run, 't')))
    .map(text => text.textContent || '').join('');
}

function relationshipPath(part: string): string {
  const slash = part.lastIndexOf('/') + 1;
  return part.slice(0, slash) + '_rels/' + part.slice(slash) + '.rels';
}

async function readWorkbook(bytes: ArrayBuffer): Promise<string> {
  const read = zipXml(bytes);
  const packageRelations = children((await read('_rels/.rels')).documentElement, 'Relationship');
  const bookRelation = packageRelations.find(rel => rel.getAttribute('Type')?.endsWith('/officeDocument'));
  const bookTarget = bookRelation?.getAttribute('Target');
  if (!bookTarget || bookRelation?.getAttribute('TargetMode') === 'External') throw invalidXlsx();
  const bookPath = relationPath('', bookTarget);
  const book = await read(bookPath);
  if (book.documentElement.localName !== 'workbook') throw invalidXlsx();
  const relations = children((await read(relationshipPath(bookPath))).documentElement, 'Relationship');
  const relationById = new Map(relations.map(rel => [rel.getAttribute('Id'), rel]));
  const partPath = (rel: Element | undefined): string => {
    const target = rel?.getAttribute('Target');
    if (!target || rel?.getAttribute('TargetMode') === 'External') throw invalidXlsx();
    return relationPath(bookPath, target);
  };
  const shared = relations.find(rel => rel.getAttribute('Type')?.endsWith('/sharedStrings'));
  const strings = shared ? children((await read(partPath(shared))).documentElement, 'si').map(cellText) : [];
  const sheets = children(children(book.documentElement, 'sheets')[0] ?? null, 'sheet');
  const lines: string[] = [];
  let length = 0;
  for (const sheet of sheets) {
    const state = sheet.getAttribute('state');
    if (state === 'hidden' || state === 'veryHidden') continue;
    const id = Array.from(sheet.attributes).find(attr => attr.localName === 'id' && attr.namespaceURI?.endsWith('/relationships'))?.value ?? null;
    const relation = relationById.get(id);
    if (!relation) throw invalidXlsx();
    if (!relation.getAttribute('Type')?.endsWith('/worksheet')) continue;
    const worksheet = (await read(partPath(relation))).documentElement;
    if (worksheet.localName !== 'worksheet') throw invalidXlsx();
    const rows = children(children(worksheet, 'sheetData')[0] ?? null, 'row');
    let hasRows = false;
    for (const row of rows) {
      const cells: string[] = [];
      for (const cell of children(row, 'c')) {
        const type = cell.getAttribute('t');
        const raw = children(cell, 'v')[0]?.textContent ?? '';
        const formula = children(cell, 'f')[0]?.textContent;
        let value = raw;
        if (type === 's' && raw.trim()) {
          const index = raw.trim();
          if (!/^\d+$/.test(index) || strings[Number(index)] === undefined) throw invalidXlsx();
          value = strings[Number(index)];
        } else if (type === 'inlineStr') {
          value = cellText(children(cell, 'is')[0] ?? null);
        } else if (type === 'b') {
          if (raw === '1' || raw === 'true') value = 'TRUE';
          if (raw === '0' || raw === 'false') value = 'FALSE';
        }
        if (formula) value = value ? `${value} [=${formula}]` : `=${formula}`;
        if (!value.trim()) continue;
        const address = cell.getAttribute('r') ?? '';
        const quoted = /[\t\r\n]/.test(value) ? JSON.stringify(value) : value;
        cells.push(address ? `${address}: ${quoted}` : quoted);
      }
      if (!cells.length) continue;
      const line = cells.join('\t');
      if (!hasRows) {
        const heading = `[工作表：${sheet.getAttribute('name') ?? ''}]`;
        lines.push(heading);
        length += heading.length + 1;
        hasRows = true;
      }
      length += line.length + 1;
      if (length > CONTENT_LIMIT + 1) throw oversized();
      lines.push(line);
    }
  }
  return lines.join('\n');
}

function readCsv(bytes: ArrayBuffer): string {
  const bom = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (bom[0] === 0xff && bom[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bom[0] === 0xfe && bom[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
}

export async function readReviewCaseFile(file: File): Promise<string> {
  const ext = /\.(xlsx|csv)$/i.exec(file.name)?.[1].toLowerCase();
  if (!ext) throw new Error('请选择 XLSX 或 CSV 测试用例文件。');
  if (file.size > FILE_LIMIT) throw new Error('用例文件不能超过 8 MB。请拆分文件后上传。');
  const bytes = await file.arrayBuffer();
  try {
    const text = ext === 'xlsx' ? await readWorkbook(bytes) : readCsv(bytes);
    if (text.includes('\0')) throw new Error('CSV 文件包含无效字符，请另存为 UTF-8 CSV 后再上传。');
    return checkedContent(text);
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException || error instanceof RangeError) {
      throw ext === 'xlsx' ? invalidXlsx() : new Error('无法读取 CSV 文件，请另存为 UTF-8 CSV 后再上传。');
    }
    throw error;
  }
}
