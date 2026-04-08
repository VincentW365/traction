import { ApiProperty } from '@nestjs/swagger';

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty()
  user!: {
    id: string;
    email: string | null;
    fullName: string;
    roleCode: string;
    siteId: string | null;
  };
}
