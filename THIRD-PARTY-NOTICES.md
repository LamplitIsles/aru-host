# Source and runtime notices

This fork retains the Apache-2.0 license of Aevella/aru-host. Historical full Host
source is outside the supported CFL runtime, but remains attributed to upstream.

The unchanged public `@lamplit/contracts` package is included with its Apache-2.0
license and exact source provenance. Its runtime dependencies are pinned by Bun:
`@earendil-works/chord` 1.0.0 (MIT) and TypeBox 1.3.34 (MIT).
The adapter uses `ws` (MIT) and `sharp` (Apache-2.0). Distributed production
node_modules retains the packages' own LICENSE/NOTICE files and licenses for
sharp's platform-specific libvips and supporting libraries. Those notices apply
to those components independently of the root license. See each delivered package
and sharp-libvips' license directory for full texts and corresponding sources.

No CFL private Partner implementation, official native Codex binary, desktop
Console or original full-Host runtime is distributed in the CFL adapter archive.
CFL/official fake-server fixture sources are used only in test-owned verification
archives at fixed revisions; they are not part of the delivered runtime.
