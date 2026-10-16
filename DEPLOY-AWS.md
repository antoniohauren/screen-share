# AWS / public deployment

## Placement and initial sizing

Use a Linux EC2 instance with a stable public IPv4/Elastic IP, in the region nearest the presenter **and viewers**. Start evaluation with a non-burstable 2-vCPU / 4-GB machine (for example c7i.large) and sufficient network allowance. This is a starting point, not a validated sizing guarantee. The host must sustain ~4–6 Mbps ingress per broadcast and ~40–60 Mbps egress with ten full-quality viewers; budget at least 75 Mbps available egress and monitor CPU, packet loss, and congestion. At 4 Mbps × 10, payload egress is ~18 GB/hour, before protocol overhead and TURN legs. Simulcast can increase presenter ingress.

Do not claim the 500 ms target for distant regions, congested uplinks, or TCP/TURN paths without measurement. Record the supported region, RTT/loss/jitter and machine/network conditions in VALIDATION.md.

## Configure

Install Docker Engine and Compose. Point `share.example.com` and `media.example.com` DNS A records at the instance. Do not place an HTTP-only CDN/proxy in the media transport path.

```sh
cp .env.example .env
cp livekit.example.yaml livekit.yaml
openssl rand -hex 32
```

Set domains/email and the generated secret in `.env`. Put the **same API key and secret** in `livekit.yaml`. Compose interpolation does not substitute environment variables inside the mounted LiveKit YAML file. Restrict these files to the administrator. `use_external_ip: true` discovers the external address via STUN; verify advertised ICE candidates match the Elastic IP. For unusual NAT configurations use LiveKit's explicit node-IP configuration instead.

AWS security group and host firewall:

| Port | Protocol | Access | Purpose |
|---|---|---|---|
| 80 | TCP | public | Caddy ACME/HTTPS redirect |
| 443 | TCP | public | HTTPS pages and WSS signaling |
| 7881 | TCP | public | WebRTC ICE/TCP fallback |
| 7882 | UDP | public | multiplexed WebRTC media |
| 3478 | UDP | public, optional | built-in TURN UDP |
| 5349 | TCP | public, optional | built-in TURN TLS |
| 7880 | TCP | Docker bridge/localhost only | SFU signaling + administrative RPC |
| 22 | TCP | admin IP only | SSH |

The SFU uses host networking on Linux; Caddy and the app reach it through Docker's host gateway. Ensure the host firewall permits bridge-to-host TCP 7880. Never open 7880 publicly: it exposes administrative API and plain signaling. App port 8787 is internal to the Compose network. HTTP proxying does not carry the UDP/TCP media ports.

```sh
docker compose up -d --build
docker compose logs -f app livekit caddy
```

Open `https://share.example.com`. Caddy automatically obtains certificates for the page and signaling domains. Caddy exposes only LiveKit `/rtc` signaling routes, not RoomService RPC. Public origin checking requires the exact configured HTTPS app origin.

The named `broadcasts` volume stores SQLite metadata/ownership and stopped-generation cleanup records. Back it up using SQLite's online backup API or while the app is stopped (include WAL if copying a running database). Keep `.env` secrets and the owner's browser profile. Never run `docker compose down -v` if you need to retain broadcasts. SFU restart can interrupt media but must not mark a broadcast ended. The server does not save media.

## Optional TURN

Prefer LiveKit's integrated TURN: the SFU sends temporary TURN credentials through its authenticated signaling connection; no TURN secret is exposed by the Rust app. Uncomment `turn.enabled` and `udp_port` in `livekit.yaml` and open UDP 3478.

For restrictive networks, configure TURN TLS with a DNS name and a separately managed valid certificate/key mounted into the LiveKit container:

```yaml
turn:
  enabled: true
  domain: turn.example.com
  udp_port: 3478
  tls_port: 5349
  cert_file: /certs/fullchain.pem
  key_file: /certs/privkey.pem
```

Mount `/certs` read-only in Compose, arrange certificate renewal and LiveKit reload/restart, and open TCP 5349. Standard Caddy HTTP reverse proxying cannot terminate TURN TLS. Networks allowing only TCP 443 need a **separate IP/host** serving TURN TLS on 443 (Caddy already owns 443 here). Validate that deployment separately; do not silently assume 5349 is permitted.

Test fallback by blocking direct media UDP/TCP paths on the test client while allowing configured TURN transport. Confirm a `relay` candidate in `chrome://webrtc-internals` / `edge://webrtc-internals`, media/audio delivery, and measured latency. TURN is connectivity fallback; LiveKit remains the fan-out SFU.

## Scaling boundary

This implementation deliberately uses one Rust app instance and one SFU. Do not replicate the Rust app behind a load balancer: capacity leases currently reside in one process. For more broadcasts, measure aggregate network load; the per-broadcast viewer maximum remains ten. Monitor the number of persistent ended-generation tombstones and cleanup RPC load for long-running, high-churn hosting.
