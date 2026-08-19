# Ruyd user guide

This guide describes Ruyd 0.2, the direct-chat connectivity MVP for Windows. Ruyd introduces friends across the internet and establishes encrypted WebRTC chat channels without port forwarding.

Ruyd 0.2 does not create a virtual network adapter or carry game traffic. It cannot yet make an internet-separated PC appear on a game's local network.

## What you need

- Windows 10 or Windows 11
- The same current Ruyd release on every PC
- Internet access while creating and joining a room
- A network that permits outbound HTTPS and UDP traffic

Download the current `.exe` installer or `.msi` package from the [latest release](https://github.com/shereford/ruyd/releases/latest). Development releases are not Authenticode-signed, so Windows may show a SmartScreen warning.

## Host a room

1. Open Ruyd and choose **Start hosting**.
2. Enter a display name between 2 and 24 characters.
3. Copy the complete `RUYD2-` connection string.
4. Send it privately to the friends you want to invite.
5. Leave Ruyd running while the room is in use.

Closing the main window sends Ruyd to the system tray and keeps the room running. Choose **Stop hosting** to close the room, or **Quit Ruyd** from the tray to exit completely.

## Join a room

1. Open Ruyd and choose **Connect**.
2. Enter the display name your friends should see.
3. Paste the host's complete `RUYD2-` connection string.
4. Wait for Ruyd to establish the encrypted direct connection.
5. Open the test chat and exchange messages.

Connection strings are temporary room credentials. Share them only with intended participants. Hosts and clients should use the same current release.

## Using Ruyd on the same LAN

Direct chat should work when both PCs are on the same local network. WebRTC normally selects the best direct local candidate, so chat does not need to leave the LAN after the connection is established.

Ruyd still requires internet access to create and join the room through `connect.ruyd.us`, and it uses `stun.ruyd.us` during path discovery. Ruyd 0.2 does not provide offline-LAN room discovery.

This is not virtual-LAN support. Ruyd transports only its own chat messages; it does not transport another application's TCP or UDP packets, forward game discovery broadcasts, assign a Ruyd IP address, or make a remote friend visible in a game's LAN browser.

## Privacy and network behavior

- Chat messages travel over encrypted WebRTC data channels between Ruyd peers.
- The signaling service exchanges temporary room and connection metadata but does not receive chat contents.
- The user selects a display name; Ruyd does not read the Windows username.
- Ruyd does not install a default route or redirect web browsing, Discord, or other applications.
- No port forwarding, UPnP mapping, or manual public-IP configuration is required.
- The community service has no TURN relay, so some restrictive network combinations cannot establish a direct path.

## Troubleshooting

### Ruyd cannot reach its connection service

Confirm that the PC can access `https://connect.ruyd.us/health` in a browser and that a VPN, proxy, DNS filter, or security product is not blocking it.

### A direct tunnel could not be established

Both PCs reached signaling, but WebRTC could not find a usable direct path. Temporarily disconnecting a VPN or trying another ordinary network may help. Do not forward a router port or disable the Windows Firewall. Some carrier-grade NAT, symmetric NAT, enterprise firewall, and UDP-blocking combinations will require the planned optional relay service.

### The connection string is rejected

Copy the complete `RUYD2-` string again and confirm everyone is using the current release. Older `RUYD1` strings are intentionally incompatible.

### Closing the window ended the room

Closing the window should hide Ruyd in the system tray. Choosing **Quit Ruyd**, stopping the host, signing out of Windows, or terminating the process ends the room.

## Games

Game traffic and virtual-LAN support are roadmap items. See the [game-guide index](games/README.md) for contribution and verification rules. No guide should claim working Ruyd support until it has been tested with a release that includes the virtual-LAN transport.
