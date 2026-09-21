import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEmail, IsBoolean, IsIn, ValidateIf } from 'class-validator';
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

  /**
   * CR-2026-114 — DEPRECATED in favour of `emailMarketingPreference`. A boolean
   * cannot say "we have never asked", which is the state 6,857 imported
   * customers are actually in. Accepted for older clients: true → ALLOWED,
   * false → DECLINED, because a person ticking or unticking a box on a screen
   * IS making a decision. It is never used to infer UNKNOWN.
   */
  @ApiPropertyOptional({ deprecated: true, description: 'Deprecated — use emailMarketingPreference' })
  @IsOptional()
  @IsBoolean()
  notificationOptInEmail?: boolean;

  /**
   * CR-2026-114 — the customer's recorded wish about OPTIONAL email (service-due
   * campaigns, offers). Operational email is never governed by this.
   */
  @ApiPropertyOptional({ enum: ['UNKNOWN', 'ALLOWED', 'DECLINED'], description: "Optional-email preference" })
  @IsOptional()
  @IsIn(['UNKNOWN', 'ALLOWED', 'DECLINED'])
  emailMarketingPreference?: 'UNKNOWN' | 'ALLOWED' | 'DECLINED';

  /** Why it changed, when a person has a reason worth recording. */
  @ApiPropertyOptional({ description: 'Context for a preference change' })
  @IsOptional()
  @IsString()
  preferenceNote?: string;

  @ApiPropertyOptional({ description: 'Internal notes about the customer' })
  @IsOptional()
  @IsString()
  notes?: string;
}
