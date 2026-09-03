#!/usr/bin/env bash
# Always starts Expo with Node 20 — use this instead of: npx expo start
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.nvm/versions/node/v20.19.5/bin:$PATH"
echo "Using Node $(node -v)"
exec npx expo start --tunnel "$@"
