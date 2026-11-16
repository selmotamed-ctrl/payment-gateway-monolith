// Preloaded by bunfig.toml before any test file. See the note there.
process.env.ADMIN_RATE_LIMIT_MAX ??= "1000000";

import { afterAll } from "bun:test";

// A file that sets CORE_BACK_URLS leaves it in process.env; there is one module graph per
// test run, so the next file would talk to this file's closed test core. Clear it per file.
afterAll(() => {
  delete process.env.CORE_BACK_URLS;
});
