#!/usr/bin/env bash
# One command: sync canonical content, validate, test, build the web app,
# sync Capacitor, build and verify an APK, and copy it to release/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

MODE="release"
OFFLINE_SNAPSHOT=0
INSTALL=0
SKIP_TESTS=0

for arg in "$@"; do
    case "$arg" in
        --debug) MODE="debug" ;;
        --offline-snapshot) OFFLINE_SNAPSHOT=1 ;;
        --install) INSTALL=1 ;;
        --skip-tests) SKIP_TESTS=1 ;;
        -h|--help)
            cat <<'EOF'
Usage: ./build-apk.sh [--debug] [--offline-snapshot] [--install] [--skip-tests]

  --debug             Build a debug APK instead of a release APK.
  --offline-snapshot  Use the committed content snapshot without re-extracting.
  --install           Install with `adb install -r` after building.
  --skip-tests        Skip typecheck and tests (emergency local builds only).
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 2
            ;;
    esac
done

fail() {
    echo "build-apk: $*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

need bun
need node

for candidate in "${JAVA_HOME:-}" "$HOME/.jdks/temurin-21" /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/java-21-openjdk-amd64; do
    if [[ -n "$candidate" && -x "$candidate/bin/java" ]]; then
        CANDIDATE_MAJOR="$("$candidate/bin/java" -version 2>&1 | awk -F '"' '/version/ {print $2}' | cut -d. -f1)"
        if [[ "$CANDIDATE_MAJOR" == "21" ]]; then
            export JAVA_HOME="$candidate"
            export PATH="$JAVA_HOME/bin:$PATH"
            break
        fi
    fi
done

need java
need keytool
need openssl

JAVA_MAJOR="$(java -version 2>&1 | awk -F '"' '/version/ {print $2}' | cut -d. -f1)"
if [[ -z "${JAVA_MAJOR:-}" ]] || [[ "$JAVA_MAJOR" -lt 21 ]]; then
    fail "JDK 21 or newer is required (found ${JAVA_MAJOR:-unknown}). Install Temurin 21 and set JAVA_HOME."
fi

export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
[[ -d "$ANDROID_HOME/platforms/android-36" ]] || fail "Android SDK platform 36 is missing under $ANDROID_HOME"
[[ -d "$ANDROID_HOME/build-tools" ]] || fail "Android build-tools are missing under $ANDROID_HOME"

if [[ "$OFFLINE_SNAPSHOT" -eq 0 ]]; then
    echo "==> extracting canonical guide and academy content"
    bun run content:sync
else
    echo "==> using committed content snapshot"
fi
bun run content:check

if [[ ! -d node_modules ]]; then
    echo "==> installing dependencies"
    bun install --frozen-lockfile
fi

if [[ "$SKIP_TESTS" -eq 0 ]]; then
    echo "==> typecheck and tests"
    bun run typecheck
    bun test
fi

echo "==> building the web app"
bun run build

echo "==> syncing Capacitor Android project"
node ./node_modules/@capacitor/cli/bin/capacitor sync android >/dev/null

if [[ "$MODE" == "release" && -z "${CI:-}" ]]; then
    if [[ -z "${COMPANION_KEYSTORE_FILE:-}" ]]; then
        bash scripts/ensure-keystore.sh
    fi
fi

if [[ -f .keys/keystore.env && -z "${COMPANION_KEYSTORE_FILE:-}" ]]; then
    # shellcheck disable=SC1091
    source .keys/keystore.env
fi

VERSION_CODE="${COMPANION_VERSION_CODE:-$(git -C .. rev-list --count HEAD 2>/dev/null || date +%s)}"
VERSION_NAME="${COMPANION_VERSION_NAME:-1.0.${VERSION_CODE}}"
CONTENT_HASH="$(node -e "const m=require('./public/content/manifest.json'); process.stdout.write(m.contentHash.slice(0,7))")"

GRADLE_ARGS=(-PCOMPANION_VERSION_CODE="$VERSION_CODE" -PCOMPANION_VERSION_NAME="$VERSION_NAME")
if [[ "$MODE" == "release" && -n "${COMPANION_KEYSTORE_FILE:-}" ]]; then
    GRADLE_ARGS+=(
        -PCOMPANION_KEYSTORE_FILE="$COMPANION_KEYSTORE_FILE"
        -PCOMPANION_KEYSTORE_PASSWORD="$COMPANION_KEYSTORE_PASSWORD"
        -PCOMPANION_KEY_ALIAS="$COMPANION_KEY_ALIAS"
        -PCOMPANION_KEY_PASSWORD="$COMPANION_KEY_PASSWORD"
    )
    GRADLE_TASK="assembleRelease"
    APK_DIR="$ROOT/android/app/build/outputs/apk/release"
    APK_SOURCE="$APK_DIR/app-release.apk"
    BUILD_KIND="release"
else
    GRADLE_TASK="assembleDebug"
    APK_DIR="$ROOT/android/app/build/outputs/apk/debug"
    APK_SOURCE="$APK_DIR/app-debug.apk"
    BUILD_KIND="debug"
    if [[ "$MODE" == "release" ]]; then
        echo "==> no release signing keys available; building a debug APK" >&2
    fi
fi

echo "==> building $BUILD_KIND APK (version $VERSION_NAME / $VERSION_CODE)"
chmod +x android/gradlew
(
    cd android
    ./gradlew "$GRADLE_TASK" --no-daemon "${GRADLE_ARGS[@]}"
)

[[ -f "$APK_SOURCE" ]] || fail "expected APK not found at $APK_SOURCE"

APKSIGNER="$ANDROID_HOME/build-tools/36.0.0/apksigner"
if [[ ! -x "$APKSIGNER" ]]; then
    APKSIGNER="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -name apksigner -type f | sort -V | tail -1)"
fi
[[ -x "$APKSIGNER" ]] || fail "apksigner not found under $ANDROID_HOME/build-tools"
"$APKSIGNER" verify --print-certs "$APK_SOURCE" >/dev/null || fail "APK signature verification failed"

mkdir -p release
APK_NAME="PG-Companion-${VERSION_NAME}-${CONTENT_HASH}-${BUILD_KIND}.apk"
cp "$APK_SOURCE" "release/$APK_NAME"
(
    cd release
    sha256sum "$APK_NAME" > SHA256SUMS
)

node - "$APK_NAME" "$VERSION_CODE" "$VERSION_NAME" "$BUILD_KIND" <<'NODE'
const fs = require("node:fs");
const manifest = require("./public/content/manifest.json");
const [apkName, versionCode, versionName, buildKind] = process.argv.slice(2);
const apkPath = `release/${apkName}`;
const info = {
  apk: apkName,
  apkSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex"),
  apkBytes: fs.statSync(apkPath).size,
  versionCode: Number(versionCode),
  versionName,
  buildKind,
  appId: manifest.appId,
  contentVersion: manifest.contentVersion,
  contentHash: manifest.contentHash,
  bundleSha256: manifest.bundleSha256,
  builtAt: new Date().toISOString(),
};
fs.writeFileSync("release/build-info.json", `${JSON.stringify(info, null, 2)}\n`);
NODE

if [[ "$INSTALL" -eq 1 ]]; then
    need adb
    echo "==> installing on the connected device"
    adb install -r "release/$APK_NAME"
fi

printf '\nAPK: %s\n' "$ROOT/release/$APK_NAME"
printf 'SHA-256: %s\n' "$(cut -d' ' -f1 release/SHA256SUMS)"
printf 'Content: %s (%s)\n' "$(node -e "process.stdout.write(require('./public/content/manifest.json').contentVersion)")" "$CONTENT_HASH"
if [[ "$BUILD_KIND" == "debug" ]]; then
    printf 'NOTE: this is a debug-signed APK. Set release signing keys for a release APK.\n'
fi
