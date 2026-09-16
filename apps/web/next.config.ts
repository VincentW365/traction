import type { NextConfig } from 'next';

// Deployment-parity audit (2026-09) — NEXT_PUBLIC_API_URL/WS_URL are baked at
// build time. A production build without them falls back to deriving the API from
// the page's own host (the LAN behaviour), which is wrong on split-host platforms
// like Render. Warn loudly at build rather than fail: the documented Render
// bootstrap intentionally builds once BEFORE these URLs exist, then redeploys.
// CR-2026-106 — on Render (split hosts) a build without the API URL produces public
// pages that call the wrong host; that is a hard failure there, a warning elsewhere.
if (process.env.RENDER && process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('[bsop-web build] NEXT_PUBLIC_API_URL is not set. On Render the public pages (status, booking) would call the wrong host. Set NEXT_PUBLIC_API_URL (and NEXT_PUBLIC_WS_URL) on bsop-web and rebuild.');
}
if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  console.warn(
    '\n[bsop-web build] WARNING: NEXT_PUBLIC_API_URL is not set. The browser will ' +
      'guess the API location from its own host. Fine for a first bootstrap build or ' +
      'a same-host/LAN deployment; on Render set NEXT_PUBLIC_API_URL and ' +
      'NEXT_PUBLIC_WS_URL, then rebuild (see DEPLOY_RENDER.md).\n',
  );
}

const config: NextConfig = {
  transpilePackages: ['@bsop/types', '@bsop/ui'],
  env: {
    // CR-2026-094 — the build carries its own identity. Render injects
    // RENDER_GIT_COMMIT at build time; BUILD_COMMIT is the generic override for any
    // other host. Inlined here because NEXT_PUBLIC_* values are baked at build, which
    // is exactly right: the stamp names the commit that was BUILT, not whatever the
    // server happens to have checked out later.
    NEXT_PUBLIC_BUILD_COMMIT:
      process.env.RENDER_GIT_COMMIT ?? process.env.BUILD_COMMIT ?? '',
  },
};

export default config;
