/**
 * Public TLS renewal on the edge hosts (AUTO-28).
 *
 * In `certbot` mode the deploy used to check that a certificate existed and print the issue command; nothing renewed it
 * afterwards, so every certificate expired after ~90 days unless somebody ran `certbot renew`. The deploy now installs
 *
 *  - a certbot DEPLOY HOOK that validates the Nginx configuration and reloads Nginx (certbot runs every script in
 *    `renewal-hooks/deploy/` after a successful renewal, so the new certificate is served without a restart);
 *  - a systemd timer that runs `certbot renew` twice a day with a random delay (certbot only renews a certificate that
 *    is within 30 days of expiry, so the frequent run is cheap), `Persistent=true` so a host that was down catches up.
 *
 * Everything here is pure: the caller writes the files with `SshRunner.writeRemoteFile`.
 */

export const CERTBOT_DEPLOY_HOOK_PATH = "/etc/letsencrypt/renewal-hooks/deploy/pg-reload-nginx.sh";
export const CERTBOT_SERVICE_PATH = "/etc/systemd/system/pg-certbot-renew.service";
export const CERTBOT_TIMER_PATH = "/etc/systemd/system/pg-certbot-renew.timer";
export const CERTBOT_TIMER_UNIT = "pg-certbot-renew.timer";

export const certbotDeployHook = (): string =>
  `#!/bin/sh
# Installed by the payment gateway deploy (AUTO-28): serve a renewed certificate without a restart.
# Never reload a configuration Nginx rejects: a failed test leaves the running (old) certificate in place.
set -eu
nginx -t
if command -v systemctl >/dev/null 2>&1; then systemctl reload nginx; else nginx -s reload; fi
`;

export const certbotRenewalService = (): string =>
  `[Unit]
Description=Renew Let's Encrypt certificates (payment gateway deploy)
Documentation=man:certbot(1)

[Service]
Type=oneshot
ExecStart=/usr/bin/env certbot renew --quiet
`;

export const certbotRenewalTimer = (): string =>
  `[Unit]
Description=Twice-daily Let's Encrypt renewal (payment gateway deploy)

[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
`;

/**
 * Enables the timer. Prints a clear warning (and succeeds) on a host without certbot or systemd, because the deploy
 * must not fail on a host whose certificates the operator manages another way.
 */
export const certbotRenewalEnableScript = (): string =>
  `if ! command -v certbot >/dev/null 2>&1; then
  echo "!! certbot is not installed on this host: certificate renewal is NOT scheduled (install certbot, then deploy again)"
elif ! command -v systemctl >/dev/null 2>&1; then
  echo "!! systemd is not available on this host: certificate renewal is NOT scheduled (run 'certbot renew' from cron)"
else
  systemctl daemon-reload
  systemctl enable --now ${CERTBOT_TIMER_UNIT}
fi`;
