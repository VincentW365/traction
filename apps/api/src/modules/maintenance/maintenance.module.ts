import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MaintenanceService } from './maintenance.service';
import {
  MaintenanceVehicleController,
  MaintenanceServiceOrderController,
  MaintenanceRecommendationController,
  MaintenanceDueController,
} from './maintenance.controller';
import { VEHICLE_IDENTITY_PROVIDER } from './providers/vehicle-identity.provider.interface';
import { FLUID_SPEC_PROVIDER } from './providers/fluid-spec.provider.interface';
import { StubVehicleIdentityProvider } from './providers/stub-vehicle-identity.provider';
import { StubFluidSpecProvider } from './providers/stub-fluid-spec.provider';

@Module({
  imports: [AuditModule],
  controllers: [
    MaintenanceVehicleController,
    MaintenanceServiceOrderController,
    MaintenanceRecommendationController,
    MaintenanceDueController,
  ],
  providers: [
    MaintenanceService,
    {
      provide: VEHICLE_IDENTITY_PROVIDER,
      useClass: StubVehicleIdentityProvider,
    },
    {
      provide: FLUID_SPEC_PROVIDER,
      useClass: StubFluidSpecProvider,
    },
  ],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
