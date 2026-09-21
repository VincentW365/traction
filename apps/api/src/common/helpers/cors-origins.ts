/**
 * CR-2026-110 §5 — the browser origins allowed to call this API with credentials.
 *
 * The rule this enforces, and why it is a hard failure rather than a warning:
 * the API sends `Access-Control-Allow-Credentials: true`. Pairing that with a
 * wildcard origin is the configuration the directive names explicitly — "no
 * wildcard credentialed CORS" — and it is precisely what someone reaches for
 * when a public page cannot talk to the API. Browsers reject `*` with
 * credentials outright, so the "fix" does not even work; what it does is invite
 * the next step, reflecting whatever Origin arrives, which hands every website a
 * logged-in user visits the ability to call this API as them.
 *
 * Refusing to boot is deliberate. A server that starts with an unusable or
 * dangerous CORS policy fails later, in a browser, as a symptom nobody connects
 * back to this setting.
 *
 * Pure functions over an injected value so they are unit-testable.
 */

export class InvalidCorsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCorsConfigurationError';
  }
}

const WILDCARDS = new Set(['*', 'null', 'true', 'all', 'any']);

export interface CorsAssessment {
  ok: boolean;
  origins: string[];
  reason: string;
}

/** Split, trim and drop empties. Accepts one origin or a comma-separated list. */
export function parseCorsOrigins(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Is this list safe to serve with `credentials: true`?
 *
 * `production` tightens it: a customer-facing deployment must name https origins
 * a browser on the public internet can actually reach. In development,
 * http://localhost is exactly right and is left alone.
 */
export function assessCorsOrigins(raw: string | null | undefined, production: boolean): CorsAssessment {
  const origins = parseCorsOrigins(raw);

  if (origins.length === 0) {
    return { ok: false, origins, reason: 'API_CORS_ORIGIN is not set — no browser origin is allowed to call this API' };
  }

  const wildcard = origins.find((o) => WILDCARDS.has(o.toLowerCase()));
  if (wildcard) {
    return {
      ok: false,
      origins,
      reason:
        `API_CORS_ORIGIN contains "${wildcard}". This API sends credentials, and a wildcard origin with credentials is ` +
        'both rejected by browsers and unsafe. List the exact web origin(s) instead, comma-separated — ' +
        'for example https://service.bertsautoparts.com',
    };
  }

  for (const o of origins) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      return { ok: false, origins, reason: `API_CORS_ORIGIN entry "${o}" is not an absolute origin (include the scheme, e.g. https://…)` };
    }
    if (u.pathname !== '/' && u.pathname !== '') {
      return { ok: false, origins, reason: `API_CORS_ORIGIN entry "${o}" must be a bare origin — no path` };
    }
    if (production && u.protocol !== 'https:') {
      return { ok: false, origins, reason: `API_CORS_ORIGIN entry "${o}" must be https:// in production` };
    }
  }

  return { ok: true, origins, reason: `${origins.length} origin(s) allowed` };
}

/**
 * The value to hand to `enableCors`, or a thrown error explaining exactly what
 * is wrong with the configuration.
 */
export function resolveCorsOrigins(raw: string | null | undefined, production: boolean): string | string[] {
  const assessment = assessCorsOrigins(raw, production);
  if (!assessment.ok) throw new InvalidCorsConfigurationError(assessment.reason);
  return assessment.origins.length === 1 ? assessment.origins[0] : assessment.origins;
}
