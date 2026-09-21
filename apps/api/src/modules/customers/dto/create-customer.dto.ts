import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsBoolean,
  IsNotEmpty,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { isPlaceholderEmail } from '../../../common/helpers/customer-email';

export class CreateCustomerDto {
  @ApiProperty({ description: 'Customer first name' })
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @ApiProperty({ description: 'Customer last name' })
  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @ApiProperty({ description: 'Customer phone number' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiPropertyOptional({ description: 'Customer email address (blank or "N/A" is recorded as no address)' })
  @IsOptional()
  // CR-2026-113 — blank and placeholder text mean "not supplied", so they become
  // null instead of failing validation with "email must be an email". Anything
  // else has to be a real address.
  @Transform(({ value }: { value: unknown }) => (isPlaceholderEmail(typeof value === 'string' ? value : null) ? null : value))
  @ValidateIf((_o: unknown, value: unknown) => value !== null && value !== undefined)
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({ description: 'Whether the customer is a Bert\'s loyalty member (yes/no)' })
  @IsOptional()
  @IsBoolean()
  loyaltyMember?: boolean;

  @ApiPropertyOptional({
    description: 'Opt-in for SMS notifications',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  notificationOptInSms?: boolean;

  @ApiPropertyOptional({
    description: 'Opt-in for email notifications',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  notificationOptInEmail?: boolean;

  @ApiPropertyOptional({ description: 'Internal notes about the customer' })
  @IsOptional()
  @IsString()
  notes?: string;
}
