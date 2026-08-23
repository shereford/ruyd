import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInvite,
  DirectConnectivity,
  PROTOCOL_VERSION,
  SignalingError,
  type ConnectionCallbacks,
} from './connectivity';
import { FakePeerConnection, jsonResponse, recorder, resetPeerConnections } from './webrtc-doubles';

const CODE = createInvite('room_identifier_1234', 'invite_verifier_123456789012345678');

const answer = { type: 'answer', sdp: 'v=0\r\n' };
let joinStatus = 200;

function fakeFetch(url: string) {
  if (url.endsWith('/join')) {
    return joinStatus === 200
      ? jsonResponse({ expiresAt: 1 })
      : jsonResponse({ error: 'Connection code was rejected' }, joinStatus);
  }
  if (url.endsWith('/peer/poll')) return jsonResponse({ answer });
  return jsonResponse({});
}

beforeEach(() => {
  vi.useFakeTimers();
  resetPeerConnections();
  joinStatus = 200;
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('fetch', vi.fn((url: string) => fakeFetch(url)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function joined(callbacks: ConnectionCallbacks) {
  const connectivity = new DirectConnectivity(callbacks);
  const pending = connectivity.join(CODE, 'Ada');
  await vi.advanceTimersByTimeAsync(0);
  const room = await pending;
  return { connectivity, room };
}

describe('client reconnection', () => {
  it('joins a room and reports the host', async () => {
    const { events, callbacks } = recorder();
    const { room } = await joined(callbacks);
    expect(room.hostName).toBe('Host');
    expect(events).toEqual(['joined:Host']);
  });

  it('re-enters the room by itself when the connection fails', async () => {
    const { events, callbacks } = recorder();
    await joined(callbacks);

    FakePeerConnection.instances[0].fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain('reconnecting:1/5');

    // The first backoff is two seconds.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(events).toContain('reconnected');
    expect(events.some((event) => event.startsWith('disconnected'))).toBe(false);
    // A second peer connection was built rather than the dead one reused.
    expect(FakePeerConnection.instances).toHaveLength(2);
  });

  it('does not keep retrying when signaling rejects the room credential', async () => {
    const { events, callbacks } = recorder();
    await joined(callbacks);

    joinStatus = 403;
    FakePeerConnection.instances[0].fail();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(events).toContain('reconnecting:1/5');
    expect(events).not.toContain('reconnecting:2/5');
    expect(events.at(-1)).toBe('disconnected:Connection code was rejected');
  });

  it('gives up after the full run of attempts when signaling stays unreachable', async () => {
    const { events, callbacks } = recorder();
    await joined(callbacks);

    joinStatus = 500;
    FakePeerConnection.instances[0].fail();
    // 2s + 4s + 8s + 15s + 15s of backoff, capped at fifteen seconds.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events.filter((event) => event.startsWith('reconnecting'))).toHaveLength(5);
    expect(events.at(-1)).toMatch(/^disconnected:/);
  });

  it('stops reconnecting when the user leaves the room', async () => {
    const { events, callbacks } = recorder();
    const { connectivity } = await joined(callbacks);

    FakePeerConnection.instances[0].fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain('reconnecting:1/5');

    await connectivity.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events).not.toContain('reconnected');
    expect(events.some((event) => event.startsWith('disconnected'))).toBe(false);
  });

  it('refuses a room that speaks a different protocol version', async () => {
    const { callbacks } = recorder();
    FakePeerConnection.welcome = { type: 'welcome', protocol: PROTOCOL_VERSION + 1, hostName: 'Host', peers: [] };
    const connectivity = new DirectConnectivity(callbacks);
    // Settle the rejection before advancing timers; the welcome arrives in a microtask.
    const settled = connectivity.join(CODE, 'Ada').then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect((await settled)?.message).toMatch(/same Ruyd release/i);
  });
});

describe('signaling errors', () => {
  it('treats a missing room, a refused credential, and a conflict as final', () => {
    expect(new SignalingError('gone', 404).isFatal).toBe(true);
    expect(new SignalingError('refused', 403).isFatal).toBe(true);
    expect(new SignalingError('conflict', 409).isFatal).toBe(true);
  });

  it('treats an unreachable service and a server fault as worth retrying', () => {
    expect(new SignalingError('unreachable', 0).isFatal).toBe(false);
    expect(new SignalingError('server', 500).isFatal).toBe(false);
    expect(new SignalingError('throttled', 429).isFatal).toBe(false);
  });
});
