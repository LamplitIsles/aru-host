#!/usr/bin/env node
import { createImages } from "./images.mjs";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { openState, issuePairing } from "./state.mjs";
import { createHost } from "./http.mjs";
const { values } = parseArgs({
  options: {
    "check-state": { type: "boolean" },
    "upstream-headers-file": { type: "string" },
    "data-dir": { type: "string" },
    "cfl-origin": { type: "string" },
    "base-url": { type: "string" },
    port: { type: "string", default: "8787" },
    "listen-host": { type: "string", default: "127.0.0.1" },
  },
});
if (values["check-state"]) {
  if (!values["data-dir"]) throw new Error("--data-dir required");
  if (existsSync(join(values["data-dir"], "adapter.sqlite")))
    openState(values["data-dir"], { readOnly: true }).close();
  process.exit(0);
}
if (!values["data-dir"] || !values["cfl-origin"] || !values["base-url"])
  throw new Error("--data-dir, --cfl-origin and --base-url required");
const publicOrigin = new URL(values["base-url"]);
if (
  !["http:", "https:"].includes(publicOrigin.protocol) ||
  publicOrigin.username ||
  publicOrigin.password ||
  publicOrigin.pathname !== "/" ||
  publicOrigin.search ||
  publicOrigin.hash
)
  throw new Error("--base-url must be an HTTP/HTTPS origin");
values["base-url"] = publicOrigin.origin;
const state = openState(values["data-dir"]);
const upstreamHeaders = values["upstream-headers-file"]
  ? JSON.parse(readFileSync(values["upstream-headers-file"], "utf8"))
  : {};
if (
  Object.entries(upstreamHeaders).some(
    ([key, value]) =>
      !["authorization", "cookie"].includes(key.toLowerCase()) ||
      typeof value !== "string" ||
      /[\r\n]/.test(value),
  )
)
  throw new Error("Only authorization/cookie upstream headers allowed");
const host = createHost({
  state,
  origin: values["cfl-origin"],
  baseUrl: values["base-url"],
  upstreamHeaders,
  imagesFactory: createImages(join(values["data-dir"], "staged-images")),
});
host.server.listen(Number(values.port), values["listen-host"], () => {
  const pairing = issuePairing(state);
  const envelope = {
    schema: "aru.selfhost.pairing-envelope.v1",
    canonicalUrl: values["base-url"],
    manifestUrl: values["base-url"] + "/.well-known/aru.json",
    serverId: state.identity.serverId,
    pairingToken: pairing.token,
    installSessionLabel: "cfl-host",
    listenUrl: `http://127.0.0.1:${host.server.address().port}`,
  };
  console.log(JSON.stringify(envelope));
  console.log("aru://pair?" + new URLSearchParams(envelope).toString());
  void host.upstream.ready().catch(() => {});
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void host.close().then(() => {
      state.close();
      process.exit();
    });
  });
