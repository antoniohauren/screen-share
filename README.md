# Screen Share

Rust/Axum + LiveKit screen broadcasting, with a small Windows Edge/Chrome app-mode launcher. One browser publishes screen video and optional **selected-source audio** to the SFU; up to ten viewers watch a public URL. No microphone capture, accounts, chat, recording, or peer-to-peer viewer connections.

## Windows test from WSL

Requirements: Rust stable, Node 22+, and LiveKit Server 1.13.10 (or Docker Desktop with WSL integration).

With a downloaded LiveKit binary, the one-command WSL path is:

```sh
LIVEKIT_BIN=/path/to/livekit-server bash scripts/dev.sh
```

Then launch `dist/ScreenShare.exe` from Windows (if already built), or open `http://localhost:8787`. Set `MEDIA_IP` if the automatically selected WSL IPv4 is not reachable from Windows. The script keeps metadata in `broadcasts.db`.

Alternatively, start the components separately:

1. Start the SFU in WSL:

   ```sh
   MEDIA_IP=YOUR_DOCKER_HOST_IPV4 docker compose -f compose.dev.yaml up -d
   ```

   Or run the [Linux LiveKit release](https://github.com/livekit/livekit/releases/tag/v1.13.10) directly:

   ```sh
   livekit-server --dev --bind 0.0.0.0 --node-ip YOUR_WSL_IPV4 \
     --keys 'devkey: devsecret-for-local-development-only'
   ```

   The dev script detects the WSL IPv4 using Node (preferring `eth0`). Windows must reach the advertised media address. Use a real interface IPv4, not loopback, for media ICE candidates. For Docker Desktop use the Windows Docker host's reachable IPv4; for the standalone WSL binary use the WSL IPv4. Permit the media ports in Windows Firewall if needed.

2. Build and start the Rust app in WSL:

   ```sh
   npm ci
   npm run build
   export LIVEKIT_API_SECRET=devsecret-for-local-development-only
   cargo run --locked --bin screen-share
   ```

3. Open **http://localhost:8787** in Windows Edge/Chrome. Press Play, select a screen/window/tab, and select source audio in the picker when supported. Copy the link into another browser. Local preview is always muted; viewers use Play / enable audio or native video controls.

Localhost is a browser secure context. A public/LAN-IP HTTP URL is not suitable for capture; use HTTPS deployment for separate-network tests.

### Build the Windows launcher

In Windows PowerShell, with Rust and Visual Studio C++ build tools installed:

```powershell
.\build.ps1 -Url https://share.example.com
.\dist\ScreenShare.exe
```

For local testing omit `-Url`. The launcher has no server/media dependencies: `--no-default-features` builds only the standard-library browser opener. It searches the same Edge/Chrome install locations as Streamroom. You can also pass a URL as its first argument or set `SCREEN_SHARE_URL` at runtime. The roughly 3 MB budget must be checked on the Windows release build; it is not bundled with LiveKit or a webview.

## Behavior and ownership

- Opening `/` creates a persistent broadcast and saves a separate random owner credential in that browser's local storage. The database stores only its SHA-256 hash. Keep the browser profile and the database to retain ownership; clearing site data creates a new broadcast.
- `/watch/<id>` is read-only. Its URL never contains the owner credential. Viewer JWTs explicitly cannot publish or send data. Publisher JWTs can publish only screen-share video/audio, never microphone or camera sources.
- Play requests browser capture (1080p/30 FPS target) and creates one upstream publishing media connection. VP8 simulcast provides adaptive layers on that same connection; LiveKit forwards packets without transcoding.
- Stop, including the browser's capture Stop, persists `ended` and deletes the media room. Play resumes the same public URL with a fresh internal room generation. Viewers on the ended page automatically reconnect when it resumes.
- Transport loss does not end the broadcast. The SDK reconnects media and the app reconnects control, obtaining fresh credentials as necessary. Capture is preserved while available. Closing the browser does not persist Stop; reopening requires Play and a new capture selection.
- An explicit Stop during a network outage is remembered in local storage and retried on reconnection/reopen. Until the server is reachable, viewers see interrupted media rather than a confirmed ended state.
- A 35-second control heartbeat deadline releases stale connections, **not broadcasts**. There is no elapsed-time or zero-viewer expiration. Empty SFU rooms may be reclaimed and recreated; durable broadcast metadata remains.
- Ten bounded viewer identities plus one presenter identity are enforced by the Rust lease allocator and LiveKit's unique-identity admission. The eleventh viewer sees a capacity message and retries. A second presenter window cannot acquire an active owner lease.
- LiveKit self-hosted JWTs cannot be immediately revoked. Tokens initially last 60 seconds; the SDK may refresh them. Bounded identities prevent token reuse from adding extra participants, but reuse can displace that same identity. Stopped room generations are never reused and durable cleanup retries delete stopped rooms. Credentials must not be shared or logged.

This is a single application-server deployment: SQLite and the in-memory lease allocator are not a multi-replica coordination system. WebRTC encryption terminates at LiveKit.

## Checks

```sh
npm test
npm run build
cargo test --locked
cargo build --locked
npm run test:server
# Optional real-SFU browser integration test (uses ports 8787, 7880–7882):
npx playwright install chromium
LIVEKIT_BIN=/path/to/livekit-server npx playwright test
```

The browser test supplies synthetic canvas/source audio to the actual browser publisher and real SFU. Windows picker behavior, separate-network connectivity, TURN, and ≤500 ms display latency still require [VALIDATION.md](VALIDATION.md).

See [DEPLOY-AWS.md](DEPLOY-AWS.md) for HTTPS, media ports, TURN, sizing, and deployment.
