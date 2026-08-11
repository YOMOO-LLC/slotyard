// A reference layout used by the test suite, and the worked example the README
// points at. It is NOT registered as a built-in: layouts come from the repo
// itself (.slotyard.json, or inference from supabase's config.toml).
//
// Keeping zero built-ins is deliberate. A built-in layout hard-codes one
// project's naming into the tool, and every other project then looks like a
// special case.
import { makeLayout } from './make.ts';
import type { Layout } from './types.ts';

export const exampleLayout: Layout = makeLayout({
  name: 'example-app',
  prefix: 'example-app',
  configPath: 'apps/web/supabase/config.toml',
  // Order here is the port-lookup order. api..pop3 come from supabase itself;
  // web and metro are the app's own ports, which supabase knows nothing about.
  ports: {
    api: 54321, db: 54322, studio: 54323, inbucket: 54324, smtp: 54325, pop3: 54326,
    web: 3100, metro: 8081,
  },
  maxSlot: 19,
});
