# Public merchant portal + merchant server API.
server {
    listen 80;
    listen [::]:80;
    server_name {{SERVER_NAME}};

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }

    location / {
        return 308 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name {{SERVER_NAME}};

    ssl_certificate     {{SSL_CERT_PATH}};
    ssl_certificate_key {{SSL_KEY_PATH}};
    ssl_protocols TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_stapling on;
    ssl_stapling_verify on;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
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
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Request-Id $request_id;
        proxy_read_timeout 60s;
    }

    # POS realtime room: unbuffered SSE, long read timeout.
    location ~ ^/api/v1/merchant/pos/screens/[^/]+/stream$ {
        proxy_pass http://127.0.0.1:{{BACKEND_PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Real-Client-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
