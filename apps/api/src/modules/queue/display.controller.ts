import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { QueueService } from './queue.service';

/**
 * Public waiting-room display board — NO authentication required.
 *
 * Designed for an unattended screen (wall TV / kiosk) in the customer lobby.
 * Access is gated by an unguessable token configured in BusinessRuleConfig
 * (`display_board_token`), not by login. The response is a sanitized,
 * PII-free projection of the queue (ticket numbers only — see
 * QueueService.getPublicDisplayBoard and CLAUDE.md §10).
 */
@ApiTags('Public Display Board')
@Controller('display')
export class DisplayController {
  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
  ) {}

  @Get(':token')
  @ApiOperation({ summary: 'Get the public waiting-room queue board (public, token-gated, no auth)' })
  async getBoard(@Param('token') token: string) {
    const rules = await this.prisma.businessRuleConfig.findMany({
      where: {
        ruleKey: { in: ['display_board_token', 'display_board_enabled'] },
        effectiveTo: null,
      },
      select: { ruleKey: true, valueJson: true, siteId: true },
    });

    const tokenRule = rules.find((r) => r.ruleKey === 'display_board_token');
    const enabledRule = rules.find((r) => r.ruleKey === 'display_board_enabled');

    // Generic 404 on any failure — never reveal whether the board exists.
    const notFound = new NotFoundException('Display board not found.');

    if (enabledRule && enabledRule.valueJson === false) throw notFound;
    if (!tokenRule || typeof tokenRule.valueJson !== 'string') throw notFound;
    if (tokenRule.valueJson !== token) throw notFound;

    // Resolve the site: prefer the token's scoped site, else the first site.
    let siteId = tokenRule.siteId ?? undefined;
    if (!siteId) {
      const site = await this.prisma.site.findFirst({ select: { id: true } });
      if (!site) throw notFound;
      siteId = site.id;
    }

    return this.queueService.getPublicDisplayBoard(siteId);
  }
}
