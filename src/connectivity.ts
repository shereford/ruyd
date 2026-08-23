import { Negotiator, type NegotiationSignal } from './negotiation';

export const SIGNALING_URL = (import.meta.env.VITE_RUYD_SIGNALING_URL as string | undefined)?.replace(/\/$/, '') || 'https://connect.ruyd.us';
export const ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.ruyd.us:3478'] }],
  iceTransportPolicy: 'all',
};

const INVITE_PREFIX = 'RUYD2-';
const HOST_POLL_INTERVAL_MS = 3_000;
const PEER_POLL_INTERVAL_MS = 750;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Version of the data-channel packet format, announced by the host in its welcome
 * packet. Together with INVITE_PREFIX this gates both directions of a version skew:
 * the prefix stops an older release from joining a newer room, and this version stops
 * a newer release from misreading an older room. Bump both when the format changes.
 *
 * 2 added `negotiate`, which carries renegotiation between two peers over their data
 * channel. A release that cannot renegotiate would appear to connect and then silently
 * never receive anything added to the connection later, so 1 and 2 do not interoperate.
 */
export const PROTOCOL_VERSION = 2;

/** Highest number of peers a host will answer at once. */
const MAX_PEERS = 16;

/** Attempts to answer one peer's offer before it is treated as unreachable. */
const MAX_ANSWER_ATTEMPTS = 3;

/** Attempts a client makes to re-establish a dropped room before giving up. */
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * Consecutive signaling failures a host tolerates before it tells the caller that
 * new friends cannot join. It never stops retrying on its own: peers that are already
 * connected talk over their data channels and are unaffected by signaling being down.
 */
const SIGNALING_DEGRADED_AFTER = 3;
const SIGNALING_MAX_BACKOFF_MS = 30_000;

type Invite = { v: 2; roomId: string; secret: string };
type Description = { type: 'offer' | 'answer'; sdp: string };
type SignalPeer = { peerId: string; name: string; offer: Description; answered: boolean };
type Packet =
  | { type: 'welcome'; protocol?: number; hostName: string; peers: string[] }
  | { type: 'peer_joined'; name: string }
  | { type: 'peer_left'; name: string }
  | { type: 'chat'; name: string; text: string }
  /** Renegotiation between this pair only. Never relayed to another peer. */
  | { type: 'negotiate'; signal: NegotiationSignal };

export type ConnectionCallbacks = {
  onPeerJoined(name: string): void;
  onPeerLeft(name: string): void;
  onChat(name: string, text: string): void;
  /** A client lost its room and is trying to re-establish it. */
  onReconnecting(attempt: number, attempts: number, reason: string): void;
  /** A client re-established its room. The room details may have changed. */
  onReconnected(room: RoomInfo): void;
  /** A host cannot reach signaling. Connected peers are unaffected; new joins are not possible. */
  onSignalingDegraded(degraded: boolean): void;
  /** The room ended and will not come back on its own. */
  onDisconnected(reason: string): void;
};

export type RoomInfo = {
  code: string;
  endpoint: string;
  detail: string;
  hostName: string | null;
};

type HostPeer = {
  name: string;
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  /** Carries renegotiation with this peer once their channel is open. */
  negotiator: Negotiator | null;
  /**
   * Whether this peer's arrival has been announced. A departure is announced only if an
   * arrival was, and exactly once. Reading the channel's `readyState` at removal time
   * cannot answer this: the `close` event fires after the state is already `closed`.
   */
  announced: boolean;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid Ruyd connection code');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 24): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function createInvite(roomId: string, secret: string): string {
  const invite: Invite = { v: 2, roomId, secret };
  return INVITE_PREFIX + toBase64Url(textEncoder.encode(JSON.stringify(invite)));
}

export function parseInvite(code: string): Invite {
  const encoded = code.trim().replace(/\s+/g, '').startsWith(INVITE_PREFIX)
    ? code.trim().replace(/\s+/g, '').slice(INVITE_PREFIX.length)
    : '';
  try {
    const value = JSON.parse(textDecoder.decode(fromBase64Url(encoded))) as Partial<Invite>;
    if (
      value.v !== 2 ||
      typeof value.roomId !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(value.roomId) ||
      typeof value.secret !== 'string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(value.secret)
    ) {
      throw new Error();
    }
    return value as Invite;
  } catch {
    throw new Error('Invalid or unsupported Ruyd connection code');
  }
}

/** Longest display name the signaling service accepts, and so the longest the host shows. */
const MAX_NAME_LENGTH = 24;

