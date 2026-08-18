# Ruyd architecture

Ruyd separates the friendly desktop experience from privileged networking.

## Components

- **Desktop shell (Tauri):** room controls, tray lifecycle, notifications, and diagnostics.
- **Windows network service:** owns Wintun, WireGuard keys, routes, firewall rules, and cleanup. The UI talks to it over an authenticated local named pipe.
- **Signaling service:** stores short-lived, hashed room secrets and exchanges encrypted peer introductions. It never receives game traffic.
- **Relay:** carries already-encrypted tunnel packets only when direct UDP connectivity fails.
- **Discovery bridge:** converts selected UDP broadcasts to peer unicasts. Port rules are explicit per game to prevent unintended local-network exposure.

## Addressing and routing

Each room receives a random `/24` inside `100.64.0.0/10`. Only that room prefix is installed as a route; Ruyd must never install or replace a default route. Before activation the service checks all interface prefixes and selects another room subnet on collision.

## Invite codes

The displayed code is a locator plus at least 128 bits of random secret material encoded for people. The signaling server stores only a verifier, expires rooms, rate-limits attempts, and never treats a short human-friendly room name as authentication by itself.

## Security invariants

- Generate WireGuard keys per device and rotate session keys per room.
- Authenticate and encrypt all peer traffic; reject packets outside the assigned room prefix.
- Run the UI without elevation. Elevate only the signed networking service/install step.
- Restore routes, adapters, and firewall rules after crashes and uninstall.
- Do not log invite secrets, private keys, public endpoints, or packet contents.
- Bind discovery forwarding only to configured ports and the virtual interface.

## Definition of “connected”

The UI may show green only after the virtual adapter is active, a peer handshake is fresh, and a bidirectional encrypted probe succeeds. LAN discovery is reported separately because tunnel reachability does not guarantee a game’s broadcast protocol is supported.
