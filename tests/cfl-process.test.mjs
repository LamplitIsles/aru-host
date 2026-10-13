import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processAcceptance } from "./fixtures/cfl-process.mjs";
test("source CLI process: public Chord/image HTTP, receipt restart and revoked reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aru-cfl-process-"));
  try {
    await processAcceptance(resolve("src/cfl/cli.mjs"), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
