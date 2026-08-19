export const SIGNALING_URL = (import.meta.env.VITE_RUYD_SIGNALING_URL as string | undefined)?.replace(/\/$/, '') || 'https://connect.ruyd.us';
export const ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.ruyd.us:3478'] }],
  iceTransportPolicy: 'all',
};

const INVITE_PREFIX = 'RUYD2-';
const HOST_POLL_INTERVAL_MS = 3_000;
const PEER_POLL_INTERVAL_MS = 750;
const CONNECT_TIMEOUT_MS = 30_000;

type Invite = { v: 2; roomId: string; secret: string };
type Description = { type: 'offer' | 'answer'; sdp: string };
type SignalPeer = { peerId: string; name: string; offer: Description; answered: boolean };
type Packet =
  | { type: 'welcome'; hostName: string; peers: string[] }
  | { type: 'peer_joined'; name: string }
  | { type: 'peer_left'; name: string }
  | { type: 'chat'; name: string; text: string };

export type ConnectionCallbacks = {
  onPeerJoined(name: string): void;
  onPeerLeft(name: string): void;
  onChat(name: string, text: string): void;
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
    throw new Error('Ruyd could not reach its connection service. Check your internet connection and try again.');
  }
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `Connection service returned HTTP ${response.status}`);
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
  private clientConnection: RTCPeerConnection | null = null;
  private clientChannel: RTCDataChannel | null = null;

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

    let hostName = '';
    let resolveWelcome!: () => void;
    const welcome = new Promise<void>((resolve) => { resolveWelcome = resolve; });
    this.bindClientChannel(channel, (name) => {
      hostName = name;
      resolveWelcome();
    });

    connection.addEventListener('connectionstatechange', () => {
      if (this.mode !== 'client') return;
      if (connection.connectionState === 'failed') this.callbacks.onDisconnected(directFailure().message);
      if (connection.connectionState === 'closed') this.callbacks.onDisconnected('The direct connection was closed.');
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

      return {
        code: code.trim(),
        endpoint: 'Encrypted direct WebRTC channel',
        detail: `Connected directly to ${hostName}. Signaling is complete; chat traffic does not pass through Ruyd servers.`,
        hostName,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
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

  async stop(): Promise<void> {
    const closingMode = this.mode;
    this.mode = 'idle';
    this.abortController?.abort();

    if (closingMode === 'host' && this.roomId && this.hostToken) {
      void request(`/v1/rooms/${this.roomId}/close`, { hostToken: this.hostToken }).catch(() => undefined);
    }
    this.hostPeers.forEach((peer) => {
      peer.channel?.close();
      peer.connection.close();
    });
    this.hostPeers.clear();
    this.clientChannel?.close();
    this.clientConnection?.close();
    this.clientChannel = null;
    this.clientConnection = null;
    this.abortController = null;
    this.roomId = '';
    this.hostToken = '';
  }

  private async hostPollLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (this.mode === 'host' && !signal.aborted) {
      try {
        const result = await request<{ peers: SignalPeer[] }>(
          `/v1/rooms/${this.roomId}/host/poll`,
          { hostToken: this.hostToken },
          signal,
        );
        consecutiveFailures = 0;
        for (const peer of result.peers) {
          if (!peer.answered && !this.hostPeers.has(peer.peerId)) {
            void this.answerPeer(peer, signal);
          }
        }
        await delay(HOST_POLL_INTERVAL_MS, signal);
      } catch (error) {
        if (signal.aborted) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          this.callbacks.onDisconnected(error instanceof Error ? error.message : String(error));
          await this.stop();
          return;
        }
        await delay(Math.min(5_000, consecutiveFailures * 1_000), signal).catch(() => undefined);
      }
    }
  }

  private async answerPeer(peer: SignalPeer, signal: AbortSignal): Promise<void> {
    const connection = new RTCPeerConnection(ICE_CONFIGURATION);
    const hostPeer: HostPeer = { name: peer.name, connection, channel: null };
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
      send(channel, { type: 'welcome', hostName: this.name, peers: connectedPeers });
      this.callbacks.onPeerJoined(peer.name);
      this.hostPeers.forEach((candidate, id) => {
        if (id !== peerId) send(candidate.channel, { type: 'peer_joined', name: peer.name });
      });
    });
    channel.addEventListener('message', (event) => {
      const packet = this.parsePacket(event.data);
      if (packet?.type !== 'chat') return;
      const text = Array.from(packet.text.trim()).slice(0, 500).join('');
      if (!text) return;
      this.callbacks.onChat(peer.name, text);
      this.hostPeers.forEach((candidate, id) => {
        if (id !== peerId) send(candidate.channel, { type: 'chat', name: peer.name, text });
      });
    });
    channel.addEventListener('close', () => this.removeHostPeer(peerId));
  }

  private bindClientChannel(channel: RTCDataChannel, onWelcome: (hostName: string) => void): void {
    channel.addEventListener('message', (event) => {
      const packet = this.parsePacket(event.data);
      if (!packet) return;
      if (packet.type === 'welcome') {
        packet.peers.forEach((peer) => this.callbacks.onPeerJoined(peer));
        onWelcome(packet.hostName);
      } else if (packet.type === 'peer_joined') {
        this.callbacks.onPeerJoined(packet.name);
      } else if (packet.type === 'peer_left') {
        this.callbacks.onPeerLeft(packet.name);
      } else if (packet.type === 'chat') {
        this.callbacks.onChat(packet.name, packet.text);
      }
    });
    channel.addEventListener('close', () => {
      if (this.mode === 'client') this.callbacks.onDisconnected('The host ended the direct connection.');
    });
  }

  private removeHostPeer(peerId: string): void {
    const peer = this.hostPeers.get(peerId);
    if (!peer) return;
    const wasOpen = peer.channel?.readyState === 'open';
    this.hostPeers.delete(peerId);
    peer.channel?.close();
    peer.connection.close();
    if (wasOpen) {
      this.callbacks.onPeerLeft(peer.name);
      this.hostPeers.forEach((candidate) => send(candidate.channel, { type: 'peer_left', name: peer.name }));
    }
  }

  private parsePacket(value: unknown): Packet | null {
    if (typeof value !== 'string' || value.length > 10_000) return null;
    try {
      const packet = JSON.parse(value) as Record<string, unknown>;
      if (!packet || typeof packet.type !== 'string') return null;
      if (packet.type === 'welcome' && typeof packet.hostName === 'string' && Array.isArray(packet.peers) && packet.peers.every((peer) => typeof peer === 'string')) return packet as Packet;
      if ((packet.type === 'peer_joined' || packet.type === 'peer_left') && typeof packet.name === 'string') return packet as Packet;
      if (packet.type === 'chat' && typeof packet.name === 'string' && typeof packet.text === 'string') return packet as Packet;
      return null;
    } catch {
      return null;
    }
  }
}
