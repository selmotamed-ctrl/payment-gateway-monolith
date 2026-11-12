#!/usr/bin/env bash
#
# Install npm dependencies for every workspace project with `bun install`.
#
#   ./scripts/install-packages.sh
#   ./scripts/install-packages.sh --frozen-lockfile
#   ./scripts/install-packages.sh --project core-back --project admin-front
#   ./scripts/install-packages.sh -- --verbose
#
# Options:
#   -p, --project <name>   Only install the named project (repeatable).
#   -f, --frozen-lockfile  Fail if the lockfile would change.
#       --production       Skip devDependencies.
#   -k, --keep-going       Continue after a failed project; exit non-zero at the end.
#   -n, --dry-run          Print the commands without running them.
#   -h, --help             Show this help.
#
# Arguments after `--` are forwarded to every `bun install` invocation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROJECTS=(
  core-back
  deploy
  deploy/backup-daemon
  deploy/object-storage-daemon
  admin-back
  merchant-back
  checkout-back
  fake-rails-back
  admin-front
  merchant-front
  checkout-front
  fake-rails-front
  tests
)

SELECTED=()
BUN_ARGS=()
KEEP_GOING=0
DRY_RUN=0

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--project)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      SELECTED+=("$2")
      shift 2
      ;;
    -f|--frozen-lockfile)
      BUN_ARGS+=(--frozen-lockfile)
      shift
      ;;
    --production)
      BUN_ARGS+=(--production)
      shift
      ;;
    -k|--keep-going)
      KEEP_GOING=1
      shift
      ;;
    -n|--dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      BUN_ARGS+=("$@")
      break
      ;;
    *)
      echo "Unknown option: $1 (use --help)" >&2
      exit 2
      ;;
  esac
done

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed or not on PATH." >&2
  exit 1
fi

targets=("${PROJECTS[@]}")
if [[ ${#SELECTED[@]} -gt 0 ]]; then
  targets=("${SELECTED[@]}")
fi

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }

failed=()
installed=0
for project in "${targets[@]}"; do
  directory="$ROOT/$project"
  if [[ ! -f "$directory/package.json" ]]; then
    echo "skip: $project has no package.json" >&2
    continue
  fi

  step "$project"
  command=(bun install "${BUN_ARGS[@]}")
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ (cd %q &&' "$directory"
    printf ' %q' "${command[@]}"
    printf ')\n'
    continue
  fi

  if (cd "$directory" && "${command[@]}"); then
    installed=$((installed + 1))
  else
    failed+=("$project")
    if [[ "$KEEP_GOING" != "1" ]]; then
      echo "bun install failed in $project; stopping." >&2
      exit 1
    fi
  fi
done

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "Dry run: ${#targets[@]} project(s) selected."
  exit 0
fi

echo
if [[ ${#failed[@]} -gt 0 ]]; then
  printf 'bun install failed in %d project(s): %s\n' "${#failed[@]}" "${failed[*]}" >&2
  exit 1
fi
echo "Installed dependencies in $installed project(s)."
