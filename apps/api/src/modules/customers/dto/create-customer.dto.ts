import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsBoolean,
  IsNotEmpty,
} from 'class-validator';

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

  @ApiPropertyOptional({ description: 'Customer email address' })
  @IsOptional()
  @IsEmail()
  email?: string;

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
