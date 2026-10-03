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
