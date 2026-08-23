# Carrying game traffic

Ruyd's purpose is to make a friend on another network usable by a game that only knows how
to play on a local one. Nothing shipped so far does that: 0.3.0 carries its own chat and
says so everywhere. This document is the plan for the part that does, and the decisions
that have to be made before any of it is written.

Stage 1 is built. `src-tauri/tunnel` carries the traffic, `src-tauri/src/tunnel.rs` bridges
it to the WebView, and the room screen offers a game and hands out the address to type into
it. Stages 2 and 3 are still only a plan.

## What "LAN over the internet" actually decomposes into

It is not one capability. Games need different subsets of three, and the cost of
supporting each is wildly different.

| # | Capability | What needs it | What it costs |
| --- | --- | --- | --- |
| 1 | **Reachability** — the remote game's port is addressable | Anything with *Join by IP*, and every dedicated server | A userspace tunnel. No driver, no privileges |
| 2 | **Discovery** — UDP broadcast and multicast reach the game | LAN browsers, *Open to LAN* | A virtual network adapter. Signed driver, administrator install |
| 3 | **Non-IP protocols** — IPX and raw Ethernet | Pre-2000 titles | A layer 2 adapter. Everything in 2, plus ARP and MAC handling |

The mistake worth avoiding is treating this as a single project. **Capability 1 covers a
large share of what people actually want, and is the only one that needs no driver, no
administrator rights, and no code-signing certificate.** It can ship while the rest is
still being designed.

## Stage 1 — reachability, with no driver

Ruyd opens a local listener on the joining player's PC and forwards whatever arrives to
the far peer's loopback, where a matching connector delivers it to the game. The player
types a local address into the game's *Join by IP* box and the game is none the wiser.

- Control travels on the existing reliable data channel: the host offers a port, and
  withdraws it.
- Datagrams travel on a **channel configured unordered and unreliable**
  (`{ ordered: false, maxRetransmits: 0 }`). Game traffic is overwhelmingly UDP, and
  putting it on a reliable channel would add head-of-line blocking to exactly the packets
  that must not wait. Stream frames keep a reliable channel, because a stream that loses a
  chunk is broken rather than degraded.
- All three channels are opened when a peer joins rather than when a game is first
  offered. A channel added to a live connection would need renegotiating, and a channel
  nobody uses costs a line of SDP. Renegotiation is still what voice will need.
- **Only the room host can offer a game.** A client's traffic would have to be relayed by
  the host to reach the other clients, and this stage carries packets between two peers
  and no further.

**Presenting each peer as a distinct address.** Games frequently hardcode their port, and
the player may be running the same game locally. Each remote peer gets its own loopback
address — `127.71.0.2`, `127.71.0.3` — so the port stays exactly what the game expects and
several peers can share one without colliding.

This was confirmed on Windows before being designed in: binding and connecting to
`127.71.0.2` succeeds from an unelevated process, so no administrator rights are needed and
the fallback of one port per peer is not required. `127.71.0.0` and `127.71.0.1` are
skipped, the first being a network address and the second the real loopback the game is
probably already using.

Both UDP and TCP are bound on that address. Which one a game uses is not knowable in
advance, and binding only one produces a failure a player cannot diagnose.

What stage 1 cannot do: appear in a LAN browser. The player has to be told an address.

## Stage 2 — discovery, with a virtual adapter

