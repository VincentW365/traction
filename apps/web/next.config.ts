import type { NextConfig } from 'next';

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
