/**
 * Test doubles for applications that print through the bridge.
 *
 * `import { FakeBridgeServer } from '@vrwarp/brother-ql-webusb/testing'` gives
 * a scripted bridge behind a fake WebSocket: hand `server.factory` to
 * `BridgeTransport` as its `webSocketFactory` and drive the real transport,
 * the real printer core and your own code against it, with the knobs the
 * library's own suite uses — late and jittery acks, dropped sockets, each
 * status mode, scripted status answers, and the job log.
 */
export {
  DEFAULT_PRINTERS,
  FakeBridgeServer,
  FakeSession,
  MockWebSocket,
  settle,
  type FakeBridgeOptions,
} from './testing/mock-bridge.js';
