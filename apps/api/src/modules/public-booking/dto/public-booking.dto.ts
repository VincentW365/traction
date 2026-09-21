import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * CR-2026-105c — public booking DTOs. Every public body/query is validated by the
 * global ValidationPipe (whitelist + forbidNonWhitelisted), so nothing beyond
 * these fields reaches the service.
 *
 * CR-2026-106 — identification accepts a second pair (mobile + email) so a
 * customer without the plate to hand can still be recognised; names are never an
 * identity key. The confirm body carries the service-request facts the Job Sheet
 * needs (reason, concern, description, mileage).
 */

export class IdentifyDto {
  @ApiProperty({ description: 'Mobile number as the customer knows it' })
  @IsString() @IsNotEmpty() @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional({ description: 'Licence plate (pair 1: mobile + plate)' })
  @IsOptional() @IsString() @MaxLength(20)
  plateNumber?: string;

  @ApiPropertyOptional({ description: 'Email on file (pair 2: mobile + email)' })
  @IsOptional() @IsEmail() @MaxLength(120)
  email?: string;
}

export class AvailabilityQueryDto {
  @ApiProperty({ description: 'Comma-separated service codes' })
  @IsString() @IsNotEmpty() @MaxLength(200)
  serviceCodes!: string;

  @ApiPropertyOptional({ description: 'First day to show, YYYY-MM-DD (site local); defaults to today' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'Days to show (capped by the advance window)', default: 14 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60)
  days?: number;

  /**
   * CR-2026-111 — which of the customer's vehicles the quote is for.
   *
   * The server reads the vehicle's service class from the record to resolve the
   * duration (General Servicing is 90 for a sedan, 120 for an SUV). The caller
   * supplies the id, never the class, so nobody can claim "sedan" to shorten the
   * slot. An id that is unknown simply yields the base duration — the response
   * reveals only slot times, which are public anyway.
   */
  @ApiPropertyOptional({ description: "The customer's vehicle, so the quoted length matches the vehicle class" })
  @IsOptional() @IsUUID()
  vehicleId?: string;
}

export class NewCustomerDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(80)
  firstName!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(80)
  lastName!: string;

  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(30)
  phone!: string;

  /**
   * CR-2026-112 — REQUIRED for an online booking. The confirmation email is how
   * a self-service customer receives their reference and the link to change or
   * cancel, and email is the only channel this release sends on. Staff-created
   * appointments keep email optional: the advisor has the customer in front of
   * them and can read the reference out.
   */
  @ApiProperty({ description: 'Where the booking confirmation and manage link are sent' })
  @IsEmail({}, { message: 'Enter an email address so we can send your confirmation and your link to change or cancel.' })
  @MaxLength(120)
  email!: string;

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean()
  emailOptIn?: boolean;
}

export class NewVehicleDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(20)
  plateNumber!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60)
  make?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60)
  model?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2100)
  modelYear?: number;
}

/** CR-2026-106 — what the customer tells us about the visit (Job Sheet preparation). */
export class ServiceRequestDto {
  @ApiPropertyOptional({ description: 'Why they are coming in (e.g. routine service, warning light, noise)' })
  @IsOptional() @IsString() @MaxLength(120)
  reasonForVisit?: string;

  @ApiPropertyOptional({ description: 'Main concern in their words' })
  @IsOptional() @IsString() @MaxLength(500)
  concern?: string;

  @ApiPropertyOptional({ description: 'Anything else the workshop should know' })
  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Current odometer reading as the customer reads it' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(9_999_999)
  mileage?: number;

  // --- CR-2026-111 — structured intake -------------------------------------

  @ApiPropertyOptional({
    description:
      'The customer-facing card they chose (GENERAL_SERVICING, OIL_CHANGE, BATTERY, BRAKES, TIRES, INSPECTION, CLEANING, OTHER). ' +
      'Kept alongside the resolved service codes because "what they asked for" and "what it mapped to" are different questions.',
  })
  @IsOptional() @IsString() @MaxLength(40)
  category?: string;

  @ApiPropertyOptional({
    description:
      'Symptom codes the customer ticked, e.g. BRAKE_NOISE. Intake information only — nothing downstream may read these as a diagnosis.',
    type: [String],
  })
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(40, { each: true }) @ArrayMaxSize(12)
  symptoms?: string[];
}

export class ConfirmBookingDto {
  @ApiPropertyOptional({ description: 'Session token from /identify (existing customer)' })
  @IsOptional() @IsString() @MaxLength(2000)
  sessionToken?: string;

  @ApiPropertyOptional({ type: NewCustomerDto, description: 'New customer (when no session token)' })
  @IsOptional() @ValidateNested() @Type(() => NewCustomerDto)
  customer?: NewCustomerDto;

  @ApiPropertyOptional({ format: 'uuid', description: "One of the identified customer's vehicles" })
  @IsOptional() @IsUUID()
  vehicleId?: string;

  @ApiPropertyOptional({ type: NewVehicleDto })
  @IsOptional() @ValidateNested() @Type(() => NewVehicleDto)
  vehicle?: NewVehicleDto;

  @ApiProperty({ type: [String] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @IsString({ each: true })
  serviceCodes!: string[];

  @ApiProperty({ description: 'Chosen slot start (ISO 8601)' })
  @IsDateString()
  scheduledStartAt!: string;

  @ApiPropertyOptional({ type: ServiceRequestDto, description: 'CR-2026-106 — reason / concern / description / mileage' })
  @IsOptional() @ValidateNested() @Type(() => ServiceRequestDto)
  serviceRequest?: ServiceRequestDto;

  // CR-2026-108 Stage 3 — there is deliberately NO uat field here. The UAT context
  // arrives as an HttpOnly cookie minted by /public/booking/uat/redeem, so the
  // privileged token never travels in a form body, a URL or anything the page can
  // read back.
}

export class CancelBookingDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300)
  reason?: string;
}

export class RescheduleBookingDto {
  @ApiProperty({ description: 'New slot start (ISO 8601)' })
  @IsDateString()
  scheduledStartAt!: string;
}
