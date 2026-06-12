import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsNotEmpty } from 'class-validator';

/** CR-2026-026 — link a hold to the appointment created from it. */
export class ConvertScheduleHoldDto {
  @ApiProperty({ description: 'The appointment this hold was converted into' })
  @IsUUID()
  @IsNotEmpty()
  appointmentId!: string;
}
