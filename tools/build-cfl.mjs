import { cpSync, mkdirSync } from "node:fs";
// Bun's file dependency is copied during install, before contracts compilation.
mkdirSync("node_modules/@lamplit/contracts/dist", { recursive: true });
cpSync(
  "vendor/lamplit-contracts/dist",
  "node_modules/@lamplit/contracts/dist",
  { recursive: true },
);
