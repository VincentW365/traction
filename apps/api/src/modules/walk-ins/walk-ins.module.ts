import { Module } from '@nestjs/common';
import { WalkInsController } from './walk-ins.controller';
import { WalkInsService } from './walk-ins.service';

@Module({
  controllers: [WalkInsController],
  providers: [WalkInsService],
  exports: [WalkInsService],
})
export class WalkInsModule {}
