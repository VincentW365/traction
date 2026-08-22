/**
 * CR-2026-093 — what a photograph actually is, decided from its bytes.
 *
 * The filename is a claim made by whoever uploaded the file, and `.jpg` on the end of
 * a Windows executable is a claim as easy to make as any other. Everything here reads
 * the content instead: format from the magic bytes, dimensions from the header, and a
 * refusal for anything that is not one of the three formats the shop actually uses.
 *
 * SVG is deliberately absent from the accepted set. It is a document format that can
 * carry script and external references, and there is no sanitiser in this codebase to
 * put in front of it — a vector "photograph" of a vehicle is not a real requirement.
 *
 * Written by hand rather than with an image library. `sharp` is present in the lockfile
 * as somebody else's transitive dependency but is not a declared dependency of this
 * API, and adding one to a core flow is a governed decision (CLAUDE.md §9), not
 * something to slip in behind a photo upload. The consequence is stated honestly in
 * `stripMetadata`: EXIF removal and orientation capture are implemented, re-encoding
 * and thumbnailing are not.
 *
 * Pure functions over buffers. No I/O.
 */

export type AcceptedMime = 'image/jpeg' | 'image/png' | 'image/webp';

export const ACCEPTED_MIME_TYPES: readonly AcceptedMime[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

/** 10 MB per original, per CR-2026-093 §12. */
export const MAX_BYTES = 10 * 1024 * 1024;

/** 12 images per pre-inspection, per CR-2026-093 §12. */
export const MAX_PHOTOS_PER_INSPECTION = 12;

export interface ImageFacts {
  mimeType: AcceptedMime;
  width: number | null;
  height: number | null;
  /**
   * EXIF orientation (1-8) where the original declared one, captured BEFORE the
   * metadata is stripped. Kept so a photo taken sideways on a phone can be displayed
   * the right way up — without it, stripping EXIF would silently rotate every
   * portrait photograph the shop takes.
   */
  orientation: number | null;
}

export class ImageRejected extends Error {
  constructor(
    message: string,
    readonly code:
      | 'EMPTY'
      | 'TOO_LARGE'
      | 'UNSUPPORTED_FORMAT'
      | 'EXECUTABLE'
      | 'CORRUPT',
  ) {
    super(message);
    this.name = 'ImageRejected';
  }
}

const startsWith = (buf: Buffer, bytes: readonly number[], offset = 0): boolean => {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
};

/**
 * Formats that must never be accepted, named individually so the refusal can say what
 * it actually found rather than "unsupported".
 */
function detectHostileFormat(buf: Buffer): string | null {
  if (startsWith(buf, [0x4d, 0x5a])) return 'a Windows executable';
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return 'a Linux executable';
  if (startsWith(buf, [0xca, 0xfe, 0xba, 0xbe])) return 'a Mach-O executable';
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return 'a PDF';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return 'a zip archive';
  if (startsWith(buf, [0x23, 0x21])) return 'a script';

  // SVG and any other XML/HTML document, with or without a leading BOM or whitespace.
  const head = buf.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype') || head.startsWith('<html')) {
    return 'a markup document';
  }
  return null;
}

function detectMime(buf: Buffer): AcceptedMime | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

// --- dimensions -----------------------------------------------------------

function pngSize(buf: Buffer): { width: number; height: number } | null {
  // IHDR must be the first chunk; its width/height sit at a fixed offset.
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0-SOF15 hold the frame size. DHT/JPG/DAC share the range and must be skipped.
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf: Buffer): { width: number; height: number } | null {
  const fourcc = buf.toString('latin1', 12, 16);
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X' && buf.length >= 30) {
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

// --- EXIF orientation -----------------------------------------------------

/** Read the orientation tag out of a JPEG APP1/Exif segment, if present. */
function jpegOrientation(buf: Buffer): number | null {
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan — no metadata past here
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      const tiff = i + 10;
      if (tiff + 8 > buf.length) return null;
      const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
      const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > buf.length) return null;
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const entry = ifd + 2 + e * 12;
        if (entry + 12 > buf.length) break;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : null;
        }
      }
      return null;
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

