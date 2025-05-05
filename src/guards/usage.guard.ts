// src/guards/usage.guard.ts
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class UsageGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const usage = await this.prisma.tokenUsage.aggregate({
      where: {
        userId: user.id,
        createdAt: {
          gte: monthStart
        }
      },
      _sum: {
        tokensUsed: true
      }
    });

    const totalTokens = usage._sum.tokensUsed || 0;
    const limit = this.getLimitByMembership(user.membershipLevel);

    // if (totalTokens >= limit) {
    //   throw new ForbiddenException(`Monthly token limit (${limit}) exceeded`);
    // }

    return true;
  }

  private getLimitByMembership(level: string) {
    const limits = {
      FREE: this.config.get('FREE_TIER_LIMIT'),
      PREMIUM: this.config.get('PREMIUM_TIER_LIMIT'),
      VIP: this.config.get('VIP_TIER_LIMIT')
    };
    return limits[level] || limits.FREE;
  }
}