import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectConnectivity, PROTOCOL_VERSION, type ConnectionCallbacks } from './connectivity';
import {
  FakeDataChannel,
  FakePeerConnection,
  jsonResponse,
  recorder,
  resetPeerConnections,
} from './webrtc-doubles';

const POLL_MS = 3_000;

type Offered = { peerId: string; name: string };

/** A signaling service that remembers what the host told it. */
function signaling() {
  const state = {
    /** Peers the next host poll will report. */
    offered: [] as Offered[],
    answered: new Set<string>(),
    calls: [] as string[],
    /** When set, every poll fails with this status. 0 means unreachable. */
    pollStatus: 200 as number,
    created: false,
    closed: false,
  };

  const fetcher = vi.fn(async (url: string, init: { body?: string }) => {
    const path = url.replace('https://connect.ruyd.us', '');
    const body = init.body ? JSON.parse(init.body) : {};
    state.calls.push(path);

    if (path === '/v1/rooms') {
      state.created = true;
      return jsonResponse({ expiresAt: 1 }, 201);
    }
    if (path.endsWith('/host/poll')) {
      if (state.pollStatus === 0) throw new TypeError('network down');
      if (state.pollStatus !== 200) return jsonResponse({ error: 'Room is unavailable' }, state.pollStatus);
      return jsonResponse({
        peers: state.offered.map((peer) => ({
          peerId: peer.peerId,
          name: peer.name,
          offer: { type: 'offer', sdp: 'v=0\r\n' },
          answered: state.answered.has(peer.peerId),
        })),
      });
    }
    if (path.endsWith('/host/answer')) {
      state.answered.add(body.peerId);
      return jsonResponse({ accepted: true });
    }
    if (path.endsWith('/close')) {
      state.closed = true;
      return jsonResponse({ closed: true });
    }
    return jsonResponse({});
  });

  return { state, fetcher };
}

let service: ReturnType<typeof signaling>;

beforeEach(() => {
  vi.useFakeTimers();
  resetPeerConnections();
  service = signaling();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('fetch', service.fetcher);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Hosts a room and lets the poll loop run once. */
async function hosting(callbacks: ConnectionCallbacks) {
  const connectivity = new DirectConnectivity(callbacks);
  const room = await connectivity.host('Ada');
  await vi.advanceTimersByTimeAsync(0);
  return { connectivity, room };
}

/** Offers a peer, waits for the host to answer it, and opens its channel. */
async function joinPeer(peerId: string, name: string): Promise<FakeDataChannel> {
  service.state.offered.push({ peerId, name });
  const before = FakePeerConnection.instances.length;
  await vi.advanceTimersByTimeAsync(POLL_MS);
  const connection = FakePeerConnection.instances[before];
  const channel = connection.receiveChannel();
  channel.open();
  await vi.advanceTimersByTimeAsync(0);
  return channel;
}

describe('hosting a room', () => {
  it('creates the room and hands back a connection string', async () => {
    const { callbacks } = recorder();
    const { room } = await hosting(callbacks);
    expect(service.state.created).toBe(true);
    expect(room.code.startsWith('RUYD2-')).toBe(true);
    expect(room.hostName).toBeNull();
  });

  it('answers an offered peer and welcomes it when its channel opens', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);
    const channel = await joinPeer('peer_identifier_01', 'Bo');

    expect(service.state.answered.has('peer_identifier_01')).toBe(true);
    expect(channel.sent[0]).toEqual({
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      hostName: 'Ada',
      peers: ['Ada', 'Bo'],
    });
    expect(events).toContain('joined:Bo');
  });

  it('does not answer the same peer twice', async () => {
    const { callbacks } = recorder();
    await hosting(callbacks);
    await joinPeer('peer_identifier_01', 'Bo');

    const answersBefore = service.state.calls.filter((path) => path.endsWith('/host/answer')).length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    const answersAfter = service.state.calls.filter((path) => path.endsWith('/host/answer')).length;
    expect(answersAfter).toBe(answersBefore);
  });

  it('numbers a second peer who chose a name already in the room', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);
    await joinPeer('peer_identifier_01', 'Bo');
    const second = await joinPeer('peer_identifier_02', 'Bo');

    expect(events).toEqual(['joined:Bo', 'joined:Bo (2)']);
    expect(second.sent[0]).toMatchObject({ peers: ['Ada', 'Bo', 'Bo (2)'] });
  });

  it('gives up on a peer whose offer cannot be answered', async () => {
    const { callbacks } = recorder();
    await hosting(callbacks);
    FakePeerConnection.refuseAnswers = true;
    service.state.offered.push({ peerId: 'peer_identifier_03', name: 'Cy' });

    await vi.advanceTimersByTimeAsync(POLL_MS * 10);

    // Three attempts, not one per poll for the life of the room.
    expect(FakePeerConnection.instances).toHaveLength(3);
    expect(service.state.answered.size).toBe(0);
  });
});

