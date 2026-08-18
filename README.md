![Ruyd banner](docs/assets/ruyd-banner.png)

# Ruyd

[![CI](https://github.com/shereford/ruyd/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/shereford/ruyd/actions/workflows/ci.yml?query=branch%3Amaster)

Ruyd is a small, tray-first peer-to-peer app for connecting directly with friends. One person chooses **Host**, shares a connection code, and everyone else chooses **Connect**. There is no required public Ruyd server: the host's computer acts as the server for that room.

The current release is an early Windows MVP focused on direct text chat. It does **not yet provide voice chat or create a virtual LAN for games**.

## Download the latest Windows release

[**Download the latest versioned Windows release**](https://github.com/shereford/ruyd/releases/latest)

Download either the `.exe` installer or the `.msi` package. `SHA256SUMS.txt` contains the published file hashes. Release assets also include GitHub build-provenance attestations that can be checked with `gh release verify`.

These development releases are not currently Authenticode-signed. Windows may display a SmartScreen warning. Review the repository, checksums, provenance, and build workflow before installing an unsigned build.

## How to use Ruyd

### Host a room

1. Start Ruyd. It remains available from the Windows system tray when its window is closed.
2. Click **Host** and enter your display name.
3. Allow Ruyd through Windows Firewall if Windows asks. Hosting uses inbound TCP port `50177`.
4. Copy the generated connection code and send it privately to your friends.
5. Keep Ruyd running while the room is in use. If the host exits, everyone is disconnected.

Ruyd first asks the router for an automatic UPnP mapping of TCP port `50177`. If that succeeds, the room is labeled **Internet ready**. If it fails, the initial code is explicitly labeled **LAN only**. To host over the internet without UPnP, forward TCP `50177` to the host computer, click **Configure internet access**, and enter the router's public IPv4 address or a DNS hostname. A manual endpoint cannot be verified from inside the host's network, so confirm the forwarding and firewall settings before sharing the regenerated code.

### Connect to a room

1. Start Ruyd and click **Connect**.
2. Enter your display name.
3. Paste the complete connection code supplied by the host.
4. Join the room and use the chat window.

Treat connection codes like temporary passwords. Only share them with intended participants.

## Current capabilities and limitations

- Direct host-to-peer TCP chat with no required hosted Ruyd service
- Shareable, authenticated room connection codes
- Multiple chat participants and a connected-peer view
- Stable TCP port `50177` with automatic UPnP mapping when supported by the host's router
- Manual public IPv4/DNS endpoint codes for hosts who configure port forwarding
- Windows tray operation and Windows installers
- No automatic reconnection yet; reconnect manually after an interruption
- No end-to-end encryption yet; do not use the MVP for confidential conversations
- No relay fallback, so carrier-grade NAT, strict firewalls, or double NAT can still prevent internet connections
- No voice, file transfer, virtual network adapter, game traffic, or LAN broadcast forwarding yet
- Ruyd only opens its own application port and does not reroute normal web browsing, Discord, or other unrelated traffic

## Roadmap

- Improve connection resilience with heartbeats, automatic reconnect, and session recovery
- Add encrypted identity, authenticated key exchange, and end-to-end encrypted chat
- Add NAT traversal and an optional self-hosted relay/dedicated-host mode
- Add peer-to-peer voice channels, device selection, mute, and push-to-talk
- Add a virtual LAN transport and allow-listed game discovery/broadcast forwarding
- Add native **macOS** support
- Add native **Linux support for Debian-based distributions**, including Debian and Ubuntu
- Add signed, versioned releases and automatic updates

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the proposed service boundaries and threat model.

## Development

Requirements:

- Node.js 22+
- Rust stable
- The platform prerequisites for [Tauri 2](https://v2.tauri.app/start/prerequisites/)

```bash
npm install
npm run dev
npm run tauri dev
```

Build the web UI with `npm run build`. On Windows, create installers with `npm run tauri build`.

## Contributing

Issues and pull requests are welcome. Please keep security and networking changes narrowly scoped, document user-visible behavior, and avoid implying that unfinished tunnel or encryption work is production-ready.

## License

Ruyd is available under the [MIT License](LICENSE).
