import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * CR-2026-093 — where inspection photographs live.
 *
 * A boundary rather than a direct filesystem call, because the pilot runs on a local
 * disk and production will not. Everything above this file deals in opaque storage
 * keys, so swapping the driver for S3 or Azure Blob later is a change here and nowhere
 * in the inspection domain.
 *
 * Two properties the domain depends on and must not have to think about:
 *
 *   KEYS ARE UNGUESSABLE. A key is 32 bytes of randomness, not the inspection number
 *   and not a sequence. Even if a URL leaked, the next photograph is not one increment
 *   away. Authorisation is still enforced on every read — this is depth, not the fence.
 *
 *   READS ARE CONFINED. `get` resolves the final path and refuses anything that lands
 *   outside the configured root, so a key that ever arrived from outside cannot walk up
 *   the tree.
 */

export interface StoredObject {
  key: string;
  byteSize: number;
  checksumSha256: string;
}

export interface PhotoStorageDriver {
  readonly name: string;
  put(body: Buffer, mimeType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** 32 random bytes, sharded two levels so no directory grows without bound. */
function newKey(mimeType: string): string {
  const id = randomBytes(32).toString('hex');
  return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.${EXT[mimeType] ?? 'bin'}`;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Local disk. The development and single-site pilot driver.
 *
 * Deliberately NOT under the web root or any statically served directory: these files
 * are reached only through the authorised endpoint.
 */
export class LocalDiskPhotoStorage implements PhotoStorageDriver {
  readonly name = 'local-disk';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    // Containment check. A key is generated here and never supplied by a caller, but
    // that is an invariant of today's code rather than a property of the type.
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new NotFoundException('Photo not found');
    }
    return full;
  }

  async put(body: Buffer, mimeType: string): Promise<StoredObject> {
    const key = newKey(mimeType);
    const full = this.pathFor(key);
    await fs.mkdir(join(full, '..'), { recursive: true });
    await fs.writeFile(full, body);
    return { key, byteSize: body.length, checksumSha256: sha256(body) };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.pathFor(key));
    } catch {
      throw new NotFoundException('Photo not found');
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(key));
    } catch {
      // Already gone is the desired end state.
    }
  }
}

/**
 * Chooses the driver from configuration.
 *
 * `INSPECTION_PHOTO_DRIVER` selects; only `local` is implemented. An unrecognised value
 * fails loudly at startup rather than silently falling back to disk — a production
 * instance that thinks it is writing to object storage while filling an ephemeral
 * container disk loses every photograph on the next deploy, and does so quietly.
 */
@Injectable()
export class InspectionPhotoStorage implements PhotoStorageDriver {
  private readonly logger = new Logger(InspectionPhotoStorage.name);
  private readonly driver: PhotoStorageDriver;

  constructor() {
    const configured = (process.env.INSPECTION_PHOTO_DRIVER ?? 'local').toLowerCase();
    if (configured !== 'local') {
      throw new Error(
        `INSPECTION_PHOTO_DRIVER="${configured}" is not implemented. ` +
          'Only "local" exists today; add a driver before configuring one.',
      );
    }
    const root = process.env.INSPECTION_PHOTO_ROOT ?? join(process.cwd(), '.data', 'inspection-photos');
    this.driver = new LocalDiskPhotoStorage(root);
    this.logger.log(`Inspection photo storage: ${this.driver.name} (${root})`);
  }

  get name(): string {
    return this.driver.name;
  }

  put(body: Buffer, mimeType: string): Promise<StoredObject> {
    return this.driver.put(body, mimeType);
  }

  get(key: string): Promise<Buffer> {
    return this.driver.get(key);
  }

  remove(key: string): Promise<void> {
    return this.driver.remove(key);
  }
}
