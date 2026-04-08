import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEmail, IsBoolean } from 'class-validator';

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

  @ApiPropertyOptional({ description: 'Customer email address' })
  @IsOptional()
  @IsEmail()
  email?: string;

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
