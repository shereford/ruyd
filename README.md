# Ruyd

Ruyd is a tray-first Windows app for creating a private gaming LAN with friends. The experience is intentionally tiny: one person starts hosting, shares one invite code, and everyone else pastes that code to join.

## Current MVP

- Host and join flows with a single shareable code
- Persistent room status and connected-peer view
- Copy-to-clipboard invite UX
- A basic room chat as the human-friendly connection test
- Secondary connection diagnostics for routing, topology, and LAN discovery
- Windows system tray shell that stays active when the window closes
- CGNAT virtual addressing (`100.64.0.0/10`) to avoid common home-LAN conflicts
- Responsive, dependency-light TypeScript UI

The current network service is a UI-backed prototype boundary. It does **not yet create a real tunnel**. WireGuard/Wintun, signaling, NAT traversal, and broadcast forwarding are the next engineering phase; the UI deliberately does not imply a production-secure connection until that service is integrated.

## Development

Requirements: Node.js 20+, Rust stable, and the [Tauri 2 Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run dev
npm run tauri dev
```

Build the web UI with `npm run build`, or create a Windows installer with `npm run tauri build`.

## Network implementation roadmap

1. Add an authenticated signaling service with short-lived room codes.
2. Add a privileged Windows service that owns WireGuard/Wintun lifecycle and split routes.
3. Exchange ephemeral public keys and attempt direct UDP traversal, with an encrypted relay fallback.
4. Forward allow-listed game discovery broadcasts across peers.
5. Replace simulated diagnostics with end-to-end route, peer, and discovery probes.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the service boundaries and threat model.

## License

Ruyd is available under the [MIT License](LICENSE).