/**
 * Names are how the protocol identifies people: peer lists, join and leave notices, and
 * message attribution all carry a name and nothing else. Two friends who pick the same
 * one would collapse into a single entry and one leaving would remove both, so the host
 * gives the later arrival a numbered name before it announces them to anyone.
 */
export function disambiguate(candidate: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(candidate)) return candidate;
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const marker = ` (${suffix})`;
    const room = MAX_NAME_LENGTH - marker.length;
    const attempt = Array.from(candidate).slice(0, room).join('') + marker;
    if (!used.has(attempt)) return attempt;
  }
  return candidate;
}

function normalizeName(value: string): string {
  const name = Array.from(value.trim()).slice(0, 24).join('');
  if (Array.from(name).length < 2) throw new Error('Display name must be between 2 and 24 characters');
  return name;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Stopped', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Stopped', 'AbortError'));
    }, { once: true });
  });
}

/** A signaling response that failed. `status` is 0 when the service could not be reached. */
export class SignalingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SignalingError';
  }

  /** True when retrying cannot help: the room is gone, or this credential is not valid for it. */
  get isFatal(): boolean {
    return this.status === 403 || this.status === 404 || this.status === 409;
  }
}

async function request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SIGNALING_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new SignalingError('Ruyd could not reach its connection service. Check your internet connection and try again.', 0);
  }
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    throw new SignalingError(payload.error || `Connection service returned HTTP ${response.status}`, response.status);
  }
  return payload;
}

function serializableDescription(description: RTCSessionDescription | null): Description {
  if (!description?.sdp || (description.type !== 'offer' && description.type !== 'answer')) {
    throw new Error('WebRTC did not create a usable connection description');
  }
  return { type: description.type, sdp: description.sdp };
}

function waitForIceGathering(connection: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('Timed out while discovering a direct network path')), 12_000);
    const onChange = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const onAbort = () => finish(new DOMException('Stopped', 'AbortError'));
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', onChange);
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve();
    };
    connection.addEventListener('icegatheringstatechange', onChange);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function directFailure(): Error {
  return new Error('A direct tunnel could not be established between these networks. No port forwarding is required, but this network combination may require future relay access.');
}

function isNegotiationSignal(value: unknown): value is NegotiationSignal {
  if (!value || typeof value !== 'object') return false;
  const signal = value as Record<string, unknown>;
  if ('description' in signal) {
    const description = signal.description;
    if (!description || typeof description !== 'object') return false;
    const { type, sdp } = description as Record<string, unknown>;
    return (type === 'offer' || type === 'answer') && typeof sdp === 'string' && sdp.length > 0;
  }
  if ('candidate' in signal) {
    return signal.candidate === null || (typeof signal.candidate === 'object' && signal.candidate !== null);
  }
  return false;
}

/**
 * Validates a frame received from a peer. Everything crossing the data channel is
 * attacker-controlled, so an unrecognised or malformed frame is dropped rather than
 * partially applied.
 */
export function parsePacket(value: unknown): Packet | null {
  if (typeof value !== 'string' || value.length > 10_000) return null;
  try {
    const packet = JSON.parse(value) as Record<string, unknown>;
    if (!packet || typeof packet !== 'object' || Array.isArray(packet) || typeof packet.type !== 'string') return null;
    if (packet.type === 'welcome'
      && (packet.protocol === undefined || typeof packet.protocol === 'number')
      && typeof packet.hostName === 'string'
      && Array.isArray(packet.peers)
      && packet.peers.every((peer) => typeof peer === 'string')) return packet as Packet;
    if ((packet.type === 'peer_joined' || packet.type === 'peer_left') && typeof packet.name === 'string') return packet as Packet;
    if (packet.type === 'chat' && typeof packet.name === 'string' && typeof packet.text === 'string') return packet as Packet;
    if (packet.type === 'negotiate' && isNegotiationSignal(packet.signal)) return packet as Packet;
    return null;
  } catch {
    return null;
  }
}

function send(channel: RTCDataChannel | null, packet: Packet): boolean {
  if (!channel || channel.readyState !== 'open') return false;
  channel.send(JSON.stringify(packet));
  return true;
}

export class DirectConnectivity {
  private mode: 'idle' | 'host' | 'client' = 'idle';
  private abortController: AbortController | null = null;
  private name = '';
  private roomId = '';
  private hostToken = '';
  private hostPeers = new Map<string, HostPeer>();
  private answerAttempts = new Map<string, number>();
  private clientConnection: RTCPeerConnection | null = null;
  private clientChannel: RTCDataChannel | null = null;
  private clientNegotiator: Negotiator | null = null;
  /** What a client needs to re-enter its room without asking the user for the code again. */
  private rejoin: { code: string; name: string } | null = null;
  private reconnecting = false;

