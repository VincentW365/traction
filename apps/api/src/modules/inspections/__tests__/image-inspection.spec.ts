import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  inspectImage,
  stripMetadata,
  sanitizeFilename,
  ImageRejected,
  MAX_BYTES,
} from '../storage/image-inspection';

/**
 * CR-2026-093 — an upload is judged by its bytes, never by its name.
 *
 * The filename and the declared content type both arrive in the same request as the
 * file, from the same source, and neither is evidence of anything. These tests pin the
 * refusals that matter — an executable wearing a .jpg extension, a truncated image, a
 * file over the limit — and the acceptance of the three formats the shop actually uses.
 */

// --- fixtures: real headers, built rather than pasted -----------------------

/** Minimal but genuinely parseable JPEG: SOI, optional APP1, SOF0, SOS. */
function jpeg(opts: { width?: number; height?: number; exif?: Buffer } = {}): Buffer {
  const { width = 640, height = 480, exif } = opts;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  const jfif = Buffer.alloc(18);
  jfif.writeUInt16BE(0xffe0, 0);
  jfif.writeUInt16BE(16, 2);
  jfif.write('JFIF\0', 4, 'latin1');
  parts.push(jfif);

  if (exif) {
    const seg = Buffer.alloc(4);
    seg.writeUInt16BE(0xffe1, 0);
    seg.writeUInt16BE(exif.length + 2, 2);
    parts.push(seg, exif);
  }

  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  parts.push(sof);

  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
  parts.push(Buffer.from([0x00, 0x11, 0x22, 0x33]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** An Exif APP1 payload carrying GPS-adjacent data and an orientation tag. */
function exifPayload(orientation: number): Buffer {
  const head = Buffer.from('Exif\0\0', 'latin1');
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1'); // big-endian
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 offset
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  return Buffer.concat([head, tiff]);
}

function png(width = 800, height = 600, extraChunks: Buffer[] = []): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    ...extraChunks,
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  return out;
}

/** WebP lossy (VP8 ) container with a readable frame header. */
function webp(width = 320, height = 240, extraChunks: Buffer[] = []): Buffer {
  const vp8 = Buffer.alloc(18);
  vp8.write('VP8 ', 0, 'latin1');
  vp8.writeUInt32LE(10, 4);
  vp8.writeUInt8(0x9d, 11);
  vp8.writeUInt8(0x01, 12);
  vp8.writeUInt8(0x2a, 13);
  vp8.writeUInt16LE(width, 14);
  vp8.writeUInt16LE(height, 16);
  const body = Buffer.concat([vp8, ...extraChunks]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

function webpChunk(type: string, data: Buffer): Buffer {
  const padded = data.length + (data.length % 2);
  const out = Buffer.alloc(8 + padded);
  out.write(type, 0, 'latin1');
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}

// --- accepted formats -------------------------------------------------------

describe('the three formats the shop uses are accepted', () => {
  it('accepts a JPEG and reads its dimensions', () => {
    const facts = inspectImage(jpeg({ width: 4032, height: 3024 }));
    expect(facts.mimeType).toBe('image/jpeg');
    expect(facts.width).toBe(4032);
    expect(facts.height).toBe(3024);
  });

  it('accepts a PNG and reads its dimensions', () => {
    const facts = inspectImage(png(1024, 768));
    expect(facts.mimeType).toBe('image/png');
    expect(facts.width).toBe(1024);
    expect(facts.height).toBe(768);
  });

  it('accepts a WebP and reads its dimensions', () => {
    const facts = inspectImage(webp(1280, 720));
    expect(facts.mimeType).toBe('image/webp');
    expect(facts.width).toBe(1280);
    expect(facts.height).toBe(720);
  });
});

// --- refusals ---------------------------------------------------------------

describe('what must never be stored', () => {
  it('rejects a Windows executable renamed to .jpg', () => {
    // The whole point of sniffing content: this file's NAME is perfectly innocent.
    const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(2048, 0x41)]);
    expect(() => inspectImage(exe)).toThrow(ImageRejected);
    try {
      inspectImage(exe);
    } catch (e) {
      expect((e as ImageRejected).code).toBe('EXECUTABLE');
      expect((e as ImageRejected).message).toMatch(/whatever its name says/i);
    }
  });

  it('rejects an ELF binary', () => {
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(512)]);
    expect(() => inspectImage(elf)).toThrow(/executable/i);
  });

  it('rejects an SVG, with or without leading whitespace', () => {
    // No sanitiser exists in this codebase, and SVG can carry script.
    expect(() => inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow(
      /markup document/i,
    );
    expect(() => inspectImage(Buffer.from('\n   <?xml version="1.0"?><svg/>'))).toThrow(
      /markup document/i,
    );
  });

  it('rejects a PDF and a zip', () => {
    expect(() => inspectImage(Buffer.from('%PDF-1.7\n%abc'))).toThrow(/PDF/i);
    expect(() => inspectImage(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toThrow(/zip/i);
  });

  it('rejects a file over 10 MB', () => {
    // Sized by the declared length so the test does not allocate 10 MB to prove it.
    expect(() => inspectImage(jpeg(), MAX_BYTES + 1)).toThrow(ImageRejected);
    try {
      inspectImage(jpeg(), MAX_BYTES + 1);
    } catch (e) {
      expect((e as ImageRejected).code).toBe('TOO_LARGE');
      expect((e as ImageRejected).message).toMatch(/10 MB/);
    }
  });

  it('rejects an empty file', () => {
    expect(() => inspectImage(Buffer.alloc(0))).toThrow(/empty/i);
  });

  it('rejects a corrupt image whose magic bytes are right but header is not', () => {
    // A truncated upload: it looks like a JPEG and cannot be opened.
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(() => inspectImage(truncated)).toThrow(ImageRejected);
    try {
      inspectImage(truncated);
    } catch (e) {
      expect((e as ImageRejected).code).toBe('CORRUPT');
    }
  });

  it('rejects a PNG whose IHDR is missing', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => inspectImage(Buffer.concat([sig, Buffer.alloc(40)]))).toThrow(/truncated|damaged/i);
  });
});

// --- metadata ---------------------------------------------------------------

describe('metadata that should not leave the workshop', () => {
  it('captures orientation before stripping, so photos are not silently rotated', () => {
    const withExif = jpeg({ exif: exifPayload(6) });
    expect(inspectImage(withExif).orientation).toBe(6);
  });

  it('removes the Exif segment from a JPEG', () => {
    const withExif = jpeg({ exif: exifPayload(6) });
    expect(withExif.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(true);

    const cleaned = stripMetadata(withExif, 'image/jpeg');
    expect(cleaned.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    // Still a readable JPEG of the same size afterwards.
    const facts = inspectImage(cleaned);
    expect(facts.mimeType).toBe('image/jpeg');
    expect(facts.width).toBe(640);
    expect(facts.height).toBe(480);
  });

  it('keeps the JFIF segment, which decoders expect', () => {
    const cleaned = stripMetadata(jpeg({ exif: exifPayload(1) }), 'image/jpeg');
    expect(cleaned.includes(Buffer.from('JFIF', 'latin1'))).toBe(true);
  });

  it('removes eXIf and text chunks from a PNG', () => {
    const dirty = png(100, 100, [
      pngChunk('eXIf', Buffer.from('GPS-ish payload')),
      pngChunk('tEXt', Buffer.from('Comment\0secret')),
    ]);
    const cleaned = stripMetadata(dirty, 'image/png');
    expect(cleaned.includes(Buffer.from('eXIf', 'latin1'))).toBe(false);
    expect(cleaned.includes(Buffer.from('tEXt', 'latin1'))).toBe(false);
    expect(inspectImage(cleaned).width).toBe(100);
  });

  it('removes EXIF and XMP chunks from a WebP', () => {
    const dirty = webp(64, 48, [
      webpChunk('EXIF', Buffer.from('exif bytes')),
      webpChunk('XMP ', Buffer.from('<x:xmpmeta/>')),
    ]);
    const cleaned = stripMetadata(dirty, 'image/webp');
    expect(cleaned.includes(Buffer.from('EXIF', 'latin1'))).toBe(false);
    expect(cleaned.includes(Buffer.from('XMP ', 'latin1'))).toBe(false);
    expect(inspectImage(cleaned).width).toBe(64);
  });
});

// --- filenames --------------------------------------------------------------

describe('filenames are rebuilt, not trusted', () => {
  it('strips path traversal', () => {
    expect(sanitizeFilename('../../../etc/passwd', 'image/jpeg')).toBe('passwd.jpg');
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd', 'image/png')).toBe('cmd.png');
  });

  it('takes the extension from the detected type, not the claimed one', () => {
    // An upload calling itself .exe that really is a PNG still lands as .png.
    expect(sanitizeFilename('payload.exe', 'image/png')).toBe('payload.png');
  });

  it('drops control characters and collapses separators', () => {
    expect(sanitizeFilename('front bumper  photo', 'image/webp')).toBe(
      'frontbumper-photo.webp',
    );
  });

  it('always yields a usable name', () => {
    expect(sanitizeFilename('', 'image/jpeg')).toBe('photo.jpg');
    expect(sanitizeFilename('...', 'image/jpeg')).toBe('photo.jpg');
  });
});
