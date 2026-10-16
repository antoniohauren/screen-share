# Screen Share — Implementation Handoff

## Goal

Build a simple live screen-broadcasting app based on the existing Streamroom project at `/home/hauren/Projects/stream`.

One person shares their screen to a server. Viewers open a public URL to watch the server-relayed stream in a minimal video theater interface.

“Relay” means live forwarding, not recording or replaying past broadcasts.

## Requested changes

1. Remove microphone support completely.
2. Replace the Discord-inspired interface with a simple video theater layout.
3. Replace presenter-to-viewer peer-to-peer media with server-mediated broadcasting.
4. Provide a public watch URL for each broadcast.
5. Retain the existing networking and deployment approach where compatible with server-mediated media.

## Confirmed requirements

- Maximum end-to-end live delay: **500 ms**, measured from source display to viewer display under supported deployment/network conditions. Validate this with 10 viewers; do not assume WebRTC alone guarantees it on arbitrary networks.
- Maximum audience: **10 concurrent viewers**, plus one presenter.
- No scheduled expiration or idle timeout: a broadcast ends only when its presenter explicitly stops it.
- Retain the existing lightweight Windows launcher (approximately 3 MB, as reported by the user). It opens the presenter app in Edge/Chrome app mode; capture remains browser-based.
- Keep the presenter interface to **Play/Stop and preview**, with a minimal copyable public watch URL.

## Product scope

### Presenter

- Create a broadcast and receive a public watch link.
- Select an entire screen, window, or browser tab using the browser capture picker.
- Default to 1080p capture targeting 30 FPS; allow adaptive quality reduction to meet latency requirements. Keep quality configuration out of the main UI.
- Include window/tab audio when supported and selected in the capture picker.
- See a muted local preview and minimal status when needed.
- Copy the public watch link.
- Stop sharing through the app or browser capture controls.
- Publish a single media stream to the media server, regardless of viewer count.

### Viewer

- Open the public watch URL without an account, display name, or room-code form.
- Watch the live broadcast in a video-first theater layout.
- Use play/unmute, volume, and fullscreen controls.
- See clear waiting, connecting, live, ended, and connection-error states.
- Join an already-running broadcast and receive its current live media.

### Explicitly out of scope

- Microphone capture, permissions, mixing, controls, and commentary.
- Chat, member lists, avatars, channel navigation, and Discord-style sidebars.
- Recording, playback history, seeking, or on-demand video.
- Multiple simultaneous presenters within one broadcast.
- Accounts, file transfers, and moderation tools.

## Interface

Use a dark, responsive page dominated by one video element. Preserve the video's aspect ratio and fit it within the viewport. Avoid dashboard panels and decorative navigation.

**Presenter page:** video preview and one Play/Stop toggle. Play opens the capture picker and starts publishing; Stop ends the broadcast. Show a small copyable watch URL once created. No quality selector or additional settings panels.

**Public watch page:** video, minimal playback controls, fullscreen, and a small status message when media is unavailable. Keep publishing controls off this page.

The local preview stays muted. Viewers must be able to explicitly enable audio when browser autoplay rules block it. Capture without an audio track must still work and show an accurate status.

## Media and networking architecture

### Existing architecture

Streamroom uses a Rust/Axum HTTP and WebSocket server for room coordination, signaling, and chat. Browsers exchange WebRTC media directly, or through TURN. The presenter establishes a separate media connection for each viewer.

### Target architecture

```text
Presenter browser
  └─ WebRTC upload ──> Media server / SFU
                        ├─ WebRTC delivery ──> Viewer browser
                        ├─ WebRTC delivery ──> Viewer browser
                        └─ WebRTC delivery ──> Viewer browser

Rust/Axum application server
  └─ HTTPS pages + broadcast lifecycle + authorization + signaling

Public watch URL ──> Viewer page ──> Subscribe to broadcast
```

Use a server-side WebRTC media relay, such as an SFU, to preserve low-latency delivery and existing browser capture behavior. Select the specific media-server implementation before coding the integration; this document does not prescribe a vendor or library.

Choose an SFU with direct packet forwarding, avoiding transcoding and segment-based delivery. Minimize buffering, place the media server near the users, and tune capture/encoding and congestion handling for the 500 ms end-to-end requirement. Measure actual source-to-viewer delay, not just network round-trip time.

The public URL is a browser watch page, not a raw media-file URL. HLS delivery is not required for this version.

### Preserve

- Rust/Axum application server and embedded web assets where practical.
- HTTPS for public access and secure browser capture.
- WebSocket signaling, adapting its messages to the media-server integration.
- STUN and optional TURN connectivity, including temporary TURN credentials where supported by the chosen integration.
- Docker Compose deployment and Caddy reverse proxy.
- Existing AWS deployment approach, updated for the media server.
- Edge/Chrome browser capture support.
- Existing lightweight Windows app-mode launcher, opening the presenter UI. Keep the media server on the hosting infrastructure rather than bundling it into the launcher.

### Change

