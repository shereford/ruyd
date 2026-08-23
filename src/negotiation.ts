/**
 * Renegotiation over an established data channel.
 *
 * Ruyd's signaling service exchanges exactly one offer and one answer per peer, and a
 * peer's record is write-once. That is enough to open the first connection and nothing
 * more, so anything added to a connection afterwards — an audio track, and later a
 * tunnel transport — has nowhere to negotiate. Once the data channel is open the peers
 * can carry their own negotiation, which is also strictly better: it never touches a
 * Ruyd server.
 *
 * This is the WebRTC "perfect negotiation" pattern. Both sides may need to renegotiate
 * at the same moment, and the collision has to be resolved without a coin toss over the
 * network: one side is designated polite and rolls back, the other ignores the clash and
 * proceeds. Ruyd makes the host impolite, because it is negotiating with several peers
 * at once and should not be the side that yields.
 */

/** The part of RTCPeerConnection a negotiator drives. */
export type NegotiablePeer = Pick<
  RTCPeerConnection,
  | 'signalingState'
  | 'localDescription'
  | 'setLocalDescription'
  | 'setRemoteDescription'
  | 'addIceCandidate'
  | 'addEventListener'
  | 'removeEventListener'
>;

export type NegotiationSignal =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit | null };

export type NegotiatorOptions = {
  connection: NegotiablePeer;
  /** Delivers a signal to the far side. Returns false if it could not be sent. */
  send(signal: NegotiationSignal): boolean;
  /** The side that yields on a collision. Exactly one end of a pair must be polite. */
  polite: boolean;
  /** Reports a failure that ended renegotiation. The connection itself stays up. */
  onError?(error: Error): void;
};

export class Negotiator {
  private readonly connection: NegotiablePeer;
  private readonly send: (signal: NegotiationSignal) => boolean;
  private readonly polite: boolean;
  private readonly onError?: (error: Error) => void;

  /** Negotiation is inert until the data channel that carries it is open. */
  private armed = false;
  private closed = false;
  private makingOffer = false;
  private ignoringOffer = false;
  private settingRemoteAnswer = false;
  /** Candidates that arrived before a remote description existed to attach them to. */
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(options: NegotiatorOptions) {
    this.connection = options.connection;
    this.send = options.send;
    this.polite = options.polite;
    this.onError = options.onError;
    this.connection.addEventListener('negotiationneeded', this.onNegotiationNeeded);
    this.connection.addEventListener('icecandidate', this.onIceCandidate as EventListener);
  }

  /**
   * Starts carrying negotiation. Called when the data channel opens: the first offer and
   * answer went through the signaling service, and the events they raise must not be
   * answered a second time here.
   */
  arm(): void {
    this.armed = true;
  }

  close(): void {
    this.closed = true;
    this.armed = false;
    this.pendingCandidates = [];
    this.connection.removeEventListener('negotiationneeded', this.onNegotiationNeeded);
    this.connection.removeEventListener('icecandidate', this.onIceCandidate as EventListener);
  }

  private readonly onNegotiationNeeded = (): void => {
    if (!this.armed || this.closed) return;
    void this.offer();
  };

  private async offer(): Promise<void> {
    try {
      this.makingOffer = true;
      await this.connection.setLocalDescription();
      const description = this.connection.localDescription;
      if (description) this.send({ description });
    } catch (error) {
      this.fail(error);
    } finally {
      this.makingOffer = false;
    }
  }

  private readonly onIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (!this.armed || this.closed) return;
    this.send({ candidate: event.candidate ? event.candidate.toJSON() : null });
  };

  /** Applies a signal from the far side. */
  async accept(signal: NegotiationSignal): Promise<void> {
    if (this.closed) return;
    try {
      if ('description' in signal) await this.acceptDescription(signal.description);
      else await this.acceptCandidate(signal.candidate);
    } catch (error) {
      this.fail(error);
    }
  }

  private async acceptDescription(description: RTCSessionDescriptionInit): Promise<void> {
    // Stable, or already committed to applying an answer, means an incoming offer is safe.
    const ready =
      !this.makingOffer &&
      (this.connection.signalingState === 'stable' || this.settingRemoteAnswer);
    const collision = description.type === 'offer' && !ready;

    this.ignoringOffer = !this.polite && collision;
    if (this.ignoringOffer) return;

    this.settingRemoteAnswer = description.type === 'answer';
    try {
      await this.connection.setRemoteDescription(description);
    } finally {
      this.settingRemoteAnswer = false;
    }
    await this.flushCandidates();

    if (description.type === 'offer') {
      await this.connection.setLocalDescription();
      const answer = this.connection.localDescription;
      if (answer) this.send({ description: answer });
    }
  }

  private async acceptCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) {
      await this.connection.addIceCandidate(undefined);
      return;
    }
    // A candidate can arrive before the description it belongs to. Hold it rather than
    // discarding it, or the pair loses a route it was told about.
    if (!this.connection.signalingState || this.connection.signalingState === 'closed') return;
    try {
      await this.connection.addIceCandidate(candidate);
    } catch (error) {
      // An offer this side deliberately ignored takes its candidates with it.
      if (this.ignoringOffer) return;
      this.pendingCandidates.push(candidate);
      void error;
    }
  }

  private async flushCandidates(): Promise<void> {
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await this.connection.addIceCandidate(candidate);
      } catch {
        // The description moved on; the candidate is no longer meaningful.
      }
    }
  }

  private fail(error: unknown): void {
    this.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
