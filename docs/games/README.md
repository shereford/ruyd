# Ruyd game guides

Game guides will document the exact setup needed to use individual LAN-capable games with Ruyd's planned virtual-LAN transport.

> **Current status:** Ruyd 0.2 transports direct chat only. It does not carry game packets or discovery broadcasts, so no game is currently verified for virtual-LAN play through Ruyd.

## Guides

| Game | Status | Ruyd version | Last verified |
| --- | --- | --- | --- |
| No guides yet | — | — | — |

## Help build this library

Game behavior varies by edition and launcher. Once virtual-LAN support is available, the project needs players to document and verify host setup, join steps, LAN-browser behavior, direct-IP options, required ports, and known limitations.

- [Request a guide for a game](https://github.com/shereford/ruyd/issues/new?template=game-guide-request.yml)
- [Copy the game-guide template](GUIDE_TEMPLATE.md)
- Read the [contribution instructions](../../CONTRIBUTING.md#contributing-a-game-guide)

Research drafts are welcome before the feature ships, but they must remain labeled **Draft** and must not imply that Ruyd currently carries game traffic.

## Guide status

- **Draft:** researched, incomplete, or not tested against a released Ruyd virtual-LAN build.
- **Verified:** successfully tested using the documented versions on at least two separate Windows PCs, with every verification item completed.
- **Needs retest:** previously verified, but a material Ruyd, game, launcher, or operating-system version has changed.

Verification is specific to the versions and editions named in the guide. A working Steam edition does not automatically verify a Microsoft Store, GOG, Epic, or console edition.

## Review expectations

A useful guide is reproducible, concise, and safe. It should distinguish automatic LAN discovery from manual direct-IP joining; list only required settings; include rollback instructions for any system change; and avoid telling users to disable security controls broadly.
