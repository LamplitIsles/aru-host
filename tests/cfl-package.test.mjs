import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openState } from "../src/cfl/state.mjs";
import { processAcceptance } from "./fixtures/cfl-process.mjs";
test("delivered package installs and updates explicit directories preserving identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aru-cfl-install-"));
  try {
    let packagePath = process.env.CFL_TEST_PACKAGE;
    if (!packagePath) {
      const archive = join(directory, "package.tar.gz");
      execFileSync("bash", [resolve("package-release.sh"), archive], {
        stdio: "pipe",
      });
      packagePath = join(directory, "extracted");
      mkdirSync(packagePath);
      execFileSync("tar", ["-xzf", archive, "-C", packagePath]);
    }
    const prefix = join(directory, "prefix"),
      data = join(directory, "state");
    const args = [
      join(packagePath, "install.sh"),
      "--prefix",
      prefix,
      "--data-dir",
      data,
      "--cfl-origin",
      "http://127.0.0.1:3082",
      "--base-url",
      "http://host.example:8787",
    ];
    await processAcceptance(join(packagePath, "src/cfl/cli.mjs"), directory);
    execFileSync("bash", args);
    const first = realpathSync(join(prefix, "current"));
    const state = openState(data);
    const identity = state.identity;
    state.close();
    execFileSync("bash", args);
    assert.notEqual(realpathSync(join(prefix, "current")), first);
    assert.equal(realpathSync(join(prefix, "previous")), first);
    const reopened = openState(data);
    assert.deepEqual(reopened.identity, identity);
    reopened.close();
    assert.equal(existsSync(join(prefix, "current", "src/cfl/cli.mjs")), true);
    assert.equal(existsSync(join(prefix, "current", "desktop-console")), false);
    assert.equal(
      existsSync(join(prefix, "current", "codex-app-server-driver.mjs")),
      false,
    );
    assert.equal(
      JSON.parse(readFileSync(join(prefix, "config.json"))).dataDir,
      data,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
