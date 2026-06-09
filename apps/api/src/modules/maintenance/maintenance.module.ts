import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MaintenanceService } from './maintenance.service';
import { MaintenanceReminderService } from './maintenance-reminder.service';
import { MaintenanceReminderController } from './maintenance-reminder.controller';
import {
  MaintenanceVehicleController,
  MaintenanceServiceOrderController,
  MaintenanceRecommendationController,
  MaintenanceDueController,
} from './maintenance.controller';
import { VEHICLE_IDENTITY_PROVIDER } from './providers/vehicle-identity.provider.interface';
import { FLUID_SPEC_PROVIDER } from './providers/fluid-spec.provider.interface';
import { NhtsaVehicleIdentityProvider } from './providers/nhtsa-vehicle-identity.provider';
import { StubVehicleIdentityProvider } from './providers/stub-vehicle-identity.provider';
import { StubFluidSpecProvider } from './providers/stub-fluid-spec.provider';

const VinProvider =
  process.env.VIN_DECODE_PROVIDER === 'STUB'
    ? StubVehicleIdentityProvider
    : NhtsaVehicleIdentityProvider;

@Module({
  imports: [AuditModule],
  controllers: [
    MaintenanceVehicleController,
    MaintenanceServiceOrderController,
    MaintenanceRecommendationController,
    MaintenanceDueController,
    MaintenanceReminderController,
  ],
  providers: [
    MaintenanceService,
    MaintenanceReminderService,
    {
      provide: VEHICLE_IDENTITY_PROVIDER,
      useClass: VinProvider,
    },
    {
      provide: FLUID_SPEC_PROVIDER,
      useClass: StubFluidSpecProvider,
    },
  ],
  exports: [MaintenanceService, MaintenanceReminderService],
})
export class MaintenanceModule {}