[Wintun](https://www.wintun.net/) is the right driver. It is a minimal layer 3 TUN adapter
from the WireGuard project, **the prebuilt binaries are signed and explicitly redistributable
with third-party software**, and it has maintained Rust bindings. Ruyd needs no driver
signing certificate of its own for this, which removes what would otherwise be the largest
blocker.

Being layer 3, it carries IP and nothing else. That is enough for capability 2 — IPv4
broadcast and multicast are IP — but each needs deliberate handling rather than arriving
for free:

- **Subnet-directed broadcast** (`10.x.y.255`) is ordinary IP and forwards naturally.
- **Limited broadcast** (`255.255.255.255`) never leaves its interface and has to be
  translated to the subnet's broadcast address at the boundary and back.
- **Multicast** (Minecraft's LAN announcement is `224.0.2.60:4445`) needs the group joined
  and the datagrams forwarded explicitly. No IGMP snooping, just a forwarding rule.

### Privileges

Creating and configuring an adapter requires administrator rights. Every comparable
product solves this the same way and Ruyd should too: **a Windows service installed once by
the installer, running as Local System, owning the adapter**, with the unelevated app
talking to it over a local named pipe. The app is never elevated. This is what
`docs/ARCHITECTURE.md` already commits to.

The service is the highest-risk code in the product. It is privileged, it modifies the
routing table, and it survives the app. It needs its own review standard, and its
authorization on the pipe must be explicit rather than "anything local".

### Addressing

The subnet must not collide with the player's real network, which rules out the common
`192.168.0.0/16` and `10.0.0.0/8` ranges by default. `100.64.0.0/10` (RFC 6598 shared
address space) is the least-bad choice and is what Tailscale uses, but it can collide with
a carrier-grade NAT deployment. **The host should enumerate local interfaces, pick a range
that does not overlap, and tell peers which it chose**, rather than hardcoding one.

### The rule that does not bend

A Ruyd adapter carries the Ruyd subnet and nothing else. It never becomes the default
route, never carries a peer's general internet traffic, and every route and firewall rule
it adds is removed when the room ends *and* when the process dies unexpectedly. Cleanup on
the crash path matters more than on the happy path, because that is the one that strands a
machine with a broken network.

## Stage 3 — layer 2, only if a real game demands it

TAP-Windows6 gives Ethernet frames, ARP, and IPX. It is also signed and redistributable.
It is strictly more work — ARP responder, MAC learning, broadcast flooding — for a small
and ageing set of titles. **Do not build this speculatively.** The game guide pipeline
exists to find out whether anyone actually needs it.

## The decision that has to be made first

Game packets have to get from a socket or adapter, which Rust owns, onto a WebRTC data
channel, which the WebView owns. There are three ways to arrange that and they are not
equally reversible.

**A. Leave WebRTC in the WebView.** Every datagram crosses the process boundary through
Tauri IPC in both directions. No new stack, nothing rewritten, and the connection layer
that now works across real networks is untouched. The cost is a process hop and a copy per
packet, which is plausibly fine at stage 1 rates and probably not fine for a full adapter.

**B. Move WebRTC into Rust** with `webrtc-rs`. The tunnel never leaves the process. This is
the right shape for stage 2 and the wrong amount of work for stage 1: it means rewriting
`connectivity.ts`, and trading Chromium's ICE and DTLS — which has now been observed
working between two real networks — for a younger implementation.

**C. Two connections.** The WebView keeps control, chat, and voice; Rust opens a separate
peer connection for the tunnel, signalled over the existing data channel. The hot path is
in Rust and nothing is rewritten. The cost is a second ICE negotiation and a second DTLS
handshake per pair, and a confusing failure mode where one connects and the other does not.

**Built on A, instrumented.** It is the only option that proves the product idea without
committing to an architecture, and A → C is a smaller move later than B is now.

Reading Tauri's IPC before writing to it changed how A is built, and the finding is worth
recording. `Channel`, the obvious way to push bytes to a WebView, serialises a payload
under 1024 bytes into a **JSON array of numbers and injects it as JavaScript source** for
the engine to parse; above that threshold it performs a whole extra `invoke` round trip. A
game packet lands either side of that line depending on the moment. Neither is something to
do thousands of times a second, so neither direction uses `Channel`:

- **To the shell**, `tunnel_send` takes a raw request body, which is already bytes.
- **From the shell**, `tunnel_drain` is held open until there is a frame and answers with a
  raw response body. The WebView keeps exactly one call outstanding and reissues it.
- Both directions coalesce. While a send is in flight everything else accumulates, so a
  burst costs one crossing rather than one per packet, and an idle tunnel adds no delay.

The counters in the tunnel crate are what the stage 2 decision gets made against. They are
not yet surfaced in the interface.

## Sequencing

1. Verify the loopback-alias question. One short test on Windows decides stage 1's shape.
2. Stage 1 on architecture A, with measurement built in from the start.
3. Publish the measurements and choose A, B, or C for stage 2 against them.
4. The privileged service and Wintun adapter, reviewed as its own thing.
5. Layer 2 only if a guide contributor produces a game that genuinely requires it.

Authenticode signing stops being optional at step 4. A virtual network adapter installed by
an unsigned binary is what antivirus heuristics are built to catch.
