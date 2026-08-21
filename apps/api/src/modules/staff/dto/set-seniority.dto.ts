import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** CR-2026-087 — mark a technician senior (eligible to be assigned a quality check). */
export class SetSeniorityDto {
  @ApiProperty({
    description:
      'Whether this technician is senior. Senior technicians may be assigned a quality check and may sign off an inspection.',
  })
  @IsBoolean()
  isSenior!: boolean;
}
