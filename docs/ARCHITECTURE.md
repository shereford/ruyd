# Ruyd architecture

Ruyd 0.2 is a direct-only WebRTC chat MVP. Its public infrastructure introduces peers and helps them discover direct paths; it never relays chat traffic.

## Current components

- **Desktop shell (Tauri):** owns the Windows tray, close-to-background lifecycle, installers, and WebView2 window.
- **Web client:** creates WebRTC peer connections, authenticated invite strings, room state, peer lists, and chat messages.
- **Signaling API (`connect.ruyd.us`):** exchanges short-lived SDP offers and answers through API Gateway, Lambda, and DynamoDB.
- **STUN endpoint (`stun.ruyd.us:3478`):** reports the public UDP address observed for a client. Coturn runs in STUN-only mode.
- **Host peer:** creates the room, answers each peer offer, and fans chat messages between direct data channels when more than two people participate.

There is deliberately no TURN service or other media/data relay in the community edition.

## Connection sequence

1. The host creates a random room identifier, host token, and invite verifier.
2. The signaling service stores only SHA-256 digests of the host token and invite verifier.
3. A joining peer creates a WebRTC offer containing gathered local and server-reflexive ICE candidates and submits it with the invite verifier.
4. The host polls for the offer, creates an answer, and posts that answer using its host token.
5. Both WebRTC agents run ICE connectivity checks. If a viable direct candidate pair is found, DTLS establishes the encrypted data channel.
6. Signaling is no longer in the chat data path. The host forwards multi-party chat messages over its individual peer data channels.

Inactive rooms and peer descriptions expire after one hour. Authenticated polling renews a running host's room as expiry approaches. Stopping the host closes the room immediately and deletes its peer records. DynamoDB TTL deletion itself is asynchronous, so expired records may remain internally for a short period but cannot be used.

## Invite codes

A `RUYD2-` connection string contains a version, a random room identifier, and at least 192 bits of random invite secret material. It is a temporary room credential and should be shared only with intended participants.

The connection string does not contain a private or public IP address. Earlier `RUYD1` connection strings from the TCP prototype are intentionally rejected.

## Privacy and security properties

- WebRTC data channels use DTLS and SCTP; chat contents are encrypted between Ruyd peers.
- The signaling API handles display names and SDP, which can contain network-address metadata, but it does not receive chat contents.
- The STUN endpoint observes source IP/port metadata but receives no chat contents.
- The user chooses a display name; the app does not read the Windows username.
- Tokens and connection strings are never intentionally logged by the Ruyd service.
- The app installs no virtual adapter or route, so it cannot reroute web browsing, Discord, or other application traffic.
- The public STUN firewall allows UDP 3478 only. TURN allocations, TCP, TLS, DTLS, and the Coturn CLI are disabled.
- Closing the UI window hides it; choosing Quit from the tray exits the process and ends the room.

## Availability and recovery

WebRTC can recover from some short-lived packet loss or candidate-pair disruption without app involvement. Ruyd 0.2 does not yet perform an ICE restart or restore a room after the peer connection reaches a failed state; users reconnect with the room string.

Because no relay is configured, some combinations of symmetric NAT, carrier-grade NAT, enterprise firewall, VPN policy, or UDP blocking will fail even though both users have ordinary internet access. Port forwarding is not part of the product. A future authenticated TURN service can provide an optional fallback while preserving direct-first ICE policy.

## Future virtual-LAN boundary

The present application is chat only. A future game-networking implementation should add a separately privileged networking service that owns a virtual adapter, per-room keys, narrow routes, firewall cleanup, and allow-listed discovery forwarding. It must never install or replace a default route. Voice should remain a separate media transport so failures or policy changes do not affect game routing.
