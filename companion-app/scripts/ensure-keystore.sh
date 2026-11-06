#!/usr/bin/env bash
# Create a local release keystore on first use. The password is generated and
# stored only in companion-app/.keys/keystore.env (mode 0600, gitignored).
# BACK THIS DIRECTORY UP. Losing it prevents in-place APK updates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_DIR="$ROOT/.keys"
KEYSTORE="$KEY_DIR/companion-release.jks"
ENV_FILE="$KEY_DIR/keystore.env"

if [[ -f "$KEYSTORE" && -f "$ENV_FILE" ]]; then
    exit 0
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

PASSWORD="$(openssl rand -hex 24)"
keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -alias pg-companion \
    -keyalg RSA \
    -keysize 4096 \
    -validity 10000 \
    -storepass "$PASSWORD" \
    -keypass "$PASSWORD" \
    -dname "CN=PG Companion, OU=Payment Gateway, O=Payment Gateway, L=Tripoli, C=LY" \
    >/dev/null 2>&1

cat >"$ENV_FILE" <<EOF
COMPANION_KEYSTORE_FILE=$KEYSTORE
COMPANION_KEYSTORE_PASSWORD=$PASSWORD
COMPANION_KEY_ALIAS=pg-companion
COMPANION_KEY_PASSWORD=$PASSWORD
EOF
chmod 600 "$ENV_FILE" "$KEYSTORE"

printf 'Created local release keystore: %s\n' "$KEYSTORE"
printf 'BACK UP %s NOW. Without it, future APKs cannot update this install in place.\n' "$KEY_DIR"
