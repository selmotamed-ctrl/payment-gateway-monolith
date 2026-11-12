// Preloaded by bunfig.toml before any test file. See the note there.
process.env.ADMIN_RATE_LIMIT_MAX ??= "1000000";

// A developer's local admin-back/.env points at the deployed stack. The tests
// start their own mTLS core, so the deployment URLs must not leak into them.
delete process.env.CORE_BACK_URLS;
delete process.env.CORE_BACK_URL;

import { afterAll } from "bun:test";

// A file that sets CORE_BACK_URLS leaves it in process.env; there is one module graph per
// test run, so the next file would talk to this file's closed test core. Clear it per file.
afterAll(() => {
  delete process.env.CORE_BACK_URLS;
});
