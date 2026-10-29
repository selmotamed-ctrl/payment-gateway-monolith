# LAN-only admin back office.
# Bound to the private interface; there is no public virtual host and no router
# port-forward for this listener. TLS is optional (ADMIN_SSL).
server {
{{#SSL}}
    listen {{LISTEN_PORT}} ssl;
{{/SSL}}
{{^SSL}}
    listen {{LISTEN_PORT}};
{{/SSL}}
    server_name {{SERVER_NAME}};

    # The nginx allowlist is the outer ring; admin-back enforces
    # ADMIN_LAN_CIDRS again on every request (defence in depth).
{{LAN_ALLOW_RULES}}

{{#SSL}}
    ssl_certificate     {{SSL_CERT_PATH}};
    ssl_certificate_key {{SSL_KEY_PATH}};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
{{/SSL}}
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;

    client_max_body_size 25m;

    root {{STATIC_ROOT}};
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Real-Client-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
        proxy_read_timeout 60s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
