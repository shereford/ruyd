/**
 * Moves tunnel frames between the peers and the desktop shell.
 *
 * The shell owns the sockets; the WebView owns the data channels. Frames cross between
 * them, and how they cross was chosen deliberately. Tauri's `Channel` pushes bytes to a
 * WebView by serialising them to a JSON array and evaluating it as JavaScript source
 * below a one-kilobyte threshold, or by performing a whole extra round trip above it. A
 * game packet lands either side of that line, so neither direction uses it: frames are
 * pushed with a raw request body and pulled with a call that is held open until there is
 * something to answer with.
 */
import type { DirectConnectivity } from './connectivity';

const ENVELOPE_HEADER = 6;
/** Frame kind 1 is a datagram, and the only kind carried unreliably. */
const KIND_DATAGRAM = 1;

export type Metrics = {
  datagramsOut: number;
  datagramsIn: number;
  bytesOut: number;
  bytesIn: number;
  dropped: number;
  streamsOpened: number;
  sessionsOpened: number;
};

async function command<T>(name: string, args?: unknown): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke(name, args as never)) as T;
  } catch {
    // Running outside Tauri, or the shell refused. The caller treats this as unavailable.
    return null;
  }
}

function envelope(peer: number, frame: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(ENVELOPE_HEADER + frame.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, peer);
  view.setUint32(2, frame.length);
  bytes.set(frame, ENVELOPE_HEADER);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** Splits a batch of envelopes. Stops at anything malformed rather than guessing. */
export function unwrapEnvelopes(buffer: ArrayBuffer): { peer: number; frame: Uint8Array }[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const out: { peer: number; frame: Uint8Array }[] = [];
  let at = 0;
  while (at + ENVELOPE_HEADER <= bytes.length) {
    const peer = view.getUint16(at);
    const length = view.getUint32(at + 2);
    at += ENVELOPE_HEADER;
    if (at + length > bytes.length) break;
    out.push({ peer, frame: bytes.subarray(at, at + length) });
    at += length;
  }
  return out;
}

export class GameTunnel {
  private running = false;
  private sending = false;
  private outbox: Uint8Array[] = [];

  constructor(private readonly connectivity: DirectConnectivity) {}

  /** True once the shell has answered at least one call. */
  available = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.drain();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.outbox = [];
    await command('tunnel_reset');
  }

  /** Offers a game running on this machine to the room. */
  async share(forward: number, port: number): Promise<boolean> {
    return (await command<null>('tunnel_share', { forward, port })) !== undefined;
  }

  /**
   * Binds the address this player's game connects to, and answers with it.
   * Returns null when the shell could not bind, usually because the port is in use.
   */
  async open(peer: number, forward: number, slot: number, port: number): Promise<string | null> {
    return command<string>('tunnel_open', { peer, forward, slot, port });
  }

  async close(peer: number, forward?: number): Promise<void> {
    await command('tunnel_close', { peer, forward: forward ?? null });
  }

  async metrics(): Promise<Metrics | null> {
    return command<Metrics>('tunnel_metrics');
  }

  /** Frames arrived from a peer over a data channel. */
  accept(peer: number, data: ArrayBuffer): void {
    if (!this.running) return;
    this.outbox.push(envelope(peer, new Uint8Array(data)));
    void this.flush();
  }

  /**
   * Sends what is queued. While a send is in flight everything else accumulates, so a
   * burst costs one crossing instead of one per packet, and an idle tunnel adds no delay.
   */
  private async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.running && this.outbox.length) {
        const batch = concat(this.outbox.splice(0, this.outbox.length));
        await command('tunnel_send', batch);
      }
    } finally {
      this.sending = false;
    }
  }

  /** Keeps exactly one call outstanding, answered as soon as the shell has a frame. */
  private async drain(): Promise<void> {
    while (this.running) {
      const answer = await command<ArrayBuffer>('tunnel_drain');
      if (answer === null) {
        // No shell to talk to. Nothing here can work, so stop rather than spin.
        this.running = false;
        this.available = false;
        return;
      }
      this.available = true;
      for (const { peer, frame } of unwrapEnvelopes(answer)) {
        this.connectivity.sendTunnel(peer, frame, frame[0] !== KIND_DATAGRAM);
      }
    }
  }
}
