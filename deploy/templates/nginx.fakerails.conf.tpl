# Standalone Fake Payment Rails: tester portal, hosted checkout simulator and
# the twenty emulated gateway APIs. This vhost is isolated from the gateway
# edge; the emulator owns its own SQLite store.
server {
{{#SSL}}
    listen {{LISTEN_PORT}} ssl;
    listen [::]:{{LISTEN_PORT}} ssl;
{{/SSL}}
{{^SSL}}
    listen {{LISTEN_PORT}};
    listen [::]:{{LISTEN_PORT}};
{{/SSL}}
    server_name {{SERVER_NAME}};

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
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self' *; base-uri 'self'; form-action 'self'" always;

    client_max_body_size 25m;

    root {{STATIC_ROOT}};
    index index.html;

    location /rails/ {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location /sdk/ {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Cache-Control "public, max-age=300";
    }

    location /portal-api/ {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Tester SSE stream: unbuffered, long read timeout.
    location /portal-api/transactions/stream {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        chunked_transfer_encoding on;
    }

    location /health {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}}/health;
        proxy_set_header Host $host;
    }

    # Hosted checkout simulator + widget frame are SPA routes.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
