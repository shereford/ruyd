import { describe, expect, it } from 'vitest';
import { Negotiator, type NegotiablePeer, type NegotiationSignal } from './negotiation';

/** Enough of RTCPeerConnection to drive negotiation, with the timing a test can control. */
class FakeNegotiable extends EventTarget {
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly candidates: (RTCIceCandidateInit | undefined)[] = [];
  /** Rejects candidates until a remote description has been applied, as browsers do. */
  requireDescriptionForCandidates = false;

  private held: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /** Makes the next setLocalDescription hang, so a collision can be staged. */
  hold() {
    this.held = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  resume() {
    this.release?.();
    this.release = null;
  }

  async setLocalDescription() {
    if (this.held) {
      const pending = this.held;
      this.held = null;
      await pending;
    }
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `sdp-${type}` } as RTCSessionDescription;
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescriptions.push(description);
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit) {
    if (this.requireDescriptionForCandidates && this.remoteDescriptions.length === 0) {
      throw new Error('no remote description');
    }
    this.candidates.push(candidate);
  }

  negotiationNeeded() {
    this.dispatchEvent(new Event('negotiationneeded'));
  }

  gathered(candidate: RTCIceCandidateInit | null) {
    const event = new Event('icecandidate') as Event & { candidate: unknown };
    event.candidate = candidate ? { toJSON: () => candidate } : null;
    this.dispatchEvent(event);
  }
}

const OFFER = { type: 'offer', sdp: 'remote-offer' } as RTCSessionDescriptionInit;
const ANSWER = { type: 'answer', sdp: 'remote-answer' } as RTCSessionDescriptionInit;

function build(polite: boolean) {
  const connection = new FakeNegotiable();
  const sent: NegotiationSignal[] = [];
  const negotiator = new Negotiator({
    connection: connection as unknown as NegotiablePeer,
    polite,
    send: (signal) => {
      sent.push(signal);
      return true;
    },
  });
  return { connection, negotiator, sent };
}

const descriptions = (sent: NegotiationSignal[]) =>
  sent.flatMap((signal) => ('description' in signal ? [signal.description.type] : []));

describe('negotiating over the data channel', () => {
  it('stays inert until armed', () => {
    const { connection, sent } = build(true);
    connection.negotiationNeeded();
    connection.gathered({ candidate: 'a' });
    // The first offer and answer go through the signaling service. Answering them here
    // as well would mean two negotiations for one connection.
    expect(sent).toEqual([]);
  });

  it('offers when the connection asks for renegotiation', async () => {
    const { connection, negotiator, sent } = build(true);
    negotiator.arm();
    connection.negotiationNeeded();
    await Promise.resolve();
    expect(descriptions(sent)).toEqual(['offer']);
  });

  it('answers an offer that arrives while stable', async () => {
    const { connection, negotiator, sent } = build(true);
    negotiator.arm();
    await negotiator.accept({ description: OFFER });
    expect(connection.remoteDescriptions).toEqual([OFFER]);
    expect(descriptions(sent)).toEqual(['answer']);
  });

  it('forwards gathered candidates once armed, and end of candidates too', () => {
    const { connection, negotiator, sent } = build(true);
    negotiator.arm();
    connection.gathered({ candidate: 'a' });
    connection.gathered(null);
    expect(sent).toEqual([{ candidate: { candidate: 'a' } }, { candidate: null }]);
  });

  it('applies a candidate it is given', async () => {
    const { connection, negotiator } = build(true);
    negotiator.arm();
    await negotiator.accept({ candidate: { candidate: 'b' } });
    expect(connection.candidates).toEqual([{ candidate: 'b' }]);
  });
});

describe('when both sides renegotiate at once', () => {
  it('the impolite side ignores the clashing offer and keeps its own', async () => {
    const { connection, negotiator, sent } = build(false);
    negotiator.arm();

    connection.hold();
    connection.negotiationNeeded();
    await Promise.resolve();

    await negotiator.accept({ description: OFFER });

    // Not applied, and no answer sent: this side is proceeding with its own offer.
    expect(connection.remoteDescriptions).toEqual([]);
    expect(descriptions(sent)).not.toContain('answer');

    connection.resume();
    await Promise.resolve();
  });

  it('the polite side yields and answers', async () => {
    const { connection, negotiator, sent } = build(true);
    negotiator.arm();

    connection.hold();
    connection.negotiationNeeded();
    await Promise.resolve();

    await negotiator.accept({ description: OFFER });

    expect(connection.remoteDescriptions).toEqual([OFFER]);
    expect(descriptions(sent)).toContain('answer');

    connection.resume();
    await Promise.resolve();
  });

  it('accepts an answer even while an offer is in flight', async () => {
    const { connection, negotiator } = build(false);
    negotiator.arm();
    connection.negotiationNeeded();
    await Promise.resolve();

    // An answer is never a collision; it is the reply to the offer just sent.
    await negotiator.accept({ description: ANSWER });
    expect(connection.remoteDescriptions).toEqual([ANSWER]);
  });
});

describe('candidates that arrive early', () => {
  it('are held and applied once a description exists', async () => {
    const { connection, negotiator } = build(true);
    connection.requireDescriptionForCandidates = true;
    negotiator.arm();

    await negotiator.accept({ candidate: { candidate: 'early' } });
    expect(connection.candidates).toEqual([]);

    await negotiator.accept({ description: OFFER });
    expect(connection.candidates).toEqual([{ candidate: 'early' }]);
  });
});

describe('closing', () => {
  it('stops offering and forwarding', async () => {
    const { connection, negotiator, sent } = build(true);
    negotiator.arm();
    negotiator.close();

    connection.negotiationNeeded();
    connection.gathered({ candidate: 'a' });
    await negotiator.accept({ description: OFFER });
    await Promise.resolve();

    expect(sent).toEqual([]);
    expect(connection.remoteDescriptions).toEqual([]);
  });
});
