# Run alongside the existing Streamroom / coturn stack

This is a standalone Compose project for the new screen-share app. Existing
Caddy serves both projects. Ports 80, 443, 3478 and 49160–49200 remain owned by
the existing stack. LiveKit uses TCP 7880/7881 and UDP 7882.

Keep this repository in a separate directory from the existing `~/stream` project.
Do not overwrite that project's Compose files, `.env`, or Caddyfile.

## Setup

Find the network used by the existing Caddy container:

```sh
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker inspect <existing-caddy-container> --format '{{json .NetworkSettings.Networks}}'
```

In this repository:

```sh
cp .env.sidecar.example .env.sidecar
cp livekit.example.yaml livekit.yaml
openssl rand -hex 32
```

Edit `.env.sidecar`: set two new hostnames, the existing Caddy network name,
and the generated API secret. Set the same key and secret in `livekit.yaml`.
Leave its optional TURN section disabled so it does not compete with coturn.
Point both new DNS A records at the EC2 public IP.

```sh
docker compose --env-file .env.sidecar -f compose.sidecar.yaml up -d --build
```

The project is named `screen-share` and has its own database volume. Its app
joins the existing proxy network under the unique alias `screen-share-app`.

## Add routes to the existing Caddy

Append these blocks to the **existing** Caddyfile, keeping its current routes.
Replace the hostnames with your new domains. Replace `172.31.33.80` if your
EC2 private IP differs.

```caddyfile
share.example.com {
    encode zstd gzip
    reverse_proxy screen-share-app:8787
}

media.example.com {
    @rtc path /rtc /rtc/*
    reverse_proxy @rtc 172.31.33.80:7880
    respond 404
}
```

Validate and gracefully reload the existing Caddy container:

```sh
docker exec <existing-caddy-container> caddy validate --config /etc/caddy/Caddyfile
docker exec <existing-caddy-container> caddy reload --config /etc/caddy/Caddyfile
```

## Firewall

Add public inbound **TCP 7881** and **UDP 7882** to the EC2 security group
and host firewall. Keep existing rules for the existing services.
Allow TCP 7880 from Docker bridge networks to the host only, including the
private-IP route used by Caddy; do not expose it publicly. Port 8787 is internal.

The old app's coturn environment variables do not configure LiveKit TURN.
This deployment uses LiveKit's direct media transport and TCP fallback; see
`DEPLOY-AWS.md` if TURN fallback is also needed for the new app.

Manage only this new project with:

```sh
docker compose --env-file .env.sidecar -f compose.sidecar.yaml logs -f
docker compose --env-file .env.sidecar -f compose.sidecar.yaml down
```
