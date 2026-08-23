import { describe, expect, it } from 'vitest';
import { unwrapEnvelopes } from './tunnel';

function envelope(peer: number, frame: number[]): number[] {
  const header = new Uint8Array(6);
  const view = new DataView(header.buffer);
  view.setUint16(0, peer);
  view.setUint32(2, frame.length);
  return [...header, ...frame];
}

const buffer = (bytes: number[]) => new Uint8Array(bytes).buffer;

describe('frames crossing to the shell', () => {
  it('splits a batch back into frames and the peers they came from', () => {
    const batch = buffer([...envelope(0, [1, 2, 3]), ...envelope(9, [4, 5])]);
    const parts = unwrapEnvelopes(batch);
    expect(parts).toHaveLength(2);
    expect(parts[0].peer).toBe(0);
    expect(Array.from(parts[0].frame)).toEqual([1, 2, 3]);
    expect(parts[1].peer).toBe(9);
    expect(Array.from(parts[1].frame)).toEqual([4, 5]);
  });

  it('handles an empty answer, which is what an idle tunnel returns', () => {
    expect(unwrapEnvelopes(buffer([]))).toEqual([]);
  });

  it('keeps what is whole and stops at a truncated tail', () => {
    const batch = buffer([...envelope(1, [7, 7]), ...envelope(2, [8, 8]).slice(0, 7)]);
    const parts = unwrapEnvelopes(batch);
    expect(parts).toHaveLength(1);
    expect(Array.from(parts[0].frame)).toEqual([7, 7]);
  });

  it('carries a peer number that does not fit in a byte', () => {
    const parts = unwrapEnvelopes(buffer(envelope(300, [1])));
    expect(parts[0].peer).toBe(300);
  });

  it('carries an empty frame without losing the envelope after it', () => {
    const batch = buffer([...envelope(1, []), ...envelope(2, [9])]);
    const parts = unwrapEnvelopes(batch);
    expect(parts.map((part) => part.peer)).toEqual([1, 2]);
  });
});
