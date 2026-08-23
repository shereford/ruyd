# Manual smoke test

Nothing in CI runs the packaged application. The workflows prove that Ruyd compiles, that its
tests pass, and that the installers build — not that the app works. Every runtime behaviour of the
desktop shell is unverified until someone installs a build and uses it.

Run this before tagging a release, and after any change to `src-tauri/`, `tauri.conf.json`, or
`src-tauri/capabilities/`.

## Getting a build

Either install the `.exe` from the [latest release](https://github.com/shereford/ruyd/releases/latest),
or, to test unreleased work, download the `ruyd-windows-installers` artifact from the most recent
`CI` run on `master`:

```bash
gh run download --repo shereford/ruyd --name ruyd-windows-installers
```

## Tier 1 — one PC, about a minute

This is the tier that catches a broken Content Security Policy, a broken capability allow list, and
a shell that will not start. Run it every time.

- [ ] The app launches and shows the home screen with its intended typography, not a system fallback
      font. A fallback font means the bundled `woff2` files did not load, which `font-src` governs.
- [ ] **Start hosting** produces a `RUYD2-` connection string.
      This is the single most important check: it proves the WebView reached
      `https://connect.ruyd.us`, which `connect-src` governs. If the policy is wrong this fails
      here, and it fails looking like an ordinary network error.
- [ ] The **Copy** button changes to `Copied`. If it shows `Retry` and a selectable field appears,
      both the Tauri clipboard command and the WebView clipboard API were refused — check
      `src-tauri/capabilities/default.json`.
- [ ] Hovering the tray icon shows `Ruyd - hosting, 0 friends connected`, not `Ruyd - ready`.
- [ ] Closing the window hides Ruyd to the tray rather than quitting, and a notification says Ruyd
      is still running.
- [ ] With the window hidden, the tray menu **Open Ruyd** brings it back with the room intact.
- [ ] **Stop hosting** returns to the home screen and the tooltip returns to `Ruyd - ready`.

If anything here fails, stop. Everything below builds on this working.

## Tier 2 — two Ruyd windows on one PC, about five minutes

Ruyd registers no single-instance guard, so a second copy can be launched and joined to the first.
Both sides discover each other through local ICE candidates. This exercises the whole protocol
without a second machine, but it does **not** exercise NAT traversal.

- [ ] Host in the first window, paste the string into **Connect** in the second, and both show the
      other in the peer list.
- [ ] Messages sent from either window arrive in the other.
- [ ] Typing a message in one window while the other sends one does **not** erase what was typed.
- [ ] Hide the receiving window, send a message from the other, and a notification appears with the
      sender's name and the text. Reopening shows an unread count on the chat button.
- [ ] Join a third time using the same display name as an existing peer. The later arrival appears
      as `Name (2)`, and both are listed separately.
- [ ] **Stop hosting** on the host. The joined window reports the room ended rather than hanging.

## Playing a game, on two Ruyd windows or two PCs

Run after any change to the tunnel. The two-window arrangement above is enough for
everything except confirming it works across real networks.

- [ ] The host enters a port and chooses **Share**. It reports that it is sharing.
- [ ] The joining side is given an address of the form `127.71.0.2:<port>`, and **Copy**
      reports `Copied`.
- [ ] Start something listening on that port on the host — a real game server is best, but
      any listener proves the path — connect to the address from the joining side, and
      traffic reaches it and comes back.
- [ ] A port that is already in use on the joining side reports that plainly rather than
      failing silently.
- [ ] **Stop sharing** removes the address from the joining side.
- [ ] Leaving the room releases the bound port: sharing again immediately afterwards works
      rather than reporting the port as busy.
- [ ] Ruyd changed nothing else. Ordinary browsing, Discord, and other applications are
      unaffected, and `ipconfig` shows no new adapter.

## Tier 3 — two PCs on separate networks

The only tier that exercises what Ruyd is actually for. Run it before a release that changed
`src/connectivity.ts`.

- [ ] A host and a friend on genuinely different networks connect and exchange messages.
- [ ] Disable the friend's network adapter for about ten seconds and re-enable it. Ruyd shows
      `Reconnecting, attempt N of 5` and re-enters the room without asking for the connection string
      again. The conversation is still on screen.
- [ ] Quit Ruyd on the host. The friend is told the room ended, and it does not retry forever.
- [ ] Nothing about the session changed the friend's ordinary web browsing, Discord, or other
      application traffic.

## Recording the result

Note the release or commit tested, the Windows version, and which tiers were run, in the pull
request or release discussion. A tier that was skipped should be said out loud rather than assumed.
