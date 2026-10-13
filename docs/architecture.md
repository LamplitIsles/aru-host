# CFL Aru access architecture

Aru phones use the original Host HTTP/JSON pairing, collaborator/conversation,
attachment and cursor-polling shapes. `src/cfl/http.mjs` translates intents and
read projections through the pinned `@lamplit/contracts/client` Chord WebSocket
and CFL's public image HTTP API. CFL uses its existing official app-server.
No extra driver, conversation ledger, model process or execution queue is started.

- `state.mjs`: SQLite node identity, device hashes/revocation, request UUID and
  fingerprint, actual receipts. Atomic durable admission precedes external effects.
- `upstream.mjs`: loopback origin validation, public contract connection/subscription,
  session binding, reconnect, appearance and authenticated internal resource reads.
- `projection.mjs`: stable hashed phone IDs, native ID mappings, history anchors and
  ordered positions. Current chat/event bodies live only in a rebuildable memory
  projection. Restart changes the sync epoch and requires a recent-window reset.
- `images.mjs`: hash-checked device staging; sharp decode and first-frame JPEG
  preview/model variants; operation-bound CFL upload; authenticated original reads.
  CFL originals are the content authority after upload. Original animation is retained.
- `cli.mjs`: Node 24 entrypoint, explicit paths/origins and optional local header file.
  It prints a single-use pairing envelope/link, then subscribes to the existing session.

Read history through CFL's opaque cursor anchored to a phone message ID; paged
rows preserve timestamps, per-bubble identity and source metadata. Reminder,
Matrix and Keet inputs retain labelled origin. CFL completion is distinct from
admission; active assistant placeholders or token streaming are not invented.
The required active-turn message reference may be empty until CFL exposes a row.

The adapter stores metadata and temporary image bytes, not model history or a
second authoritative chat. The OS service owner protects the database/header file;
phone credentials and bootstrap tokens are never forwarded to CFL. Requests do
not accept upstream origins, native session selection or local filesystem paths.
All internal HTTP fetches reject redirects. Public routes expose no CFL secrets.

`vendor/lamplit-contracts` is the unchanged public package source at the actual
CFL App pin, including its Apache license. `bun run build` compiles it and prepares
the dependency copy. Packaging delivers modular runtime, compiled contracts and
production dependencies, including sharp for the builder's OS/architecture.
CI builds Linux and tests the extracted artifact with self-contained public contract fixtures.
Real CFL/native integration is a separate local test-owned fixture command.
No adjacent checkout is a deployed runtime dependency.

Original desktop/full Host source and generated fixed filenames remain available
as historical source; they are excluded from this fork's install, package and CI
main path. [Historical architecture](upstream/architecture.md) describes that
upstream implementation. Full source cleanup is deferred local work.
