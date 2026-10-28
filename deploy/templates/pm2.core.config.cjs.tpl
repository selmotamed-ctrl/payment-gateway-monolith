// PM2 application definition for the core engine.
// Rendered by deploy/deploy.ts; the real file lives in
// <CORE_REMOTE_DIR>/shared/pm2/pg-core-back.config.cjs.
module.exports = {
  apps: [
    {
      name: "pg-core-back",
      script: "pm2-compatible-start.js",
      interpreter: "/usr/local/bin/bun",
      cwd: "__APP_DIR__",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 15000,
      env: { NODE_ENV: "production" },
    },
  ],
};