  constructor(private readonly callbacks: ConnectionCallbacks) {}

  async host(displayName: string): Promise<RoomInfo> {
    await this.stop();
    this.mode = 'host';
    this.name = normalizeName(displayName);
    this.roomId = randomToken(18);
    this.hostToken = randomToken();
    const inviteVerifier = randomToken();
    this.abortController = new AbortController();

    try {
      await request('/v1/rooms', {
        roomId: this.roomId,
        hostToken: this.hostToken,
        inviteVerifier,
      }, this.abortController.signal);
      void this.hostPollLoop(this.abortController.signal);
      return {
        code: createInvite(this.roomId, inviteVerifier),
        endpoint: 'Direct WebRTC via stun.ruyd.us',
        detail: 'Host is online and waiting. Ruyd will try encrypted direct paths through both players\' routers; no port forwarding is needed.',
        hostName: null,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async join(code: string, displayName: string): Promise<RoomInfo> {
    await this.stop();
    const room = await this.openClientRoom(code, displayName);
    this.rejoin = { code, name: displayName };
    return room;
  }

  private async openClientRoom(code: string, displayName: string): Promise<RoomInfo> {
    await this.teardown();
    this.mode = 'client';
    this.name = normalizeName(displayName);
    const invite = parseInvite(code);
    this.roomId = invite.roomId;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const peerId = randomToken(18);
    const peerToken = randomToken();
    const connection = new RTCPeerConnection(ICE_CONFIGURATION);
    this.clientConnection = connection;
    const channel = connection.createDataChannel('ruyd-chat', { ordered: true });
    this.clientChannel = channel;
    // A joining peer negotiates with the host alone, and yields when they collide.
    this.clientNegotiator = new Negotiator({
      connection,
      polite: true,
      send: (signal) => send(channel, { type: 'negotiate', signal }),
    });

    let hostName = '';
    let welcomeError = '';
    let resolveWelcome!: () => void;
    const welcome = new Promise<void>((resolve) => { resolveWelcome = resolve; });
    this.bindClientChannel(channel, (name, error) => {
      hostName = name;
      welcomeError = error ?? '';
      resolveWelcome();
    });

    connection.addEventListener('connectionstatechange', () => {
      // A superseded connection from an earlier attempt can still emit events.
      if (this.mode !== 'client' || this.clientConnection !== connection) return;
      if (connection.connectionState === 'failed') this.dropped(directFailure().message);
      if (connection.connectionState === 'closed') this.dropped('The direct connection was closed.');
    });

    try {
      await connection.setLocalDescription(await connection.createOffer());
      await waitForIceGathering(connection, signal);
      await request(`/v1/rooms/${invite.roomId}/join`, {
        inviteVerifier: invite.secret,
        peerId,
        peerToken,
        name: this.name,
        offer: serializableDescription(connection.localDescription),
      }, signal);

      const deadline = Date.now() + CONNECT_TIMEOUT_MS;
      let answer: Description | null = null;
      while (!answer && Date.now() < deadline) {
        const result = await request<{ answer: Description | null }>(
          `/v1/rooms/${invite.roomId}/peer/poll`,
          { peerId, peerToken },
          signal,
        );
        answer = result.answer;
        if (!answer) await delay(PEER_POLL_INTERVAL_MS, signal);
      }
      if (!answer) throw directFailure();
      await connection.setRemoteDescription(answer);
      await Promise.race([
        welcome,
        delay(Math.max(1, deadline - Date.now()), signal).then(() => { throw directFailure(); }),
      ]);
      if (welcomeError) throw new Error(welcomeError);

      return {
        code: code.trim(),
        endpoint: 'Encrypted direct WebRTC channel',
        detail: `Connected directly to ${hostName}. Signaling is complete; chat traffic does not pass through Ruyd servers.`,
        hostName,
      };
    } catch (error) {
      await this.teardown();
      throw error;
    }
  }

  /**
   * A client lost its connection. Re-entering the room is a fresh join with a new peer
   * identifier rather than an ICE restart, because the signaling record for a peer is
   * write-once; the host answers it like any other new peer. The room credential, the
   * display name, and the conversation are all kept, so the user is not asked for
   * anything.
   */
  private dropped(reason: string): void {
    if (this.mode !== 'client' || this.reconnecting) return;
    if (!this.rejoin) {
      this.callbacks.onDisconnected(reason);
      return;
    }
    this.reconnecting = true;
    void this.reconnectLoop(this.rejoin, reason);
  }

  private async reconnectLoop(target: { code: string; name: string }, reason: string): Promise<void> {
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
      this.callbacks.onReconnecting(attempt, RECONNECT_ATTEMPTS, reason);
      const wait = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
      try {
        await delay(wait);
      } catch {
        return;
      }
      if (!this.reconnecting) return;
      try {
        const room = await this.openClientRoom(target.code, target.name);
        if (!this.reconnecting) {
          await this.teardown();
          return;
        }
        this.reconnecting = false;
        this.rejoin = target;
        this.callbacks.onReconnected(room);
        return;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        // The room is gone or the credential no longer works. Retrying cannot help.
        if (error instanceof SignalingError && error.isFatal) break;
      }
    }
    this.reconnecting = false;
    this.rejoin = null;
    this.callbacks.onDisconnected(reason);
  }

  sendChat(text: string): number {
    const message = Array.from(text.trim()).slice(0, 500).join('');
    if (!message) return 0;
    const packet: Packet = { type: 'chat', name: this.name, text: message };
    if (this.mode === 'client') return send(this.clientChannel, packet) ? 1 : 0;
    if (this.mode === 'host') {
      let recipients = 0;
      this.hostPeers.forEach((peer) => {
        if (send(peer.channel, packet)) recipients += 1;
      });
      return recipients;
    }
    return 0;
  }

  /** Ends the room at the user's request and cancels any reconnection in progress. */
  async stop(): Promise<void> {
    this.reconnecting = false;
    this.rejoin = null;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const closingMode = this.mode;
    this.mode = 'idle';
    this.abortController?.abort();

    if (closingMode === 'host' && this.roomId && this.hostToken) {
      void request(`/v1/rooms/${this.roomId}/close`, { hostToken: this.hostToken }).catch(() => undefined);
    }
    this.hostPeers.forEach((peer) => {
      peer.negotiator?.close();
      peer.channel?.close();
      peer.connection.close();
    });
    this.hostPeers.clear();
    this.answerAttempts.clear();
    this.clientNegotiator?.close();
    this.clientChannel?.close();
    this.clientConnection?.close();
    this.clientNegotiator = null;
    this.clientChannel = null;
    this.clientConnection = null;
    this.abortController = null;
    this.roomId = '';
    this.hostToken = '';
  }

  private async hostPollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    let degraded = false;
    while (this.mode === 'host' && !signal.aborted) {
      try {
        const result = await request<{ peers: SignalPeer[] }>(
          `/v1/rooms/${this.roomId}/host/poll`,
          { hostToken: this.hostToken },
          signal,
        );
        consecutiveFailures = 0;
        if (degraded) {
          degraded = false;
          this.callbacks.onSignalingDegraded(false);
        }
        for (const peer of result.peers) {
          if (peer.answered || this.hostPeers.has(peer.peerId)) continue;
          if (this.hostPeers.size >= MAX_PEERS) break;
          // Without this, a peer whose offer can never be answered is retried on every
          // poll for the lifetime of the room, building a peer connection each time.
          const attempts = this.answerAttempts.get(peer.peerId) ?? 0;
          if (attempts >= MAX_ANSWER_ATTEMPTS) continue;
          this.answerAttempts.set(peer.peerId, attempts + 1);
          void this.answerPeer(peer, signal);
        }
        await delay(HOST_POLL_INTERVAL_MS, signal);
      } catch (error) {
        if (signal.aborted) return;
        // The room expired or the host token stopped working. Nothing to retry.
        if (error instanceof SignalingError && error.isFatal) {
          this.callbacks.onDisconnected(
            error.status === 404
              ? 'This room is no longer available. Start hosting again to create a new one.'
              : error.message,
          );
          await this.stop();
          return;
        }
        consecutiveFailures += 1;
        // Keep retrying. Friends who are already connected talk over their data
        // channels, so signaling being unreachable must not close a working room.
        if (!degraded && consecutiveFailures >= SIGNALING_DEGRADED_AFTER) {
          degraded = true;
          this.callbacks.onSignalingDegraded(true);
        }
        const backoff = Math.min(SIGNALING_MAX_BACKOFF_MS, consecutiveFailures * 2_000);
        await delay(backoff, signal).catch(() => undefined);
      }
    }
  }

  private async answerPeer(peer: SignalPeer, signal: AbortSignal): Promise<void> {
    const connection = new RTCPeerConnection(ICE_CONFIGURATION);
    const taken = [this.name, ...Array.from(this.hostPeers.values(), (candidate) => candidate.name)];
    const hostPeer: HostPeer = {
      name: disambiguate(peer.name, taken),
      connection,
      channel: null,
      negotiator: null,
      announced: false,
    };
    // The host negotiates with several peers at once, so it is the side that does not
    // yield when two renegotiations collide.
    hostPeer.negotiator = new Negotiator({
      connection,
      polite: false,
      send: (signal) => send(hostPeer.channel, { type: 'negotiate', signal }),
    });
    this.hostPeers.set(peer.peerId, hostPeer);

    connection.addEventListener('datachannel', (event) => {
      hostPeer.channel = event.channel;
      this.bindHostChannel(peer.peerId, hostPeer);
    });
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        this.removeHostPeer(peer.peerId);
      }
    });

    try {
      await connection.setRemoteDescription(peer.offer);
      await connection.setLocalDescription(await connection.createAnswer());
      await waitForIceGathering(connection, signal);
      await request(`/v1/rooms/${this.roomId}/host/answer`, {
        hostToken: this.hostToken,
        peerId: peer.peerId,
        answer: serializableDescription(connection.localDescription),
      }, signal);
    } catch {
      this.removeHostPeer(peer.peerId);
    }
  }

  private bindHostChannel(peerId: string, peer: HostPeer): void {
    const channel = peer.channel!;
    channel.addEventListener('open', () => {
      const connectedPeers = [this.name, ...Array.from(this.hostPeers.values())
        .filter((candidate) => candidate.channel?.readyState === 'open')
        .map((candidate) => candidate.name)];
      send(channel, { type: 'welcome', protocol: PROTOCOL_VERSION, hostName: this.name, peers: connectedPeers });
      // Only now can renegotiation reach this peer, and only now is the initial
      // offer and answer from the signaling service finished with.
      peer.negotiator?.arm();
      peer.announced = true;
      this.callbacks.onPeerJoined(peer.name);
      this.hostPeers.forEach((candidate, id) => {
        if (id !== peerId) send(candidate.channel, { type: 'peer_joined', name: peer.name });
      });
    });
    channel.addEventListener('message', (event) => {
      const packet = parsePacket(event.data);
      if (!packet) return;
      if (packet.type === 'negotiate') {
        // Point to point with this peer. Never relayed to anyone else.
        void peer.negotiator?.accept(packet.signal);
        return;
      }
      if (packet.type !== 'chat') return;
      const text = Array.from(packet.text.trim()).slice(0, 500).join('');
      if (!text) return;
      this.callbacks.onChat(peer.name, text);
      this.hostPeers.forEach((candidate, id) => {
        if (id !== peerId) send(candidate.channel, { type: 'chat', name: peer.name, text });
      });
    });
    channel.addEventListener('close', () => this.removeHostPeer(peerId));
  }

  private bindClientChannel(
    channel: RTCDataChannel,
    onWelcome: (hostName: string, error?: string) => void,
  ): void {
    channel.addEventListener('message', (event) => {
      const packet = parsePacket(event.data);
      if (!packet) return;
      if (packet.type === 'welcome') {
        // Releases before this one did not announce a version; they speak version 1.
        const protocol = packet.protocol ?? 1;
        if (protocol !== PROTOCOL_VERSION) {
          onWelcome('', `This room uses Ruyd connection protocol ${protocol} and this release uses ${PROTOCOL_VERSION}. Everyone in the room needs the same Ruyd release.`);
          return;
        }
        packet.peers.forEach((peer) => this.callbacks.onPeerJoined(peer));
        // The welcome is the first packet over an open channel, so the initial
        // exchange through the signaling service is complete.
        this.clientNegotiator?.arm();
        onWelcome(packet.hostName);
      } else if (packet.type === 'peer_joined') {
        this.callbacks.onPeerJoined(packet.name);
      } else if (packet.type === 'peer_left') {
        this.callbacks.onPeerLeft(packet.name);
      } else if (packet.type === 'chat') {
        this.callbacks.onChat(packet.name, packet.text);
      } else if (packet.type === 'negotiate') {
        void this.clientNegotiator?.accept(packet.signal);
      }
    });
    channel.addEventListener('close', () => {
      if (this.mode === 'client' && this.clientChannel === channel) {
        this.dropped('The direct connection to the host ended.');
      }
    });
  }

  private removeHostPeer(peerId: string): void {
    const peer = this.hostPeers.get(peerId);
    if (!peer) return;
    this.hostPeers.delete(peerId);
    peer.negotiator?.close();
    peer.channel?.close();
    peer.connection.close();
    if (peer.announced) {
      this.callbacks.onPeerLeft(peer.name);
      this.hostPeers.forEach((candidate) => send(candidate.channel, { type: 'peer_left', name: peer.name }));
    }
  }

}
