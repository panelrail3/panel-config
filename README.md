# Xray Panel v7

Independent Railway-ready Xray management panel. It is inspired by the capabilities of mature Xray panels but does not bundle or copy their UI/source.

## Ports
- Gateway/public listener: `1400` (Railway `PORT` should be `1400` if you want the generated Railway domain to reach this listener)
- Panel: `1323` internally
- Xray listeners: allocated from `20000+` and not exposed publicly

## Default login
- username: `admin`
- password: `admin`
Change it immediately from Settings.

## Persistent storage
Attach a Railway Volume at `/app/data`. Railway volumes persist data across deploys/restarts.

## Railway
Set `PORT=1400` in Variables if Railway has assigned a different port and you want the gateway to remain on 1400. Railway makes variables available to the running service.

## What is implemented
- Session authentication
- SQLite persistence
- Inbound CRUD
- Client CRUD and multi-inbound assignment
- VLESS / VMess / Trojan / Shadowsocks
- TCP / WebSocket / HTTPUpgrade / gRPC transports
- TLS and REALITY configuration fields
- Xray config generation and `xray run -test`
- Xray start / stop / restart and logs
- Subscription Base64 output
- VLESS/VMess/Trojan/Shadowsocks links
- QR codes
- Import/export panel backup
- Dashboard/status
- Railway-aware public host detection
- Gateway routing for `/api/ws` and other Xray WebSocket paths

## Important Railway networking note
A Railway public domain is HTTP(S)-oriented. Raw TCP/REALITY listeners should not be assumed to become publicly reachable merely because an inbound exists in this panel. For HTTP-compatible transports, use the public domain and path routing. Railway also exposes a TCP Proxy mechanism separately; its injected variables include `RAILWAY_TCP_PROXY_PORT`.


### Fix in v7.2
The Docker image maps Docker/BuildKit architecture names to the Xray release asset names used by the official Xray installer (`amd64` → `64`, `arm64` → `arm64-v8a`, `arm` → `arm32-v7a`). The previous image incorrectly requested `Xray-linux-amd64.zip`, which caused the Railway build to stop with HTTP 404. The pinned Xray release is v26.9.8; v26.9.9 is a pre-release.


## Railway WebSocket architecture (v7.2)

Use the Railway public domain with **Target Port = 1400**. The container has two listeners:

- `1400`: public Gateway (this is the Railway target port)
- `1323`: panel, reachable internally through the Gateway
- `20000+`: Xray internal listeners on `127.0.0.1`

For WebSocket/HTTPUpgrade/gRPC inbounds, public TLS is terminated by Railway. Xray receives the HTTP transport without TLS internally. Do **not** upload `cert.pem`/`key.pem` and do not set Xray TLS for these HTTP transports.

A VLESS WebSocket link should look like:

`vless://UUID@YOUR_DOMAIN:443?type=ws&security=tls&encryption=none&path=%2Fapi%2Fws&sni=YOUR_DOMAIN#client`

Do not add `alpn=h2` to a WebSocket link. Railway supports WebSockets over HTTP/1.1.

### Railway settings

Set:

```text
PORT=1400
PANEL_PORT=1323
```

Create a Railway Volume mounted at `/app/data`.

In Railway Public Networking, make sure the domain's **Target Port is 1400**. The domain itself remains `https://...` externally, so clients use port 443 even though the container listens on 1400.
