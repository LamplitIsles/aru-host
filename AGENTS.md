# Host engineering entry

Before changing installation, connection, submission, recovery, phone sync or
packaging, read [HOST-LIFECYCLE.md](HOST-LIFECYCLE.md), then the relevant owner,
focused tests and [architecture](docs/architecture.md). Preserve unrelated work.
This fork owns the CFL access adapter; CFL/Codex own execution and native history.

The Linux main path is `src/cfl/`. Compile the pinned public contracts with
`bun run build`. Existing root runtime `.mjs` files are upstream generated payloads;
when changing their retained `src/` owners, regenerate with
`node tools/build-runtime.mjs` and check with `--check` before committing.
The CFL package excludes those legacy entrypoints and desktop sources.

## Public repository privacy

Before pushing, review the full outgoing commit range, including fixtures,
documents, commit metadata and PR text. Use synthetic identities in tests.
Keep personal paths, private infrastructure, credentials and runtime records
outside Git. Never commit `.scratch/`. A clean latest tree does not remove
information from earlier commits.
