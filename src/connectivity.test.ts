import { describe, expect, it } from 'vitest';
import type { ConnectionCallbacks } from './connectivity';
import {
  createInvite,
  DirectConnectivity,
  ICE_CONFIGURATION,
  parseInvite,
  parsePacket,
  PROTOCOL_VERSION,
  SIGNALING_URL,
} from './connectivity';

const silentCallbacks = (): ConnectionCallbacks => ({
  onPeerJoined: () => undefined,
  onPeerLeft: () => undefined,
  onChat: () => undefined,
  onReconnecting: () => undefined,
  onReconnected: () => undefined,
  onSignalingDegraded: () => undefined,
  onDisconnected: () => undefined,
});

const roomId = 'room_identifier_1234';
const secret = 'invite_verifier_123456789012345678';

describe('Ruyd direct connectivity configuration', () => {
  it('round-trips authenticated version 2 invites', () => {
    expect(parseInvite(createInvite(roomId, secret))).toEqual({ v: 2, roomId, secret });
  });

  it('produces a URL-safe connection string', () => {
    const code = createInvite(roomId, secret);
    expect(code.startsWith('RUYD2-')).toBe(true);
    expect(code.slice('RUYD2-'.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts a connection string that was wrapped or padded when it was shared', () => {
    const code = createInvite(roomId, secret);
    const wrapped = ` ${code.slice(0, 20)}\n${code.slice(20)} `;
    expect(parseInvite(wrapped)).toEqual({ v: 2, roomId, secret });
  });

  it('rejects legacy and malformed invites', () => {
    expect(() => parseInvite('RUYD1-old-code')).toThrow(/invalid or unsupported/i);
    expect(() => parseInvite('RUYD2-not-json')).toThrow(/invalid or unsupported/i);
    expect(() => parseInvite('')).toThrow(/invalid or unsupported/i);
    expect(() => parseInvite(createInvite(roomId, secret).slice('RUYD2-'.length)))
      .toThrow(/invalid or unsupported/i);
  });

  it('rejects invites whose room or secret is too weak to be a room credential', () => {
    expect(() => parseInvite(createInvite('short', secret))).toThrow(/invalid or unsupported/i);
    expect(() => parseInvite(createInvite(roomId, 'too-short-secret'))).toThrow(/invalid or unsupported/i);
  });

  it('has STUN discovery but no traffic relay', () => {
    const urls = (ICE_CONFIGURATION.iceServers || []).flatMap((server) =>
      typeof server.urls === 'string' ? [server.urls] : server.urls,
    );
    expect(urls).toEqual(['stun:stun.ruyd.us:3478']);
    expect(urls.some((url) => /^turns?:/i.test(url))).toBe(false);
    expect(ICE_CONFIGURATION.iceTransportPolicy).toBe('all');
    expect(SIGNALING_URL).toBe('https://connect.ruyd.us');
  });

  it('reports that nothing was sent when there is no room', () => {
    const connectivity = new DirectConnectivity(silentCallbacks());
    expect(connectivity.sendChat('hello')).toBe(0);
    expect(connectivity.sendChat('   ')).toBe(0);
  });
});

describe('data-channel packet validation', () => {
  const welcome = { type: 'welcome', protocol: PROTOCOL_VERSION, hostName: 'Ada', peers: ['Ada'] };

  it('accepts every packet the protocol defines', () => {
    expect(parsePacket(JSON.stringify(welcome))).toEqual(welcome);
    expect(parsePacket(JSON.stringify({ type: 'peer_joined', name: 'Bo' })))
      .toEqual({ type: 'peer_joined', name: 'Bo' });
    expect(parsePacket(JSON.stringify({ type: 'peer_left', name: 'Bo' })))
      .toEqual({ type: 'peer_left', name: 'Bo' });
    expect(parsePacket(JSON.stringify({ type: 'chat', name: 'Bo', text: 'hi' })))
      .toEqual({ type: 'chat', name: 'Bo', text: 'hi' });
  });

  it('accepts a welcome from a release that predates protocol versioning', () => {
    const { protocol: _protocol, ...legacy } = welcome;
    expect(parsePacket(JSON.stringify(legacy))).toEqual(legacy);
  });

  it('drops frames that are not well-formed protocol packets', () => {
    expect(parsePacket('not json')).toBeNull();
    expect(parsePacket('null')).toBeNull();
    expect(parsePacket('[]')).toBeNull();
    expect(parsePacket('"a string"')).toBeNull();
    expect(parsePacket(JSON.stringify({ type: 'unknown' }))).toBeNull();
    expect(parsePacket(JSON.stringify({ hostName: 'Ada', peers: [] }))).toBeNull();
  });

  it('drops packets whose fields have the wrong shape', () => {
    expect(parsePacket(JSON.stringify({ ...welcome, peers: 'Ada' }))).toBeNull();
    expect(parsePacket(JSON.stringify({ ...welcome, peers: [1, 2] }))).toBeNull();
    expect(parsePacket(JSON.stringify({ ...welcome, protocol: 'one' }))).toBeNull();
    expect(parsePacket(JSON.stringify({ type: 'chat', name: 'Bo' }))).toBeNull();
    expect(parsePacket(JSON.stringify({ type: 'chat', name: 'Bo', text: 42 }))).toBeNull();
    expect(parsePacket(JSON.stringify({ type: 'peer_joined' }))).toBeNull();
  });

  it('drops frames that are not strings or are oversized', () => {
    expect(parsePacket(undefined)).toBeNull();
    expect(parsePacket(new ArrayBuffer(8))).toBeNull();
    expect(parsePacket({ type: 'chat', name: 'Bo', text: 'hi' })).toBeNull();
    const oversized = JSON.stringify({ type: 'chat', name: 'Bo', text: 'x'.repeat(10_001) });
    expect(oversized.length).toBeGreaterThan(10_000);
    expect(parsePacket(oversized)).toBeNull();
  });
});