/**
 * Decide what a buffer is, or refuse it.
 *
 * The declared MIME type from the browser is deliberately ignored — it is part of the
 * same request as the filename and no more trustworthy.
 */
export function inspectImage(buf: Buffer, declaredSize?: number): ImageFacts {
  if (!buf || buf.length === 0) {
    throw new ImageRejected('The file is empty.', 'EMPTY');
  }
  const size = declaredSize ?? buf.length;
  if (size > MAX_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    throw new ImageRejected(
      `That image is ${mb} MB. The limit is 10 MB — take the photo again at a lower resolution.`,
      'TOO_LARGE',
    );
  }

  const hostile = detectHostileFormat(buf);
  if (hostile) {
    throw new ImageRejected(
      `That file is ${hostile}, not a photograph, whatever its name says.`,
      'EXECUTABLE',
    );
  }

  const mimeType = detectMime(buf);
  if (!mimeType) {
    throw new ImageRejected(
      'That file is not a JPEG, PNG or WebP image.',
      'UNSUPPORTED_FORMAT',
    );
  }

  const size2 =
    mimeType === 'image/png' ? pngSize(buf)
    : mimeType === 'image/jpeg' ? jpegSize(buf)
    : webpSize(buf);

  // A file with the right magic bytes but no readable header is truncated or damaged.
  // Storing it would mean an inspection carrying a photograph nobody can open.
  if (!size2 || size2.width <= 0 || size2.height <= 0) {
    throw new ImageRejected(
      'That image could not be read — it looks truncated or damaged. Try uploading it again.',
      'CORRUPT',
    );
  }

  return {
    mimeType,
    width: size2.width,
    height: size2.height,
    orientation: mimeType === 'image/jpeg' ? jpegOrientation(buf) : null,
  };
}

// --- metadata stripping ---------------------------------------------------

/**
 * Remove metadata that should not leave the workshop.
 *
 * A phone photograph of a customer's car carries the GPS coordinates where it was
 * taken, the device serial, and often a thumbnail of the original frame. None of that
 * belongs in a service record, and all of it survives an ordinary file copy.
 *
 * What this does NOT do, for want of an image library: re-encode, downscale, or
 * produce a thumbnail. Orientation is read out first (see `inspectImage`) and stored
 * so display can compensate, because stripping EXIF without keeping it would turn
 * every portrait photo sideways.
 */
export function stripMetadata(buf: Buffer, mimeType: AcceptedMime): Buffer {
  if (mimeType === 'image/jpeg') return stripJpeg(buf);
  if (mimeType === 'image/png') return stripPng(buf);
  return stripWebp(buf);
}

function stripJpeg(buf: Buffer): Buffer {
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda) {
      // Start of scan: everything from here is compressed image data.
      out.push(buf.subarray(i));
      return Buffer.concat(out);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) break;
    // Drop every APPn except APP0/JFIF, which carries only density and is what
    // decoders expect to find first. APP1 is Exif (and GPS), APP13 is IPTC.
    const isAppSegment = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    const keep = !((isAppSegment && marker !== 0xe0) || isComment);
    if (keep) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  // Unparseable tail: return the original rather than a truncated image.
  return out.length > 1 ? Buffer.concat([...out, buf.subarray(i)]) : buf;
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) break;
    if (!PNG_DROP.has(type)) out.push(buf.subarray(i, end));
    if (type === 'IEND') return Buffer.concat(out);
    i = end;
  }
  return Buffer.concat(out);
}

const WEBP_DROP = new Set(['EXIF', 'XMP ']);

function stripWebp(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const padded = len + (len % 2);
    const end = i + 8 + padded;
    if (end > buf.length) break;
    if (!WEBP_DROP.has(type)) chunks.push(buf.subarray(i, end));
    i = end;
  }
  if (chunks.length === 0) return buf;
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/**
 * A filename safe to store and to echo back in a Content-Disposition header.
 *
 * Path separators, traversal sequences and control characters all go; the extension is
 * taken from the DETECTED type, not from whatever the upload claimed.
 */
export function sanitizeFilename(original: string, mimeType: AcceptedMime): string {
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp';
  const base = (original || 'photo')
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.[^.]*$/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80);
  return `${base || 'photo'}.${ext}`;
}
