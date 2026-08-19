![Ruyd banner](docs/assets/ruyd-banner.png)

# Ruyd

[![CI](https://github.com/shereford/ruyd/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/shereford/ruyd/actions/workflows/ci.yml?query=branch%3Amaster)

Ruyd is a small, tray-first app for encrypted direct chat with friends. One person chooses **Host**, shares a connection code, and everyone else chooses **Connect**. Ruyd uses a lightweight public service to introduce the players, then sends chat traffic directly between them.

The current release is an early Windows connectivity MVP. It does **not yet provide voice chat or create a virtual LAN for games**.

## Download the latest Windows release

[**Download the latest versioned Windows release**](https://github.com/shereford/ruyd/releases/latest)

Download either the `.exe` installer or the `.msi` package. `SHA256SUMS.txt` contains the published file hashes. Release assets also include GitHub build-provenance attestations that can be checked with `gh release verify`.

Development releases are not currently Authenticode-signed, so Windows may display a SmartScreen warning. Review the repository, checksums, provenance, and build workflow before installing an unsigned build.

## How to use Ruyd

### Host a room

1. Start Ruyd and click **Start hosting**.
2. Enter a display name. Ruyd never reads your Windows username.
3. Copy the generated `RUYD2-` connection string and send it privately to your friends.
4. Leave Ruyd running. Closing the window hides it to the Windows system tray and hosting continues.
5. Use **Stop hosting** when finished, or choose **Quit Ruyd** from the tray menu.

There is no router configuration step. Do not forward a port for Ruyd.

### Connect to a room

1. Start Ruyd and click **Connect**.
2. Enter a display name.
3. Paste the complete connection string supplied by the host.
4. Wait while Ruyd discovers a direct route, then use the chat window.

Treat connection strings like temporary passwords. Inactive rooms expire after one hour. A running host renews its room automatically, and stopping the host closes it immediately.

## How connectivity works

Ruyd uses `connect.ruyd.us` only to exchange short-lived WebRTC connection descriptions. It uses `stun.ruyd.us` to discover how each router exposes the app. Once connected, WebRTC encrypts the chat data and carries it directly between the players.

This community edition has **no TURN relay**. That keeps Ruyd's bandwidth costs minimal and ensures chat traffic is not carried by a Ruyd server, but direct connectivity is not possible through every combination of corporate firewall, carrier-grade NAT, symmetric NAT, or blocked UDP. When that happens, Ruyd reports a clear direct-tunnel error; port forwarding is neither required nor offered. A future optional relay edition can handle those network combinations while continuing to prefer direct paths.

The signaling service temporarily handles display names, authenticated room records, and WebRTC connection descriptions. It does not receive message contents. See [the architecture document](docs/ARCHITECTURE.md) for details.

## Current capabilities and limitations

- Encrypted WebRTC data-channel chat with direct host-to-peer paths
- Automatic NAT discovery using Ruyd's public STUN endpoint
- Short-lived authenticated `RUYD2` connection strings
- Multiple chat participants and a connected-peer view
- Windows tray operation and close-to-background hosting
- Windows `.exe` and `.msi` installers
- No port forwarding, UPnP mapping, inbound fixed TCP port, or manual public IP setup
- No traffic relay fallback
- WebRTC can survive some brief path interruptions, but Ruyd does not yet automatically rejoin a room after a failed connection
- No voice, file transfer, virtual network adapter, game traffic, or LAN broadcast forwarding yet
- Ruyd does not install a default route or reroute web browsing, Discord, or other application traffic

Version 2 connection strings are not compatible with the earlier `RUYD1` TCP prototype. Hosts and friends should run the same current release.

## Roadmap

- Add automatic reconnect, ICE restart, connection health, and session recovery
- Add optional authenticated TURN relay access for networks where direct paths fail
- Add peer-to-peer voice channels, device selection, mute, and push-to-talk
- Add a narrowly routed virtual LAN transport and allow-listed game discovery forwarding
- Add native **macOS** support
- Add native **Linux support for Debian-based distributions**, including Debian and Ubuntu
- Add optional automatic updates and Authenticode signing

## Development

Requirements:

- Node.js 22+
- Rust stable
- The platform prerequisites for [Tauri 2](https://v2.tauri.app/start/prerequisites/)

```bash
npm install
npm test
npm run build
npm run tauri dev
```

By default the app uses `https://connect.ruyd.us`. Set `VITE_RUYD_SIGNALING_URL` at build time to test against another compatible signaling endpoint. On Windows, create installers with `npm run tauri build`.

## Contributing

Issues and pull requests are welcome. Please keep security and networking changes narrowly scoped, document user-visible behavior, and avoid implying that unfinished voice or virtual-LAN work is production-ready.

## License

Ruyd is available under the [MIT License](LICENSE).
