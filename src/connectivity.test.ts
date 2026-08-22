import { describe, expect, it } from 'vitest';
import {
  createInvite,
  DirectConnectivity,
  ICE_CONFIGURATION,
  parseInvite,
  SIGNALING_URL,
} from './connectivity';

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
    const connectivity = new DirectConnectivity({
      onPeerJoined: () => undefined,
      onPeerLeft: () => undefined,
      onChat: () => undefined,
      onDisconnected: () => undefined,
    });
    expect(connectivity.sendChat('hello')).toBe(0);
    expect(connectivity.sendChat('   ')).toBe(0);
  });
});
