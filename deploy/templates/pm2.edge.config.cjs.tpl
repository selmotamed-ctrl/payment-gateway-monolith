// PM2 application definitions for one edge host. A host that runs two edge
// roles (e.g. merchant + checkout on the same public box) receives both apps
// in this single file.
module.exports = {
  apps: [
    {
      name: "__APP_NAME__",
      script: "pm2-compatible-start.js",
      interpreter: "/usr/local/bin/bun",
      cwd: "__APP_DIR__",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 10000,
      env: { NODE_ENV: "production" },
    },
  ],
};