- All broadcast media must pass through the media server. Viewers must never receive a direct presenter media connection.
- The presenter creates one upstream publishing connection. The server fans out media to subscribers.
- TURN remains a connectivity fallback; TURN alone does not implement one-upload broadcast fan-out.
- Add the media service, its public-address configuration, and required media ports to deployment configuration. HTTP reverse proxying alone is insufficient for WebRTC media transport.
- Replace peer-to-peer room membership and offer distribution with publish/subscribe lifecycle management.
- Replace the eight-person room limit with a server-enforced maximum of 10 concurrent viewers per broadcast, excluding the presenter. Additional viewers see a clear capacity message; release slots on disconnect.
- WebRTC transport encryption terminates at the media server; do not describe this architecture as presenter-to-viewer end-to-end encryption.

## Broadcast URLs and lifecycle

Suggested routes, subject to implementation conventions:

- `/` — create/start a broadcast.
- `/watch/<broadcast-id>` — public, read-only viewing page.

Creating a broadcast must give its presenter a separate publishing credential or owner session. The public watch URL must not grant permission to publish, replace the presenter, or stop the broadcast.

Only one publisher may be active per broadcast. Anyone possessing the watch URL can watch; there is no viewer login requirement. Public access does not require a public directory of broadcasts.

Lifecycle:

1. Presenter creates a broadcast and gets a watch URL.
2. Viewers opening that URL before sharing begins see a waiting state.
3. Presenter selects a source and publishes video plus optional source audio.
4. The server forwards the live media to existing and newly connected viewers.
5. Explicit Stop in the app or the browser capture controls ends the broadcast, releases media resources, and updates viewers.
6. A connection loss interrupts media but does not mark the broadcast ended. Show a reconnecting/waiting state, release stale connections, and retry publishing/subscription automatically while capture remains available. Preserve the broadcast identity and watch URL.
7. Invalid broadcast IDs show a clear unavailable state; stopped broadcasts show an ended state.

Do not automatically expire broadcasts because of elapsed time, zero viewers, or temporary disconnections. Allow the owner to resume at the same watch URL. If the browser/app closes or capture is lost, media cannot continue: require the presenter to reopen the app and explicitly reselect a source when browser permissions require it. Preserve broadcast identity and ownership across service restarts using lightweight metadata storage; no persistent media storage is required.

## Remove microphone support

- Remove the microphone checkbox and all associated text.
- Remove microphone `getUserMedia` calls and microphone permission handling.
- Remove microphone tracks, state, cleanup paths, and audio-mixing code used to combine microphone and source audio.
- Forward the selected source's audio track directly when available.
- Preserve browser hints requesting window audio and excluding system-wide audio, subject to browser support.
- Update documentation and existing tests to reflect source-audio-only behavior.

## Existing code reference

Source project: `/home/hauren/Projects/stream`.

- `src/main.rs` — HTTP/WebSocket server, room state, TLS, embedded assets, and desktop launcher.
- `web/app.js` — capture, microphone mixing, WebRTC connections, and client lifecycle.
- `web/index.html` — current interface and controls.
- `web/style.css` — current Discord-inspired styling.
- `tests/client.test.cjs` — client behavior tests.
- `compose.yaml`, `compose.turn.yaml`, `Caddyfile` — hosting and TURN configuration.
- `DEPLOY-AWS.md`, `TURN-AWS.md`, `VALIDATION.md` — deployment and verification context.

Reuse capture and lifecycle behavior where appropriate. The existing signaling-only Rust server cannot provide media fan-out without a new media-server component or substantial media-server implementation.

## Implementation sequence

1. Select a media-server implementation and define publishing/subscription signaling, credentials, and deployment ports.
2. Implement broadcast creation, presenter ownership, and public watch-page routing.
3. Replace presenter-to-viewer WebRTC connections with server publishing and viewer subscriptions.
4. Remove microphone support and preserve optional source audio.
5. Replace the interface with presenter and viewer theater pages.
6. Update deployment configuration, documentation, and relevant lifecycle tests.
7. Validate real capture, audio, late joins, and media relay across separate networks.

## Acceptance criteria

- The existing Windows launcher opens the minimal presenter page with Play/Stop, preview, and a copyable watch URL.
- A presenter can share a screen, window, or tab, defaulting to 1080p / 30 FPS with adaptive quality as needed.
- The app never requests microphone access or displays microphone controls.
- Supported source audio reaches viewers; silent capture remains valid.
- A public watch URL works in a fresh browser without account or name entry.
- Viewers see only the theater interface and playback controls.
- Up to 10 viewers receive the broadcast through the media server, including viewers joining after it starts. An eleventh viewer receives a capacity message.
- Measure source-to-viewer delay with 10 simultaneous viewers and verify it stays at or below 500 ms during steady-state playback under documented test conditions. Record network conditions, quality, and observed delay, including excursions.
- Presenter connection statistics confirm one publishing media connection as viewers are added; no presenter-to-viewer connections are created.
- The public watch URL cannot authorize publishing or stopping a broadcast.
- Stopping through either the app or the browser ends media cleanly and updates viewers.
- Temporary presenter/viewer disconnects produce understandable states, release stale media resources, and reconnect without ending the broadcast. No duration or zero-viewer timeout ends it.
- Broadcast identity and ownership survive service restarts; recovery never bypasses browser capture permissions.
- HTTPS, signaling, and actual media delivery work between separate networks; test TURN fallback where configured.
- Document server bandwidth requirements and latency results at the required 10-viewer capacity.

## Decisions still needed

- Specific media-server/SFU implementation.
- Hosting region and resources needed to satisfy the confirmed latency and audience requirements.
