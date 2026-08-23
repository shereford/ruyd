# Changelog

Ruyd is pre-1.0. Everyone in a room should run the same release: connection strings
and the data-channel protocol can change between minor versions.

## Unreleased

### Fixed

- **A friend who left stayed in everyone's peer list.** The host decided whether to
  announce a departure by reading the data channel's `readyState`, but the `close` event
  fires after the state is already `closed`, so the check never passed. Neither the host
  nor the remaining peers were told that anyone had left, and the peer list only ever
  grew. The host now tracks whether it announced the arrival and announces the departure
  exactly when it did.

### Changed

- The WebView runs under a Content Security Policy. It was previously disabled outright
  (`"csp": null`). Everything the app loads is packaged with it, so the policy is
  `default-src 'self'` with `https://connect.ruyd.us` as the only remote origin allowed
  anywhere, and no inline script or style. Development keeps a looser policy so the Vite
  dev server and its websocket still work.

## 0.3.0

### Added

- **Automatic reconnection.** A dropped connection is re-entered by the client itself,
  up to five times with backoff from two to fifteen seconds, keeping the room
  credential, display name, and conversation. The connection string is never needed
  twice. Recovery stops early when signaling says the room is gone or the credential
  was refused, rather than running out the attempts against a final answer.
- **Hosting survives signaling loss.** A host no longer closes its room when
  `connect.ruyd.us` becomes unreachable. Friends who are already connected chat over
  their data channels and are unaffected; only new joins need signaling. The host
  retries with backoff and says that nobody new can join.
- **Tray status and notifications.** The tray tooltip reports the room state and any
  unread count. A Windows notification is raised when a friend joins or sends a
  message, but only while the window is hidden. Unread messages are counted on the
  button that opens the chat.
- **Protocol version negotiation.** The host announces the packet-format version, and
  a client that reads a different one says both PCs need the same release instead of
  timing out with a network error.
- Escape closes the name, join, and chat dialogs.
- Ruyd explains that it is still running the first time the window is closed, because
  the close button quits most Windows applications.

### Fixed

- **Typing in the chat was destroyed by incoming messages.** Every peer event replaced
  the whole UI, so a friend's message erased any half-typed reply along with focus.
  Drafts and the caret now survive, and a failed send keeps the text so it can be
  retried.
- **`npm run tauri dev` never worked.** The Tauri `devUrl` expected port 1420 while
  Vite served its default 5173, so the documented development workflow could not
  start.
- **The copy button could fail silently.** The clipboard write had no error handling
  and the Tauri clipboard plugin it depended on was unreachable, having no capability
  granted. There is now a fallback chain ending in a selectable field with the full
  connection string.
- **Connection errors rendered unstyled.** The `.error-banner` class used by every
  failure message on the home screen had no CSS rule at all.
- **A dropped room leaked its conversation into the next one.** Messages were not
  cleared on disconnect, so a new room opened its chat pre-populated with the previous
  room's transcript.
- **Two friends with the same display name collapsed into one.** Names are the only
  identity the data-channel protocol carries, so a duplicate merged both people into a
  single peer entry and either one leaving removed both. The host now numbers a later
  arrival, `Sam (2)`, before announcing them. Clients receive names that are already
  unique, so this needs no protocol change.
- A peer whose offer could not be answered made the host build a new peer connection
  every three seconds for the life of the room. Answers are now capped at three
  attempts per peer, and a host answers at most sixteen peers at once.

### Changed

- **The app no longer contacts any third party.** DM Sans and Manrope were being
  fetched from `fonts.googleapis.com` on every launch, which was undisclosed and lost
  the typography offline. Both are now bundled.
- `src-tauri/Cargo.lock` is committed and enforced with `--locked`, so a release
  builds the dependency graph that was reviewed. That is what the published
  build-provenance attestations are worth attesting to.
- The version shown in the UI is injected from `package.json` rather than hardcoded.

## 0.2.0

Direct WebRTC connectivity. `RUYD2-` connection strings, encrypted data channels
between peers, public signaling and STUN path discovery with no port forwarding, and
multi-party rooms fanned out by the host. Replaces the `RUYD1` TCP prototype, whose
connection strings are intentionally rejected.

## 0.1.2

Chat message delivery fixes and generic release notes.

## 0.1.0

First Windows build.
