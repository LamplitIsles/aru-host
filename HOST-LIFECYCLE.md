# CFL access node lifecycle contract

This fork serves Aru HTTP projections of one existing CFL companion/session.
CFL and official Codex app-server retain execution, model history, tools and
compaction authority. A phone disconnect or adapter shutdown closes observation,
without stopping upstream work. Read the owners before changing these boundaries.

| Owner | Facts and transitions | Consumers |
| --- | --- | --- |
| `state.mjs` | durable node/collaborator/conversation identity; paired credential hashes, revoke; request→UUID/fingerprint and actual receipts | HTTP, operator CLI |
| `upstream.mjs` | one loopback public Chord connection; first native-session binding; availability and identity conflict | HTTP/projection |
| `projection.mjs` | rebuildable current view; ordered event window, read positions, ID and history anchor mappings | phone history/events/sync |
| `images.mjs` | device-owned staged originals, immutable content hash, operation binding, upstream image metadata | HTTP attachment/send |
| CFL/Codex | admission receipt, native source/history and exact-turn stop evidence | adapter and existing Lamplit web client |
| explicit package installer | validated OS/architecture and import closure, current/previous release pointers | operator-managed service |

Persist request UUID/fingerprint before the first image-upload or submit effect.
A repeated request only looks up that UUID. A null lookup or transport failure
means unknown: it cannot authorize resend. A durable submitted receipt proves
admission, not successful completion. Reply failure/stop comes from CFL messages.
A definite failed receipt remains separate from unknown or a failed reply.
Attachments already claimed by an operation cannot be reused in a new operation.

SQLite transactions use FULL synchronous durability. A corrupt existing database
fails startup rather than replacing identity. Identity/session/request mappings
survive restart; chat bodies are reconstructed from CFL, never stored as an
adapter-authoritative transcript. A changed native session fails closed.
An old full-Host data directory requires an explicitly separate adapter directory.

Only public CFL `stop(nativeTurnId)` with `stopped:true` confirms stop. A timeout,
false result or unavailable upstream stays unconfirmed. Persist that result for
this turn, expose retry, and never redirect it to a new active turn. CFL's existing
steer admission is the busy policy; the adapter starts no model or scheduler.

Sync is a projection with a process epoch and a bounded 512-event memory window.
The epoch change or unavailable cursor requests a recent-view reset; history remains
available through CFL. Changed message rows carry completed bubbles independently.
A conditional version never bypasses credential/session checks or drops unread
backlog. Persisted IDs, image hashes, positions and anchors contain no chat bodies.
A revoked credential rejects further reads, sends and downloads.

Package installation takes an explicit locally verified fork artifact, checks its
OS/architecture, dependency imports and existing adapter state before activation,
and retains a previous release pointer. Operator service restart, diagnosis and
traffic switching are explicit. It installs no desktop, container, provider or
native Codex. `upgrade.sh` cannot fetch upstream official Host.

Proof must reopen disk at admission/receipt boundaries and count upstream effects.
Use test-owned directories, fixture credentials and fake providers. Source checks,
packaged process checks, Linux CI and real iOS acceptance are separate claims.
The published iOS client's unknown treatment of restricted capabilities remains
pending; server tests never establish device compatibility.

The retained upstream lifecycle history is in
[docs/upstream/host-lifecycle.md](docs/upstream/host-lifecycle.md), describing the
original full Host and its historical evidence, not this fork's runtime promises.
