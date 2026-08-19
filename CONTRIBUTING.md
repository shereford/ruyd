# Contributing to Ruyd

Thank you for helping make direct connectivity easier to use. Code, documentation, testing reports, and game-guide contributions are welcome.

## Before opening an issue or pull request

- Search existing issues and pull requests for related work.
- Do not include connection strings, tokens, private IP addresses, logs containing personal data, or other credentials.
- Report security vulnerabilities privately to the repository owner instead of opening a public exploit report.
- Describe current released behavior accurately. Ruyd 0.2 is direct chat, not a virtual LAN or traffic relay.

## Pull-request workflow

1. Fork `shereford/ruyd` on GitHub.
2. Create a focused branch from the current `master` branch.
3. Make one logically scoped change.
4. Run the relevant checks.
5. Push the branch to your fork and open a pull request against `shereford/ruyd:master`.
6. Explain what changed, why it is useful, how it was tested, and any limitations.

For application changes, run:

```bash
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Windows packaging changes should also be checked with `npm run tauri build` on Windows.

## Contributing a game guide

Ruyd will need community-tested instructions because games differ in LAN discovery, direct-IP support, ports, launchers, editions, and host setup.

1. Check the [game-guide index](docs/games/README.md) and existing guide requests.
2. If no guide exists, copy [the template](docs/games/GUIDE_TEMPLATE.md) to `docs/games/<game-name>.md` using a short lowercase filename.
3. Record the game edition, launcher, game version, Ruyd version, Windows version, exact host and join steps, discovery behavior, and known limitations.
4. Label the guide **Draft** unless every verification requirement in the template has passed.
5. Add the guide to the index in `docs/games/README.md`.
6. Open a documentation pull request with test evidence that contains no personal or network-sensitive data.

A guide may be labeled **Verified** only when it has been tested successfully with a released Ruyd virtual-LAN build on at least two separate Windows PCs. Ruyd 0.2 has no virtual-LAN transport, so current research must remain clearly labeled **Draft**.

Write original instructions in your own words. Use only screenshots you created and have permission to license with the repository. Do not tell readers to disable their firewall, antivirus, or router security; document the narrow rule or setting actually required.

If you cannot write or test a guide, [request one with the game-guide issue form](https://github.com/shereford/ruyd/issues/new?template=game-guide-request.yml).

## Networking and security changes

Keep routes, firewall rules, privileges, and listening ports as narrow as possible. A future virtual adapter must never replace the system default route or capture unrelated browser, Discord, or application traffic. Document cleanup and failure behavior along with the happy path.
