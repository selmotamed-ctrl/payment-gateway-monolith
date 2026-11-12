// Preloaded by bunfig.toml before any test file. A developer's local
// merchant-back/.env points at the deployed stack; the tests start their own
// mTLS core, so the deployment URLs must not leak into them.
delete process.env.CORE_BACK_URLS;
delete process.env.CORE_BACK_URL;
delete process.env.TRUSTED_PROXY_CIDRS;
