import { describe, expect, it } from 'vitest';
import { createInvite, ICE_CONFIGURATION, parseInvite, SIGNALING_URL } from './connectivity';

describe('Ruyd direct connectivity configuration', () => {
  it('round-trips authenticated version 2 invites', () => {
    const roomId = 'room_identifier_1234';
    const secret = 'invite_verifier_123456789012345678';
    expect(parseInvite(createInvite(roomId, secret))).toEqual({ v: 2, roomId, secret });
  });

  it('rejects legacy and malformed invites', () => {
    expect(() => parseInvite('RUYD1-old-code')).toThrow(/invalid or unsupported/i);
    expect(() => parseInvite('RUYD2-not-json')).toThrow(/invalid or unsupported/i);
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
});
