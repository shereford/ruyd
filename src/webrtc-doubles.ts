/**
 * Test doubles for the browser APIs `DirectConnectivity` depends on. Nothing here is
 * bundled: no module under `src/` outside the tests imports it.
 *
 * The doubles are deliberately close to the real handshake ordering, because the bugs
 * worth catching in this code are ordering bugs. A client's channel opens when its
 * remote description is applied; a host's channel arrives afterwards as a `datachannel`
 * event that the test raises when it wants it.
 */
import { PROTOCOL_VERSION, type ConnectionCallbacks } from './connectivity';

export class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  /** Packets written to this channel, already parsed. */
  readonly sent: Record<string, unknown>[] = [];

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  /** Simulates the far side sending a packet. */
  deliver(packet: unknown) {
    const event = new Event('message') as Event & { data: string };
    event.data = typeof packet === 'string' ? packet : JSON.stringify(packet);
    this.dispatchEvent(event);
  }
}

export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  /** Welcome packet a client receives once its remote description is applied. */
  static welcome: unknown = {
    type: 'welcome',
    protocol: PROTOCOL_VERSION,
    hostName: 'Host',
    peers: ['Host'],
  };
  /** Set to fail every answer, so the host's retry cap can be observed. */
  static refuseAnswers = false;

  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'complete';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  /** The chat channel this side created. Only a joining client creates one. */
  channel: FakeDataChannel | null = null;
  /** Every channel this side created, by label. A client opens chat and two tunnels. */
  readonly channels = new Map<string, FakeDataChannel>();
  closed = false;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string) {
    const channel = new FakeDataChannel();
    this.channels.set(label, channel);
    // The welcome arrives on the chat channel; the tunnel channels carry no protocol.
    if (label === 'ruyd-chat') this.channel = channel;
    return channel as unknown as RTCDataChannel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\n' } as RTCSessionDescriptionInit;
  }

  async createAnswer() {
    if (FakePeerConnection.refuseAnswers) throw new Error('no answer');
    return { type: 'answer', sdp: 'v=0\r\n' } as RTCSessionDescriptionInit;
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description as RTCSessionDescription;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    // Only the joining client created channels; its connection completes here. A host is
    // applying an offer and still has to wait for the peer's channels to arrive.
    if (!this.channel) return;
    queueMicrotask(() => {
      if (this.closed) return;
      this.connectionState = 'connected';
      for (const channel of this.channels.values()) channel.open();
      this.channel?.deliver(FakePeerConnection.welcome);
    });
  }

  close() {
    this.closed = true;
  }

  /** Simulates the far side of an established connection going away. */
  fail() {
    this.connectionState = 'failed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  /** Simulates a joining peer opening its channel to a host. */
  receiveChannel(label = 'ruyd-chat'): FakeDataChannel {
    const channel = new FakeDataChannel();
    Object.defineProperty(channel, 'label', { value: label });
    const event = new Event('datachannel') as Event & { channel: FakeDataChannel };
    event.channel = channel;
    this.dispatchEvent(event);
    return channel;
  }
}

export function resetPeerConnections() {
  FakePeerConnection.instances = [];
  FakePeerConnection.refuseAnswers = false;
  FakePeerConnection.welcome = {
    type: 'welcome',
    protocol: PROTOCOL_VERSION,
    hostName: 'Host',
    peers: ['Host'],
  };
}

/** Records every callback as a flat string, so a test can assert on ordering. */
export function recorder() {
  const events: string[] = [];
  const callbacks: ConnectionCallbacks = {
    onPeerJoined: (peer) => events.push(`joined:${peer}`),
    onPeerLeft: (peer) => events.push(`left:${peer}`),
    onChat: (peer, text) => events.push(`chat:${peer}:${text}`),
    onReconnecting: (attempt, attempts) => events.push(`reconnecting:${attempt}/${attempts}`),
    onReconnected: () => events.push('reconnected'),
    onSignalingDegraded: (degraded) => events.push(`signaling:${degraded}`),
    onTunnelData: (peer) => events.push(`tunnel:${peer}`),
    onGameShared: (forward, port) => events.push(`share:${forward}:${port}`),
    onGameUnshared: (forward) => events.push(`unshare:${forward}`),
    onDisconnected: (reason) => events.push(`disconnected:${reason}`),
  };
  return { events, callbacks };
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
