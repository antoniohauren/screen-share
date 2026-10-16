#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v cargo >/dev/null && [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi
LIVEKIT_BIN=${LIVEKIT_BIN:-livekit-server}
if ! command -v "$LIVEKIT_BIN" >/dev/null; then
  echo 'Install LiveKit Server 1.13.10, or set LIVEKIT_BIN to its executable path.' >&2
  exit 1
fi
# Advertise an address Windows can reach, rather than a Linux-only loopback candidate.
if [[ -z "${MEDIA_IP:-}" ]]; then
  MEDIA_IP=$(node --input-type=module - <<'JS'
import { networkInterfaces } from 'node:os';
const interfaces = networkInterfaces();
const addresses = [...(interfaces.eth0 || []), ...Object.values(interfaces).flat()];
const address = addresses.find(entry => entry.family === 'IPv4' && !entry.internal);
if (!address) {
  console.error('No network IPv4 address found. Set MEDIA_IP to an address Windows can reach.');
  process.exit(1);
}
console.log(address.address);
JS
  )
fi
echo "Advertising media address: $MEDIA_IP"
export LIVEKIT_API_SECRET=devsecret-for-local-development-only
export LIVEKIT_API_KEY=devkey
export PUBLIC_ORIGIN=http://localhost:8787
export LIVEKIT_API_URL=http://localhost:7880
export LIVEKIT_PUBLIC_URL=ws://localhost:7880
export DATABASE_PATH="$PWD/broadcasts.db"
npm ci
npm run build
cargo build --locked --bin screen-share
"$LIVEKIT_BIN" --dev --bind 0.0.0.0 --node-ip "$MEDIA_IP" --keys "devkey: $LIVEKIT_API_SECRET" &
media_pid=$!
trap 'kill "$media_pid" 2>/dev/null || true' EXIT
echo 'Open http://localhost:8787 in Windows Edge/Chrome, or launch dist/ScreenShare.exe.'
target/debug/screen-share