describe('relaying chat', () => {
  it('fans a peer message out to the others without echoing it back', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);
    const bo = await joinPeer('peer_identifier_01', 'Bo');
    const cy = await joinPeer('peer_identifier_02', 'Cy');

    bo.deliver({ type: 'chat', name: 'Bo', text: 'hello' });

    expect(events).toContain('chat:Bo:hello');
    expect(cy.sent).toContainEqual({ type: 'chat', name: 'Bo', text: 'hello' });
    expect(bo.sent.filter((packet) => packet.type === 'chat')).toHaveLength(0);
  });

  it('attributes a relayed message to the name the host assigned, not the one claimed', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);
    const bo = await joinPeer('peer_identifier_01', 'Bo');
    const cy = await joinPeer('peer_identifier_02', 'Cy');

    cy.deliver({ type: 'chat', name: 'Ada', text: 'not me' });

    expect(events).toContain('chat:Cy:not me');
    expect(bo.sent).toContainEqual({ type: 'chat', name: 'Cy', text: 'not me' });
  });

  it('caps a relayed message at five hundred characters', async () => {
    const { callbacks } = recorder();
    await hosting(callbacks);
    const bo = await joinPeer('peer_identifier_01', 'Bo');
    const cy = await joinPeer('peer_identifier_02', 'Cy');

    bo.deliver({ type: 'chat', name: 'Bo', text: 'x'.repeat(900) });

    const relayed = cy.sent.find((packet) => packet.type === 'chat') as { text: string };
    expect(relayed.text).toHaveLength(500);
  });

  it('reports how many peers a host message reached', async () => {
    const { callbacks } = recorder();
    const { connectivity } = await hosting(callbacks);
    await joinPeer('peer_identifier_01', 'Bo');
    await joinPeer('peer_identifier_02', 'Cy');

    expect(connectivity.sendChat('hi')).toBe(2);
  });

  it('does not announce a departure for a peer that never arrived', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);
    service.state.offered.push({ peerId: 'peer_identifier_09', name: 'Di' });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    // Answered, but its channel never opened, so nobody was ever told about it.
    const connection = FakePeerConnection.instances.at(-1)!;
    connection.fail();

    expect(events.some((event) => event.startsWith('left:'))).toBe(false);
  });

  it('tells the remaining peers when one drops', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);
    const bo = await joinPeer('peer_identifier_01', 'Bo');
    const cy = await joinPeer('peer_identifier_02', 'Cy');

    bo.close();

    expect(events).toContain('left:Bo');
    expect(cy.sent).toContainEqual({ type: 'peer_left', name: 'Bo' });
  });
});

describe('hosting through signaling trouble', () => {
  it('keeps the room open while signaling is unreachable', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);
    const bo = await joinPeer('peer_identifier_01', 'Bo');

    service.state.pollStatus = 0;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(events).toContain('signaling:true');
    expect(events.some((event) => event.startsWith('disconnected'))).toBe(false);
    // The peer that was already connected is untouched, and can still be sent to.
    expect(bo.readyState).toBe('open');
  });

  it('reports recovery once signaling answers again', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);

    service.state.pollStatus = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain('signaling:true');

    service.state.pollStatus = 200;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain('signaling:false');
  });

  it('ends the room when signaling says it has expired', async () => {
    const { events, callbacks } = recorder();
    await hosting(callbacks);

    service.state.pollStatus = 404;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(events.at(-1)).toMatch(/^disconnected:This room is no longer available/);
  });

  it('closes the room on the service when the host stops', async () => {
    const { callbacks } = recorder();
    const { connectivity } = await hosting(callbacks);
    await connectivity.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state.closed).toBe(true);
  });
});
