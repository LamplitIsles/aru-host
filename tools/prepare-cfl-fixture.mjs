// Create a test-owned fixed CFL source archive and dependency store. Never install
// into a reference checkout. Explicit source argument is read only via git archive.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
const sha = "fb37c504754781816794d7e7dd4b5ec235d3cb50";
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !process.argv[3] || existsSync(directory))
  throw new Error(
    "Provide a new test-owned destination and an explicit local CFL source checkout",
  );
mkdirSync(directory, { recursive: true });
const archive = join(directory, "cfl.tar");
writeFileSync(
  archive,
  execFileSync("git", ["-C", resolve(process.argv[3]), "archive", sha], {
    maxBuffer: 100 * 1024 * 1024,
  }),
);
const checkout = join(directory, "checkout");
mkdirSync(checkout);
execFileSync("tar", ["-xf", archive, "-C", checkout]);
const contracts = join(checkout, ".generated/shared-app/contracts");
mkdirSync(contracts, { recursive: true });
for (const path of ["package.json", "LICENSE", "dist"])
  cpSync(resolve("vendor/lamplit-contracts", path), join(contracts, path), {
    recursive: true,
  });
const env = {
  ...process.env,
  npm_config_cache: join(directory, "npm-cache"),
  XDG_CACHE_HOME: join(directory, "cache"),
  BUN_INSTALL_CACHE_DIR: join(directory, "bun-cache"),
  PNPM_HOME: join(directory, "pnpm-home"),
  COREPACK_HOME: join(directory, "corepack"),
};
execFileSync(
  "bunx",
  [
    "pnpm@11.22.0",
    "install",
    "--frozen-lockfile",
    "--store-dir",
    join(directory, "pnpm-store"),
  ],
  { cwd: checkout, env, stdio: "inherit" },
);
console.log(checkout);
