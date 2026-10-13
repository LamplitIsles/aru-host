# CFL Aru access node operations

This fork's supported runtime is `src/cfl/cli.mjs` on Node 24. The original full
Host operations are [historical reference](upstream/operator-reference.md).

## Configuration and startup

Build with Bun 1.3.14 (`bun install --frozen-lockfile; bun run build`). Start with
explicit `--data-dir`, `--cfl-origin`, `--base-url`; `--port` defaults to 8787 and
`--listen-host` to 127.0.0.1. The fixed CFL origin accepts only loopback HTTP.
The advertised public HTTP/HTTPS origin belongs to the operator's network/proxy.
Validate it from the phone network separately; a local test is not reachability proof.

Use a new adapter-owned data directory. Original full Host data and CFL/Codex
state cannot be passed as adapter state. The adapter stores `adapter.sqlite`
(node/device/request/mapping metadata) and private `staged-images` originals.
Corrupt state stops startup; restore a known adapter backup rather than deleting
it to force a new identity. SQLite WAL files are part of a live backup: stop this
adapter or use SQLite's backup mechanism; never copy only the live main file.

If required, `--upstream-headers-file` reads service-private JSON containing only
`authorization` and/or `cookie` string headers. Keep it outside exported state and
release archives with 0600 permissions. The phone Bearer is never forwarded upstream.

Startup prints a JSON pairing envelope and `aru://pair` link. Encode that link as
a QR with an operator-chosen local QR tool or paste the payload in the phone.
The 10-minute token is single-use. Avoid exposing startup logs to other users.
Reissue locally with `node aru-selfhostctl pairing /path/to/adapter-data`; construct
the same envelope/link with the retained serverId and public origin. List devices
with `node aru-selfhostctl devices ...`; revoke with
`node aru-selfhostctl revoke /path/to/adapter-data DEVICE_ID`. HTTP revoke is
also available to an authenticated paired phone. Repeated revoke is idempotent.

## Phone protocol

| Route | Authentication | Behavior |
| --- | --- | --- |
| `GET /.well-known/aru.json` | public | narrow collaborator text/image capability |
| `POST /aru/v1/pair` | single-use bootstrap | device credential grant |
| `GET /aru/v1/diagnostics` | device Bearer | upstream availability and session conflict |
| `GET /aru/v1/devices`; `POST /aru/v1/devices/revoke` | device Bearer | inventory/revoke |
| `GET /aru/v1/hosted-collaborators`; `GET /:collaboratorId` | device Bearer | one existing CFL companion/name/avatar |
| `GET .../:collaboratorId/conversations`; `GET .../:conversationId` | device Bearer | one bound native conversation, recent completed messages |
| `GET .../:conversationId/messages?before=ID` | device Bearer | previous CFL page, stable anchor and order |
| `GET .../events?after=N`; `GET .../sync?after=N&version=TOKEN` | device Bearer | ordered polling projections, conditional response/reset |
| `POST .../messages` | device Bearer | `{clientRequestId,text?,attachmentIds?}`; CFL admission or unknown receipt |
| `POST .../turns/:turnId/cancel` | device Bearer | stop that mapped native turn only; unconfirmed result remains retryable |
| `POST .../attachments` | device Bearer | `{clientUploadId,kind:"image",filename,mimeType,byteCount,sha256}` admission |
| `PUT .../attachments/:id/content`; `GET .../attachments/:id/content` | device Bearer | stage verified original / read staged or CFL original |
| `DELETE .../attachments/:id` | device Bearer | remove own unbound staging only |

Unsupported Aru operations return HTTP 501 `capability.unsupported`. No empty
cognition/initiative/provider/MCP projection is supplied. The catalog does not
create, delete or archive companions/conversations. `approvalMode: always_allow`
is the Aru wire representation of CFL's `approvalPolicy: never`. Tool access is
upstream-owned, uneditable and unprotected by phone confirmation; this adapter
has no local MCP tool catalog or additional tool permission enforcement.

Image-only requests may omit `text` or supply `null`/`""`; these normalize to the
same empty text before validation, fingerprinting and submission. Other non-string
text values are rejected.

Request identity is scoped to the paired device, preserved through restart and
mapped to a durable UUID. Identical repeated inputs only call lookup; changed input
with the same ID is rejected. Null/failed transport lookup is unknown, not permission
to resend. Inspect CFL before creating a new intent. A submitted receipt survives a
later reply failure; it must not be interpreted as successful completion. Host shutdown
or phone disconnection leaves accepted upstream work running.

CFL views page 30 rows; an in-memory 512-event window serves sync. Versions include
a process epoch; restart/expired cursors return a recent reset, not an empty history.
History pages use persistent opaque anchor mappings. Message position, timestamp,
completed bubbles and external source labels are preserved. No assistant streaming
placeholder or per-tool execution UI is fabricated. Phone polling interval is unknown.

Image limits are advertised by CFL; staging verifies hash, byte count, MIME and actual
decode. PNG/JPEG/WebP/GIF are accepted only when advertised. Original bytes and animation
are retained; JPEG preview (512 px, ≤160 kB) and model (1024 px, ≤320 kB) use the first
frame, orientation correction and a white alpha background. Unsafe dimensions over
40 million pixels, conversion failure, audio/video/files and over-limit input fail.
Temporary original bytes may remain after an unknown operation; inspect the operation
before deleting them. Bound images cannot be silently reattached to a new operation.

## Package, installation and updates

Run `./package-release.sh /tmp/aru-cfl-host.tar.gz` on the target OS/architecture.
The tarball carries runtime modules, compiled fixed contracts and production dependencies.
The builder needs Bun/network; the extracted runtime needs Node 24 and no adjacent
source checkout. Verify the SHA-256 through a trusted channel before extracting.
The script emits `release.json` with build OS/architecture; install rejects mismatch.

From the extracted package, run:

```sh
./install.sh --prefix /opt/aru-cfl --data-dir /var/lib/aru-cfl \
  --cfl-origin http://127.0.0.1:3082 --base-url https://host.example
```

Use appropriate directory permissions and the existing CFL service owner. Installer
imports/checks the candidate and existing adapter state, copies a versioned release,
preserves the `previous` pointer and activates `current` atomically. It records
configuration in `PREFIX/config.json` for operator reference. Configure the supplied
systemd unit's `User`, paths, origins, listen binding and header file through a local
service override; the installer does not register, start or restart a service.

Updates use the same explicit package install command with the same data/prefix.
Restart only this adapter under operator control, then read its manifest and paired
`/diagnostics`; confirm server/collaborator/conversation identity and bound CFL session.
On failure, stop the adapter, restore `current` to the retained `previous` release,
restart and recheck those facts. No official Host download, container/model preparation,
CFL restart, automatic resend or deployment occurs. `upgrade.sh` deliberately exits
with instructions to supply the fork package.

Self-contained Linux CI/package evidence and [real-device acceptance](device-acceptance.md) are
separate. This PR performs no real phone installation/pairing or live companion use.
