# Security policy

## Supported versions

Ruyd is pre-1.0. Only the [latest release](https://github.com/shereford/ruyd/releases/latest)
receives fixes. Hosts and joining friends should run the same current release, because connection
strings and the signaling contract can change between minor versions.

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/shereford/ruyd/security/advisories/new).
Do not open a public issue or pull request for an unfixed vulnerability.

Please include the Ruyd version, your operating system, what an attacker can do, and the steps to
reproduce it. Do not include live connection strings, host or peer tokens, public IP addresses, or
other people's data — a redacted description is enough.

You should get an acknowledgement within a few days. Because Ruyd is maintained by a very small
team, please allow time for a fix before public disclosure, and tell us if you intend to disclose on
a fixed date.

## What is in scope

- The Ruyd Windows client in this repository.
- The `connect.ruyd.us` signaling API and the `stun.ruyd.us` STUN endpoint.
- The release pipeline, published installers, checksums, and build-provenance attestations.

## What is already known and documented

These are current design limitations rather than vulnerabilities. Reports about them are welcome as
issues, not as security advisories.

- Development releases are **not Authenticode-signed**, so Windows may show a SmartScreen warning.
  Verify installers against `SHA256SUMS.txt` and the release provenance attestations.
- A `RUYD2-` connection string is a bearer credential for its room. Anyone who obtains it before the
  room closes can join. Share it only with intended participants and stop hosting when finished.
- The signaling service necessarily handles display names and SDP, which contains network-address
  metadata. It never receives chat contents. The STUN server observes source IP and port only.
- There is no TURN relay, so no chat traffic is relayed, and some restrictive network combinations
  cannot connect at all.
- Ruyd 0.2 has no ICE restart or automatic rejoin. A failed connection has to be re-established
  manually.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full security boundary.
