/**
 * xlsx-lite — a tiny, dependency-free reader for the bits of .xlsx we need
 * (CR-2026-019, P1a). Reads the ZIP container with node:zlib and extracts cell
 * values from worksheet XML. No third-party packages.
 *
 * Scope: enough to read sheet name -> grid (string[][]). Values are returned as
 * strings exactly as stored (numbers kept as their textual form so the caller
 * decides rounding). Only the sheets the caller asks for are inflated/parsed, so
 * excluded sheets (e.g. the PII tab) are never read into memory.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  localHeaderOffset: number;
}

function findEocd(buf: Buffer): number {
  // End of Central Directory signature 0x06054b50, scan backwards.
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('xlsx-lite: EOCD not found (not a valid zip/xlsx)');
}

function readCentralDirectory(buf: Buffer): Map<string, ZipEntry> {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // central dir header
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const fnLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + fnLen);
    entries.set(name, { name, method, compSize, localHeaderOffset });
    off += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(buf: Buffer, e: ZipEntry): string {
  // Local file header: 30-byte fixed part, then filename + extra, then data.
  const lo = e.localHeaderOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('xlsx-lite: bad local header');
  const fnLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + fnLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) return raw.toString('utf8'); // stored
  if (e.method === 8) return inflateRawSync(raw).toString('utf8'); // deflate
  throw new Error(`xlsx-lite: unsupported compression method ${e.method}`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    }
    return ENTITIES[code] ?? _m;
  });
}

function colToIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Concatenate the text of all <t> nodes inside a shared-string <si> block. */
function siText(block: string): string {
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out += m[1];
  return decodeXml(out);
}

export interface XlsxWorkbook {
  /** sheet display name -> worksheet entry path (e.g. "xl/worksheets/sheet9.xml") */
  sheetFileByName: Map<string, string>;
  /** read a worksheet by its display (tab) name into a dense string grid */
  readGrid(sheetName: string): string[][];
}

export function openXlsx(path: string): XlsxWorkbook {
  const buf = readFileSync(path);
  const dir = readCentralDirectory(buf);
  const read = (name: string): string | null => {
    const e = dir.get(name);
    return e ? extractEntry(buf, e) : null;
  };

  // shared strings (lazy, parsed once)
  let sharedStrings: string[] | null = null;
  const getShared = (): string[] => {
    if (sharedStrings) return sharedStrings;
    const xml = read('xl/sharedStrings.xml');
    const arr: string[] = [];
    if (xml) {
      const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml))) arr.push(siText(m[1]));
    }
    sharedStrings = arr;
    return arr;
  };

  // map sheet display name -> file via workbook.xml + its rels
  const wb = read('xl/workbook.xml') ?? '';
  const rels = read('xl/_rels/workbook.xml.rels') ?? '';
  const ridToTarget = new Map<string, string>();
  {
    const re = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rels))) ridToTarget.set(m[1], m[2]);
  }
  const sheetFileByName = new Map<string, string>();
  {
    const re = /<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(wb))) {
      const name = decodeXml(m[1]);
      const target = ridToTarget.get(m[2]);
      if (target) sheetFileByName.set(name, 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, ''));
    }
  }

  const readGrid = (sheetName: string): string[][] => {
    const file = sheetFileByName.get(sheetName);
    if (!file) throw new Error(`xlsx-lite: sheet "${sheetName}" not found`);
    const xml = read(file);
    if (!xml) throw new Error(`xlsx-lite: worksheet entry ${file} missing`);
    const shared = getShared();
    const grid: string[][] = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(xml))) {
      const cells: Record<number, string> = {};
      let maxc = -1;
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1];
        const inner = cm[2];
        const rAttr = /r="([A-Z]+\d+)"/.exec(attrs);
        const tAttr = /t="([^"]+)"/.exec(attrs);
        const ci = rAttr ? colToIndex(rAttr[1]) : maxc + 1;
        let val = '';
        if (inner != null) {
          const t = tAttr ? tAttr[1] : '';
          if (t === 's') {
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
            if (v) { const idx = parseInt(v[1], 10); if (idx >= 0 && idx < shared.length) val = shared[idx]; }
          } else if (t === 'inlineStr') {
            let s = '';
            const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
            let tm: RegExpExecArray | null;
            while ((tm = tre.exec(inner))) s += tm[1];
            val = decodeXml(s);
          } else {
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
            if (v) val = decodeXml(v[1]);
          }
        }
        cells[ci] = val;
        if (ci > maxc) maxc = ci;
      }
      const line: string[] = [];
      for (let i = 0; i <= maxc; i++) line.push(cells[i] ?? '');
      grid.push(line);
    }
    return grid;
  };

  return { sheetFileByName, readGrid };
}
