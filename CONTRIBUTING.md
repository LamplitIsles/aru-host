# Contributing to CFL Aru Host

Use Node 24 and Bun 1.3.14. The supported Linux access runtime is in `src/cfl/`.
Keep public contracts fixed to CFL's actual App pin and preserve their license.

```sh
bun install --frozen-lockfile
bun run build
node --test tests/cfl-text.test.mjs
node tools/build-runtime.mjs --check
node tools/prepare-cfl-fixture.mjs /tmp/new-cfl-fixture /path/to/read-only-cfl-checkout
CFL_TEST_CHECKOUT=/tmp/new-cfl-fixture/checkout node --test tests/cfl-real-integration.mjs
./package-release.sh /tmp/aru-cfl-host.tar.gz
mkdir /tmp/new-cfl-package
tar -xzf /tmp/aru-cfl-host.tar.gz -C /tmp/new-cfl-package
CFL_TEST_CHECKOUT=/tmp/new-cfl-fixture/checkout CFL_ADAPTER_ENTRY=/tmp/new-cfl-package/src/cfl/cli.mjs node --test tests/cfl-real-integration.mjs
CFL_TEST_PACKAGE=/tmp/new-cfl-package node --test tests/cfl-package.test.mjs
```

Use new test-owned paths. Fixture preparation archives fixed CFL source and uses
isolated dependency caches/stores; the required third argument is an explicit read-only CFL
checkout for `git archive`. No fixture runs real Codex, paid models or live services.
Default tests are self-contained public Chord/HTTP fault and source/package process
checks; absent package paths cause a test-owned build/extraction, never a skip.
Real CFL/native integration is the explicit `cfl-real-integration.mjs` command:
missing `CFL_TEST_CHECKOUT` fails. Both source and standalone package must pass
against fixed CFL `fb37c504` locally with zero skips. Linux CI does not claim that
private native integration and requires no private archive or secret infrastructure.

Read [HOST-LIFECYCLE.md](HOST-LIFECYCLE.md) before changing admission, identity,
stop or installation. Review behavior, runtime/package closure and privacy across
all outgoing commits; use scoped Conventional Commits. No `.scratch/` in Git.
Native sharp requires matching package OS/architecture; Linux CI is Linux evidence.
Original full Host/desktop source is historical and excluded from this fork's
runtime/package/default checks. Avoid broad optional cleanup.

Real iOS acceptance remains [pending](docs/device-acceptance.md); never label
server tests as device proof or deploy/connect a live companion during development.
