import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEmail, IsBoolean, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { isPlaceholderEmail } from '../../../common/helpers/customer-email';

export class UpdateCustomerDto {
  @ApiPropertyOptional({ description: 'Customer first name' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ description: 'Customer last name' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ description: 'Customer phone number' })
  @IsOptional()
  @IsString()
  phone?: string;

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
  })
  @IsOptional()
  @IsBoolean()
  notificationOptInSms?: boolean;

  @ApiPropertyOptional({
    description: 'Opt-in for email notifications',
  })
  @IsOptional()
  @IsBoolean()
  notificationOptInEmail?: boolean;

  @ApiPropertyOptional({ description: 'Internal notes about the customer' })
  @IsOptional()
  @IsString()
  notes?: string;
}
