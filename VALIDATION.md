# Validation record

## Status

**The ≤500 ms source-display-to-viewer-display requirement is not yet validated.** Local synthetic media tests cannot certify real Windows capture, separate-network operation, or display latency. Record real observations below; do not replace display timing with WebRTC RTT.

### Development checks (2026-10-15, WSL)

- Rust unit tests: passed (capacity, restricted grants, durable ownership/state).
- HTTP/WebSocket integration: passed (wrong-origin rejection, owner authorization, viewer cannot start/stop, disconnect does not end, restart preserves identity/ownership/ended state, resume advances internal generation).
- Source-capture unit checks, web bundle build, and Clippy with warnings denied: passed.
- Windows MSVC release launcher built through PowerShell from WSL: **217,600 bytes**. Interactive Edge/Chrome launch and real capture remain to be tested on Windows.
- Docker Compose/Caddy deployment and TURN: not executed in this WSL environment.
- Real LiveKit 1.13.10 + Chromium 141 synthetic-media browser test: passed with ten viewer contexts, late joins, eleventh-viewer capacity rejection/slot release, one presenter media-bearing upstream connection, source audio/unmute, silent capture, control disconnect/republication without recapture, Stop/resume at the same URL, and capture-track-ended handling. This used one WSL host and a 640×360/30 FPS canvas plus generated source audio; it is **not** the 1080p/ten-machine latency acceptance test.

## Windows functional pass

- Build launcher using `build.ps1`; record executable size, Windows version, browser version and capture support.
- Launch: only preview, Play/Stop, status and copyable watch URL. Viewer has video playback/volume/fullscreen controls, no publisher controls.
- Check whole screen, individual window and browser tab. Select audio when offered. Confirm source audio only, no microphone permission prompt, and silent captures show “no source audio”. Windows/browser versions differ in window-audio support.
- Open a fresh/incognito browser with only the public link before publishing: waiting. Start: live. Late join: current live video, never historical content.
- Ten separate viewer sessions: all receive video/audio. Eleventh: capacity. Close a viewer: replacement joins; abrupt network loss releases its slot within the control heartbeat deadline plus SFU cleanup time.
- App Stop and browser capture Stop: all viewers ended, capture indicator disappears. Play again: same URL, new capture picker, viewers resume.
- Interrupt presenter/viewer networking, then restore. Media retries without ending the broadcast; presenter capture persists. Restart Rust and LiveKit independently. Same URL/owner survive; capture can republish without a new picker only while the original tracks still exist.
- Close/reopen presenter browser: same saved URL, Play reselects source; no automatic capture. Stop while offline, then reconnect/reopen: pending Stop reaches server.
- Inspect JWTs in development: viewer cannot publish/administer; public ID as owner credential is rejected. Open second presenter window: busy. Test attempts to send `start`/`stop` from a viewer socket.
- Test HTTPS/WSS and media between separate networks, including configured TURN fallback. Check remote ICE candidates are SFU/TURN addresses, never other viewers/presenter addresses.

## Delay measurement with ten viewers

1. Use a high-motion millisecond counter on the captured source display, refreshed each animation frame (a diagnostic local HTML page is fine). Record capture resolution and actual frame rate/bitrate, simulcast layers and adaptive changes.
2. Use a high-frame-rate camera (ideally ≥240 FPS) to film the physical source display and a viewer display together. Difference between displayed counter values estimates glass-to-glass delay; camera frame interval and display refresh introduce uncertainty. For distant viewers, use a documented synchronized optical/timecode method with measured clock error, not unsynchronized wall clocks.
3. Keep **ten concurrent viewers** receiving media. Measure every viewer, keeping the remaining nine active. Use separate client machines for the supported deployment; ten tabs on one workstation are only a capacity smoke test.
4. After startup, sample at least ten minutes of steady-state playback per test condition. Include motion and audio. Record median, p95, maximum, number/duration of >500 ms excursions, freezes, and measurement uncertainty. Report join/reconnect/startup separately; do not omit steady-state excursions.
5. Capture `webrtc-internals` dumps before/after adding viewers: one presenter publishing media connection, no per-viewer senders, SFU candidate addresses, outbound bitrate/layers. The SDK may maintain signaling/subscriber transport scaffolding; count upstream **media-bearing** connections.
6. Repeat on normal direct UDP and TURN fallback, relevant regions and expected bandwidth/loss/jitter. Reduce target quality if needed and retest all ten. A failure means that condition is unsupported until tuned and revalidated.

| Field | Result |
|---|---|
| Date / commit or source snapshot | Pending |
| Windows / Edge or Chrome / launcher bytes | Pending |
| AWS region / instance / SFU version | Pending |
| Presenter and viewer locations / networks | Pending |
| RTT / loss / jitter / available bandwidth | Pending |
| Capture and delivered resolution / FPS / bitrate | Pending |
| Direct or TURN / ICE candidate types | Pending |
| Ten-viewer median / p95 / maximum delay | Pending |
| >500 ms excursions / freezes / uncertainty | Pending |
| SFU CPU / ingress / egress / packet loss | Pending |
| One upstream media connection confirmed | Pending |
| Functional and restart/reconnect checks | Pending |
| Supported conditions / pass or fail | **Unvalidated** |

Keep raw timing footage, per-viewer samples and WebRTC statistics with the test report. No media is recorded by the application itself.
