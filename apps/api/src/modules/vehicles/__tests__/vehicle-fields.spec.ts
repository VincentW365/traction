import { describe, it, expect, vi } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { VehiclesService } from '../vehicles.service';
import { CreateVehicleDto } from '../dto/create-vehicle.dto';
import { UpdateVehicleDto } from '../dto/update-vehicle.dto';
import { StatusController } from '../../status/status.controller';

/**
 * CR-2026-029 — surface existing Vehicle fields (transmission/drivetrain/fuelType/
 * engineNo) on the write path + add the new nullable DriveSide enum. engineNo is
 * sensitive: authenticated-only, never in a public/token projection.
 */

function buildService() {
  const prisma: any = {
    vehicle: {
      create: vi.fn(async (args: any) => ({ id: 'v1', ...args.data })),
      update: vi.fn(async (args: any) => ({ id: 'v1', ...args.data })),
      findUnique: vi.fn(async () => ({ id: 'v1' })),
    },
    customer: { findUnique: vi.fn(async () => ({ id: 'cust-1' })) },
  };
  return { service: new VehiclesService(prisma as any, { autoClassify: async () => ({ applied: false }) } as any), prisma };
}

describe('VehiclesService — new/exposed fields plumbing (CR-2026-029)', () => {
  it('create() persists transmission/drivetrain/fuelType/engineNo/driveSide', async () => {
    const { service, prisma } = buildService();
    await service.create({
      customerId: 'cust-1',
      plateNumber: 'ABC 123',
      transmission: 'Automatic',
      drivetrain: 'AWD',
      fuelType: 'Petrol',
      engineNo: 'ENG-9',
      driveSide: 'RHD',
    } as any);
    const data = prisma.vehicle.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      transmission: 'Automatic',
      drivetrain: 'AWD',
      fuelType: 'Petrol',
      engineNo: 'ENG-9',
      driveSide: 'RHD',
    });
    // vehicleCode generation (CR-2026-027) unaffected
    expect(data.vehicleCode).toBe('SCABC123');
  });

  it('create() defaults the five fields to null when omitted', async () => {
    const { service, prisma } = buildService();
    await service.create({ customerId: 'cust-1', plateNumber: 'XY1' } as any);
    const data = prisma.vehicle.create.mock.calls[0][0].data;
    expect(data.transmission).toBeNull();
    expect(data.drivetrain).toBeNull();
    expect(data.fuelType).toBeNull();
    expect(data.engineNo).toBeNull();
    expect(data.driveSide).toBeNull();
  });

  it('update() only writes provided fields (omitted columns untouched)', async () => {
    const { service, prisma } = buildService();
    await service.update('v1', { driveSide: 'LHD', transmission: 'Manual' } as any);
    const data = prisma.vehicle.update.mock.calls[0][0].data;
    expect(data.driveSide).toBe('LHD');
    expect(data.transmission).toBe('Manual');
    // conditional-spread semantics: omitted fields are absent from the update set
    expect('engineNo' in data).toBe(false);
    expect('fuelType' in data).toBe(false);
    expect('drivetrain' in data).toBe(false);
  });

  it('update() can set engineNo when explicitly provided', async () => {
    const { service, prisma } = buildService();
    await service.update('v1', { engineNo: 'ENG-42' } as any);
    const data = prisma.vehicle.update.mock.calls[0][0].data;
    expect(data.engineNo).toBe('ENG-42');
  });
});

describe('Vehicle DTO validation — driveSide enum (CR-2026-029)', () => {
  it('CreateVehicleDto rejects a non RHD/LHD driveSide', async () => {
    const dto = plainToInstance(CreateVehicleDto, {
      customerId: '11111111-1111-1111-1111-111111111111',
      plateNumber: 'ABC123',
      driveSide: 'INVALID',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'driveSide')).toBe(true);
  });

  it('CreateVehicleDto accepts RHD with the optional string fields', async () => {
    const dto = plainToInstance(CreateVehicleDto, {
      customerId: '11111111-1111-4111-8111-111111111111',
      plateNumber: 'ABC123',
      driveSide: 'RHD',
      transmission: 'Automatic',
      engineNo: 'ENG-9',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('UpdateVehicleDto rejects a bad driveSide but accepts LHD', async () => {
    const bad = await validate(plainToInstance(UpdateVehicleDto, { driveSide: 'XX' }));
    expect(bad.some((e) => e.property === 'driveSide')).toBe(true);
    const ok = await validate(plainToInstance(UpdateVehicleDto, { driveSide: 'LHD' }));
    expect(ok).toHaveLength(0);
  });
});

describe('engineNo privacy — never in the public status projection (CR-2026-029)', () => {
  it('the public /status visit query selects only plateNumber for the vehicle', async () => {
    const prisma: any = {
      serviceVisit: {
        findFirst: vi.fn(async () => ({
          siteId: 's1',
          status: 'CHECKED_IN',
          partsReadiness: 'NOT_REQUIRED',
          vehicle: { plateNumber: 'ABC1234' },
          queueTicket: null,
          appointment: null,
          serviceOrders: [],
        })),
      },
      queueTicket: { count: vi.fn(async () => 0) },
    };
    const ctrl = new StatusController(prisma as any);
    await ctrl.getStatus('tok');

    const include = prisma.serviceVisit.findFirst.mock.calls[0][0].include;
    expect(include.vehicle.select).toEqual({ plateNumber: true });
    expect(include.vehicle.select).not.toHaveProperty('engineNo');
  });
});
