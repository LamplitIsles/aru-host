# Phone wire contract checks

The CFL adapter emits the retained Aru Host HTTP shapes. Event envelopes use
`sequence`, `kind`, `payload` and **`at`**, the time the projection emitted the
event. Message and conversation `createdAt` keep their own meaning. Historical
messages must not supply the event clock. Missing CFL image originals still
carry the message timestamp as attachment `createdAt`; unavailable byte count
and hash remain null.

`node --test tests/cfl-wire.test.mjs` exercises real adapter HTTP and the pinned
public Chord client/server with synthetic completion, temporary state and
loopback ports. It checks history, two completed reply bubbles after one submit,
message/turn events, conditional sync, backlog paging with the current version,
cursor expiry/reset and older history anchors. Its small JSON assertions derive
from the retained Host response owners, not the upstream CFL TypeScript DTOs.
`CFL_TEST_PACKAGE=/absolute/extracted/package` runs the same caller against an
extracted runtime. `bun run test` also checks image uploads/downloads, admission
recovery, stop, revocation, process startup and explicit package installation.

The bounded audit compared these owners and their public fields:

| Surface | Retained contract source | Finding |
| --- | --- | --- |
| Manifest and pairing grant | `src/server/server.mjs` manifest/pair | Existing shared field names/types and nullable grant times match; capability set is intentionally narrower. |
| Collaborator catalog | `src/host/collaborator-host.mjs` public projection | Shared identity, appearance, driver and nullable fields match. CFL driver and unsupported management/cognition require device acceptance. |
| Conversation, messages, active turn | `src/conversations/collaborator-conversations.mjs` publicConversation/publicTurn | Shared metadata, completed row fields and nullable turn times match. No speculative streaming placeholders; message references can be empty while upstream exposes no row. |
| History and sync | `src/conversations/conversation-sync.mjs` messagePage/syncProjection | Stable anchors, ordered timestamps, changed rows and bounded event pages verified. Epoch/window resets are deliberate CFL adapter behavior. |
| Event envelopes | `src/conversations/collaborator-conversations.mjs` appendEvent | Repaired `createdAt` → `at` on both emitted kinds. CFL `message.updated`/`turn.updated` payloads use mapped IDs; closed-source iOS handling of these kinds remains unknown. |
| Stop | `src/conversations/collaborator-conversations.mjs` cancelTurn | Conversation response and exact-turn evidence retained. CFL completion and stop semantics intentionally differ from original Host execution. |
| Image admission and reads | `src/conversations/attachments.mjs` publicAttachment | Repaired absent `createdAt` for missing originals. Existing process tests verify ordered uploads, original bytes and hashes; missing originals are explicitly unavailable. |

These checks establish server contract behavior, not full iOS compatibility.
The reported missing-`at` decoder failure is reproduced and repaired even with
completed reply rows present. Native completion on a user's live session and
actual device display remain separate observations. See
[device acceptance](device-acceptance.md).

The vendored TypeScript contracts constrain CFL/Chord inputs, not phone JSON.
A full adapter TypeScript conversion is outside this repair. A useful next small
step would be checked JSDoc or TypeScript for the event envelope and its two
payloads at the projection boundary, grounded in the retained Host contract.
Budget roughly half a day to one day for that boundary and a build check; this
is an estimate, not verified effort. Types catch misspelled keys only when the
correct phone contract is the source of truth. Keep HTTP JSON checks for runtime
shape and timestamp semantics. A shared authoritative phone schema and wider
DTO migration require a separate decision with the client owner.
