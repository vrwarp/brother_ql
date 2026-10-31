# brother-ql-bridge

A small WebSocket-to-TCP relay that lets a web page print to a **Wi-Fi** Brother
QL label printer, which a browser cannot reach on its own. It is the companion
to [`@vrwarp/brother-ql-webusb`](../README.md) and its `BridgeTransport`.

A browser can open a USB device (WebUSB) and a WebSocket, but not a raw TCP
connection — and a networked Brother QL listens for jobs on raw TCP port 9100.
The bridge closes that one gap and nothing more:

- it holds the list of printers and the bearer tokens that may use them;
- for one authenticated WebSocket it opens one TCP connection to one printer
  and pipes bytes both ways;
- it reads a printer's **status** over SNMP (or port 9100, per printer) and
  relays the 32 byte block, because most network QL models never answer the
  `ESC i S` status request on 9100.

**It does not rasterise.** Every byte the printer receives is produced in the
browser by the library. The bridge forwards opaque frames and never interprets
a job. If the bridge is compromised it can drop or misroute jobs, but it holds
no imaging code and no printer driver.

## Run it

```bash
docker run -d --name ql-bridge \
  -p 8080:8080 \
  -v ql-bridge-data:/data \
  -e ADMIN_TOKEN=choose-a-long-random-string \
  <your-dockerhub-namespace>/brother-ql-bridge:latest
```

Then open `http://localhost:8080/` and sign in with the admin token. Add your
printers, create a client token, and paste that token into the page that will
print. The printers must be reachable from wherever the container runs — the
bridge connects to them, so it belongs on the same network as the printers.

Without a Docker image to hand you can run it from source:

```bash
npm ci
npm run build
ADMIN_TOKEN=... DATA_DIR=./data node dist/index.js
```

## The admin interface

Served at `/`, it does two things:

- **Client tokens.** Create a token (shown once — copy it then), or revoke one.
  A token is what a page presents to connect; revoking it refuses the next
  connection.
- **Printers.** Add a printer by name, host and port (9100 by default), with a
  **status mode**:
  - `snmp` — read status over SNMP, OID `1.3.6.1.4.1.2435.3.3.9.1.6.1.0`, which
    Brother documents as the network equivalent of `ESC i S`. The right choice
    for a QL-810W, QL-820NWB or QL-1110NWB.
  - `tcp` — write `ESC i S` to port 9100 and read the reply. Only for a printer
    known to answer there.
  - `none` — no status; jobs are fire and forget.

  **Probe** opens the printer's port and fetches a status, so you can confirm a
  printer is reachable and loaded before anyone prints to it.

## Configuration

All via environment variables; the defaults suit the container.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_TOKEN` | generated | The admin interface's bearer token. When unset, one is generated on first start and printed to the log once; set this to choose your own. |
| `PORT` | `8080` | TCP port to listen on. |
| `HOST` | `0.0.0.0` | Address to bind. |
| `DATA_DIR` | `/data` | Where `bridge.json` (tokens and printers) is kept. Mount a volume here. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated browser origins allowed to connect, or `*` for any. The bearer token is the real access control; this is defence in depth. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | — | PEM files. Set both to serve HTTPS and `wss://` directly instead of behind a TLS proxy. |
| `AUTH_TIMEOUT_MS` | `10000` | How long a connection may stay unauthenticated. |
| `CONNECT_TIMEOUT_MS` | `5000` | How long to wait for a printer's port 9100 to accept. |
| `SNMP_TIMEOUT_MS` | `2000` | How long to wait for an SNMP answer. |

## Security notes

- **Tokens are hashed.** Only the SHA-256 of each token is stored, with the
  first few characters kept in clear so tokens can be told apart in the list. A
  token is shown in full exactly once, when created.
- **Serve it over TLS.** A browser on an HTTPS page can only open a `wss://`
  WebSocket, and the admin token travels in an `Authorization` header. Put the
  bridge behind a TLS-terminating reverse proxy, or set `TLS_CERT_FILE` and
  `TLS_KEY_FILE`. (A page served from `localhost` may use `ws://`.)
- **It runs as a non-root user** (uid 1000) and writes only to `/data`.
- **One client per printer.** The bridge locks a printer to the one connection
  that opened it, so two pages cannot interleave jobs on one device.

## Using it from the library

```ts
import {
  BrotherQLPrinter,
  BridgeTransport,
  listBridgePrinters,
  enableBrowserImages,
} from '@vrwarp/brother-ql-webusb';

const url = 'wss://bridge.example/ws';
const token = '…a client token from the admin page…';

// Show the user the printers the bridge offers.
const printers = await listBridgePrinters({ url, token });

// Open one and print to it exactly as over USB.
const transport = new BridgeTransport({ url, token, printerId: printers[0].id });
const printer = new BrotherQLPrinter(transport, { model: printers[0].model ?? 'QL-810W' });
enableBrowserImages(printer);

await printer.open();
await printer.print(canvas, { label: '62' });
await printer.close();
```

See the [library README](../README.md#printing-over-wi-fi-the-bridge) for how
completion is reported over the network, which differs from USB.

## Protocol

Control messages are JSON text frames; printer data is binary frames. The shape
is defined in `src/protocol.ts` here and mirrored in the library's
`src/bridge/protocol.ts`; `BRIDGE_PROTOCOL_VERSION` (currently 1) is sent in the
`hello` frame and checked by the client. A session is: `hello` → `auth` →
`auth-ok` → `open` → `opened` → binary frames each answered by `ack`, with
`status` fetching a status block, until `close` or the socket drops.

## Development

```bash
npm ci
npm run typecheck
npm test          # ~97 tests: SNMP codec, store, HTTP admin API, the relay end to end
npm run build
```
