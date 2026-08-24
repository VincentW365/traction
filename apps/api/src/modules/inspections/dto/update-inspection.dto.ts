import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional, IsEnum, IsInt, IsString, IsBoolean, IsArray, ValidateNested, IsUUID, IsNumber, Min, MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { InspectionItemResult, BatteryTestResult, WheelPosition, RotorOrDrum, NoPhotoReason } from '@prisma/client';

/** A single checklist line result update (line is identified by its inspection-item id). */
export class UpdateInspectionItemDto {
  @IsUUID()
  itemId!: string;

  @IsEnum(InspectionItemResult)
  result!: InspectionItemResult;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Per-wheel brake/tire measurement update (wheel identified by position). */
export class UpdateWheelDto {
  @IsEnum(WheelPosition)
  position!: WheelPosition;

  @IsOptional() @IsNumber() @Min(0) brakeLiningMm?: number;
  @IsOptional() @IsInt() @Min(0) tireTread32nds?: number;
  @IsOptional() @IsString() @MaxLength(120) wearPattern?: string;
  @IsOptional() @IsInt() @Min(0) tirePressureBeforePsi?: number;
  @IsOptional() @IsInt() @Min(0) tirePressureAfterPsi?: number;
  @IsOptional() @IsEnum(RotorOrDrum) rotorOrDrum?: RotorOrDrum;
}

/** CR-2026-034 (C-2) — edit a DRAFT inspection: line results, wheel measurements, battery, flags, comments. */
export class UpdateInspectionDto {
  @ApiPropertyOptional({ enum: BatteryTestResult })
  @IsOptional() @IsEnum(BatteryTestResult) batteryTestResult?: BatteryTestResult;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) batteryFactoryCca?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) batteryActualCca?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() alignmentCheckNeeded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() wheelBalanceNeeded?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() brakeInspectionPerformed?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) priorBodyDamageNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) comments?: string;

  @ApiPropertyOptional({ type: [UpdateInspectionItemDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => UpdateInspectionItemDto)
  items?: UpdateInspectionItemDto[];

  @ApiPropertyOptional({ type: [UpdateWheelDto] })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => UpdateWheelDto)
  wheels?: UpdateWheelDto[];

  // CR-2026-093 — the pre-inspection's quick condition record. All optional: the
  // whole record is optional, and a draft may be saved at any point.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) generalCondition?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() visibleDamage?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) damageNotes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) itemsLeftInside?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) warningLights?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) fuelLevelNote?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) odometerReading?: number;

  // Why a pre-inspection was completed without photographic evidence — required by
  // the UI before such a completion is allowed through.
  @ApiPropertyOptional({ enum: NoPhotoReason })
  @IsOptional() @IsEnum(NoPhotoReason) noPhotoReason?: NoPhotoReason;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) noPhotoReasonNote?: string;
}
