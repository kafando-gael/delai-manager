#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE20=""

# Prefer an installed Node 20 binary (fast, no nvm hang)
for candidate in \
  "$HOME/.nvm/versions/node/v20.19.5/bin" \
  "$HOME/.nvm/versions/node/v20.19.2/bin" \
  $(ls -d "$HOME/.nvm/versions/node"/v20.*/bin 2>/dev/null | sort -V | tail -1); do
  if [[ -n "$candidate" && -x "$candidate/node" ]]; then
    NODE20="$candidate"
    break
  fi
done

if [[ -z "$NODE20" ]]; then
  echo "Node 20 introuvable dans ~/.nvm/versions/node/"
  echo "Installe-le: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 20"
  exit 1
fi

export PATH="$NODE20:$PATH"
echo "Using Node $(node -v)"
exec "$@"
