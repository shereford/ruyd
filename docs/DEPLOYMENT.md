# Deployment and testing

## Local two-computer chat

1. On a machine reachable by both players, run `npm ci && npm run build && npm start`.
2. Allow TCP port 8787 through that machine's firewall.
3. Build each desktop app with `VITE_SIGNAL_URL=ws://SERVER_IP:8787 npm run tauri build`.
4. Start hosting on one PC and paste its invite code into the other.
5. Open **Test chat** on both machines. Messages and presence are real and travel through the signaling service.

## Internet deployment

The repository includes a Dockerfile and Render blueprint. Deploy it behind TLS, then build the desktop app with a `wss://` URL:

```powershell
$env:VITE_SIGNAL_URL = "wss://ruyd.example.com"
npm run tauri build
```

Set `RUYD_ORIGINS=tauri://localhost` on the server. Room state is intentionally in memory: restarting the server closes every room and clears all invite secrets.

## Windows game tunnel

The native shell exposes three commands: `network_status`, `install_tunnel`, and `remove_tunnel`. They integrate with the signed WireGuard for Windows service and never modify the default route. WireGuard must be installed on the player PC and tunnel installation requires Windows elevation.

The current release does not yet generate and exchange WireGuard keys/endpoints automatically. The signaling protocol already carries opaque peer `signal` messages for that negotiation, but production NAT traversal and relay infrastructure require a public UDP endpoint and operational credentials. Do not describe the game tunnel as working until that remaining integration is completed and tested across two Windows networks.

## Verification

```bash
npm test
npm run build
npm audit --omit=dev
```

GitHub Actions also compiles the Tauri application on Windows and publishes MSI/NSIS artifacts for each successful workflow run.
