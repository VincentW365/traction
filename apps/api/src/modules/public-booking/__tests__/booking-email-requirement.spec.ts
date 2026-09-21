import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { NewCustomerDto } from '../dto/public-booking.dto';
import { CreateAppointmentDto } from '../../appointments/dto/create-appointment.dto';
import { normalizeCustomerEmail } from '../../../common/helpers/customer-email';

/**
 * CR-2026-114 §5/§8 — online booking needs an email; staff booking does not.
 *
 * Why the asymmetry is correct: the confirmation email IS the self-service
 * customer's receipt — it carries the reference and the only link they have to
 * change or cancel. An advisor booking for someone has the customer in front of
 * them, or on the phone, and can read the reference out. Requiring an address
 * there would turn "we cannot email you" into "we cannot serve you".
 */

const base = { firstName: 'Jane', lastName: 'Doe', phone: '876-555-0100' };
const errorsFor = async (customer: Record<string, unknown>) =>
  validate(plainToInstance(NewCustomerDto, customer), { whitelist: false });
const emailErrors = (errors: Awaited<ReturnType<typeof errorsFor>>) =>
  errors.filter((e) => e.property === 'email');

describe('online booking requires a usable email', () => {
  it('accepts a valid address', async () => {
    expect(emailErrors(await errorsFor({ ...base, email: 'jane@example.com' }))).toHaveLength(0);
  });

  it('refuses a booking with no email at all, and explains why', async () => {
    const errors = emailErrors(await errorsFor({ ...base }));
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0].constraints)).toMatch(/confirmation and your link to change or cancel/i);
  });

  it('refuses placeholder text — "N/A" is not an address', async () => {
    for (const placeholder of ['N/A', 'n/a', 'none', '-', '   ']) {
      expect(emailErrors(await errorsFor({ ...base, email: placeholder })), placeholder).not.toHaveLength(0);
    }
  });

  it('refuses a malformed address', async () => {
    for (const bad of ['jane@', 'jane.example.com', 'jane@@example.com', 'jane @example.com']) {
      expect(emailErrors(await errorsFor({ ...base, email: bad })), bad).not.toHaveLength(0);
    }
  });

  it('a placeholder could never have been stored as an address anyway', () => {
    // Belt and braces: even if a caller bypassed the DTO, the write boundary
    // turns placeholder text into "no address" rather than storing it.
    for (const placeholder of ['N/A', 'none', '-']) {
      expect(normalizeCustomerEmail(placeholder)).toBeNull();
    }
  });
});

describe('staff booking is never blocked for want of an email', () => {
  it('the staff appointment payload has no email field to require', async () => {
    const dto = plainToInstance(CreateAppointmentDto, {
      siteId: '11111111-1111-1111-1111-111111111111',
      customerId: '22222222-2222-2222-2222-222222222222',
      vehicleId: '33333333-3333-3333-3333-333333333333',
      scheduledStartAt: new Date().toISOString(),
      serviceTypeIds: ['44444444-4444-4444-4444-444444444444'],
    });
    const errors = await validate(dto);
    expect(errors.filter((e) => e.property === 'email')).toHaveLength(0);
    expect(Object.keys(dto)).not.toContain('email');
  });

  it('a customer with no address is a valid booking subject', () => {
    // The customer record simply has no address; nothing in the booking path
    // treats that as invalid input. What it changes is what gets SENT, which is
    // covered by the notification specs and shown on the review step.
    expect(normalizeCustomerEmail(undefined)).toBeUndefined();
    expect(normalizeCustomerEmail(null)).toBeNull();
  });
});
