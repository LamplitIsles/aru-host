# CFL Aru Host

A headless Linux HTTP access node for one existing CFL companion and native session.
Aru phones retain their Host HTTP polling protocol; the adapter uses the public
Lamplit Chord client and CFL image HTTP. CFL/Codex own execution and native history.
The existing Lamplit web client continues to access that same conversation.

Text, ordered images, completed bubbles, history, steering, exact-turn stop and
receipt recovery are supported by isolated protocol tests. Unknown admissions are
looked up by their original UUID and never automatically replayed.

**Released Aru iOS compatibility remains pending.** Server and package tests are
not real-device evidence. This change does not deploy or attach a live companion.
Follow [device acceptance](docs/device-acceptance.md) before considering live use.

Node 24 and Bun 1.3.14 are required to build; the delivered package runs with Node 24.

```sh
bun install --frozen-lockfile
bun run build
./run-node.sh --data-dir /tmp/aru-cfl-example \
  --cfl-origin http://127.0.0.1:3082 --base-url http://host.example:8787
```

Use a dedicated adapter data directory and an explicit public origin. Internal CFL
connections accept loopback HTTP only. For CFL authentication, supply a private
JSON `authorization`/`cookie` header file via `--upstream-headers-file`. Default
listening is loopback; explicit LAN binding and HTTPS proxying belong to the operator.
The startup envelope/link can be encoded as a QR; pairing is single-use with a
10-minute expiry. Device hashes/revocation and node identity survive restart.

Build with `./package-release.sh /tmp/aru-cfl-host.tar.gz` on the target OS/architecture.
The archive carries compiled public contracts and production dependencies, including
native sharp. Linux CI tests source and the extracted package with self-contained public contract fixtures.
Separate local tests use fixed CFL Partner/fake official app-server for native integration. Installation/updates take explicit fork
packages and retain previous release pointers; they never fetch the original Host.

See [operator reference](docs/operator-reference.md), [architecture](docs/architecture.md),
[lifecycle](HOST-LIFECYCLE.md) and [contributing](CONTRIBUTING.md). Voice, push,
conversation/profile management, cognition, Aru initiative, MCP and workspaces are
unsupported. Approval is CFL `never`, represented as Aru `always_allow`; phone
confirmation does not protect execution. Unavailable memory is not an empty memory.

Derived from [Aevella/aru-host](https://github.com/Aevella/aru-host), retaining its
Apache-2.0 [LICENSE](LICENSE). Public contracts provenance/license is recorded
[in the vendored package](vendor/lamplit-contracts/PROVENANCE.md). Original desktop
and full Host code is retained as historical source outside this fork's main path.
