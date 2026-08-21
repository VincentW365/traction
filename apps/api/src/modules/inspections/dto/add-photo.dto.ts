import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * CR-2026-087 — a pre-inspection vehicle photo taken on the technician's tablet.
 *
 * The image arrives as a base64 data URL in the JSON body, following the existing
 * drawn-signature precedent, because this deployment has no object store and
 * Render's free plan has no persistent disk.
 *
 * The size cap is the real control here. A raw tablet photo is 1-5 MB, which
 * base64-encodes to roughly 1.4-7 MB; the client downscales to a longest edge of
 * 1280px before upload, landing around 150-300 kB. 6 MB accepts a reasonable
 * un-downscaled photo rather than failing opaquely, while still refusing anything
 * that would bloat the row. The body parser is set to 8 MB so this validator is
 * what rejects an oversized image, with a message that explains itself.
 */
export class AddInspectionPhotoDto {
  @ApiProperty({
    description: 'Photo as a base64 data URL, e.g. "data:image/jpeg;base64,..."',
  })
  @IsString()
  @Matches(/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/, {
    message: 'imageData must be a base64 data URL for a JPEG, PNG or WebP image.',
  })
  @MaxLength(6_000_000, {
    message:
      'Photo is too large. Please retake it at a lower resolution — images are downscaled before upload.',
  })
  imageData!: string;

  @ApiPropertyOptional({ description: 'Optional note, e.g. "front bumper scuff on arrival"' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;
}
