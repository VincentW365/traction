import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ROLE_PERMISSIONS } from '../../common/constants/permissions';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

@Injectable()
export class AuthService {
  private readonly jwtSecret = process.env.JWT_SECRET!;
  private readonly accessExpiry = process.env.JWT_ACCESS_EXPIRY || '15m';
  private readonly refreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';

  constructor(private prisma: PrismaService) {}

  async login(email: string, password: string) {
    const user = await this.prisma.userAccount.findFirst({
      where: { email, status: 'ACTIVE' },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const permissions = ROLE_PERMISSIONS[user.roleCode] ?? [];

    const payload: JwtPayload = {
      sub: user.id,
      role: user.roleCode,
      siteId: user.siteId,
      permissions,
    };

    const accessToken = jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.accessExpiry as jwt.SignOptions['expiresIn'],
    });

    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: this.refreshExpiry as jwt.SignOptions['expiresIn'] },
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        roleCode: user.roleCode,
        siteId: user.siteId,
      },
    };
  }

  async refresh(refreshToken: string) {
    try {
      const decoded = jwt.verify(refreshToken, this.jwtSecret) as {
        sub: string;
        type: string;
      };

      if (decoded.type !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.prisma.userAccount.findUnique({
        where: { id: decoded.sub },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('User not found or inactive');
      }

      const permissions = ROLE_PERMISSIONS[user.roleCode] ?? [];

      const payload: JwtPayload = {
        sub: user.id,
        role: user.roleCode,
        siteId: user.siteId,
        permissions,
      };

      const accessToken = jwt.sign(payload, this.jwtSecret, {
        expiresIn: this.accessExpiry as jwt.SignOptions['expiresIn'],
      });

      return { accessToken };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async getProfile(userId: string) {
    const user = await this.prisma.userAccount.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        roleCode: true,
        siteId: true,
        status: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }
}
