# Checkout payer page + checkout API.
{{#SSL}}
server {
    listen {{HTTP_PORT}};
    listen [::]:{{HTTP_PORT}};
    server_name {{SERVER_NAME}};

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        return 308 https://$host$request_uri;
    }
}

{{/SSL}}
server {
{{#SSL}}
    listen {{HTTPS_PORT}} ssl;
    listen [::]:{{HTTPS_PORT}} ssl;
    http2 on;
{{/SSL}}
{{^SSL}}
    listen {{HTTP_PORT}};
    listen [::]:{{HTTP_PORT}};
{{/SSL}}
    server_name {{SERVER_NAME}};

{{#SSL}}
    ssl_certificate     {{SSL_CERT_PATH}};
    ssl_certificate_key {{SSL_KEY_PATH}};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_stapling on;
    ssl_stapling_verify on;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
{{/SSL}}
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;

    client_max_body_size 10m;

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

    # Payer status SSE stream: unbuffered, long read timeout.
    location ~ ^/api/v1/pay/[^/]+/logs/[^/]+/status$ {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Real-Client-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
