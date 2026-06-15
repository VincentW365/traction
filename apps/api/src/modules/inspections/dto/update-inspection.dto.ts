import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional, IsEnum, IsInt, IsString, IsBoolean, IsArray, ValidateNested, IsUUID, IsNumber, Min, MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { InspectionItemResult, BatteryTestResult, WheelPosition, RotorOrDrum } from '@prisma/client';

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
}
