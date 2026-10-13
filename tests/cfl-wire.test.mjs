import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { fixture } from "./fixtures/cfl-chat.mjs";
import * as wire from "./fixtures/aru-wire.mjs";

// The same HTTP caller exercises source and the extracted standalone runtime.
const runtime = resolve(process.env.CFL_TEST_PACKAGE ?? ".");
const { openState, issuePairing } = await import(pathToFileURL(join(runtime, "src/cfl/state.mjs")));
const { createHost } = await import(pathToFileURL(join(runtime, "src/cfl/http.mjs")));
const { createImages } = await import(pathToFileURL(join(runtime, "src/cfl/images.mjs")));
const emissionTime = 1700000009000;
const row = (id, role = "agent", createdAt = 1700000001000) => ({
  id, role, text: `Synthetic ${id}`, createdAt, operationId: null, turnId: null,
});
async function owned(t, run) {
  const directory = mkdtempSync(join(tmpdir(), "aru-cfl-wire-"));
  let upstream, state, host;
  t.mock.method(Date, "now", () => emissionTime);
  try {
    upstream = await fixture({ images: true });
    state = openState(join(directory, "state"));
    host = createHost({ state, origin: upstream.origin, baseUrl: "http://host.example",
      imagesFactory: createImages(join(directory, "images")) });
    host.server.listen(0, "127.0.0.1"); await once(host.server, "listening");
    const base = `http://127.0.0.1:${host.server.address().port}`;
    let credential;
    const request = async (path, method = "GET", input) => {
      const response = await fetch(base + path, { method,
        headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      assert.equal(response.status, method === "POST" && path.endsWith("/messages") ? 202 : 200);
      return response.json();
    };
    wire.manifest(await request("/.well-known/aru.json"));
    const grant = await request("/aru/v1/pair", "POST", { pairingToken: issuePairing(state).token });
    wire.grant(grant);
    credential = grant.credentialSecret;
    assert.equal(grant.schema, "aru.selfhost.pairing-grant.v1");
    assert.equal(grant.credentialScope, "device"); assert.equal(grant.expiresAt, null);
    const catalog = await request("/aru/v1/hosted-collaborators");
    assert.equal(catalog.schema, "aru.selfhost.hosted-collaborator-inventory.v1");
    assert.equal(catalog.collaborators.length, 1);
    const collaborator = catalog.collaborators[0];
    wire.collaborator(collaborator);
    assert.equal(collaborator.avatarDataURL, null); assert.equal(collaborator.driverDetail, null);
    const collaboratorRoot = `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}`;
    const inventory = await request(collaboratorRoot + "/conversations");
    assert.equal(inventory.schema, "aru.selfhost.collaborator-conversation-inventory.v1");
    assert.equal(inventory.collaboratorId, collaborator.collaboratorId);
    assert.equal(inventory.conversations.length, 1);
    wire.conversation(inventory.conversations[0]);
    const root = collaboratorRoot + "/conversations/" + inventory.conversations[0].conversationId;
    await run({ upstream, request, root });
  } finally {
    await host?.close(); state?.close(); await upstream?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
async function eventually(read, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Synthetic upstream update did not reach HTTP projection");
}

test("phone HTTP: history → submit → completed bubbles → events and conditional sync", async (t) => {
  await owned(t, async ({ upstream, request, root }) => {
    const historyRows = Array.from({ length: 65 }, (_, i) => row(`history-${i}`, i % 2 ? "agent" : "user", 1700000001000 + i));
    upstream.seed(historyRows);
    await eventually(() => request(root), (c) => c.messages.length === 30);
    let history = await request(root + "/messages");
    assert.equal(history.schema, "aru.selfhost.collaborator-conversation-message-page.v1");
    const all = [...history.messages];
    while (history.hasMore) {
      history = await request(root + "/messages?before=" + history.before);
      wire.messages(history.messages); all.unshift(...history.messages);
    }
    assert.equal(all.length, 65); assert.equal(new Set(all.map((m) => m.messageId)).size, 65);
    assert.deepEqual(all.map((m) => m.createdAt), historyRows.map((m) => m.createdAt));
    assert.ok(all.every((m, i) => !i || all[i - 1].position < m.position));
    const initialEvents = await request(root + "/events?after=0");
    assert.ok(initialEvents.events.length > 0);
    const initial = await request(root + "/sync?after=0");
    assert.equal(initial.reset, true); assert.equal(initial.conversation.messages.length, 30);
    const query = (after, version) => `/sync?after=${after}&version=${encodeURIComponent(version)}`;
    wire.sync(await request(root + query(initial.cursor, initial.version)), emissionTime);
    const sent = await request(root + "/messages", "POST", { clientRequestId: "synthetic-send", text: "Synthetic outgoing" });
    assert.equal(sent.submission.state, "submitted"); assert.equal(upstream.submissions, 1);
    const active = await eventually(() => request(root), (c) => c.activeTurn !== null);
    wire.conversation(active);
    const bubbles = [row("reply-first", "agent", 1700000005000), row("reply-second", "agent", 1700000005000)]
      .map((m) => ({ ...m, turnId: "native-turn-1" }));
    upstream.complete(bubbles);
    const completed = await eventually(() => request(root), (c) => c.activeTurn === null && c.messages.at(-1)?.content === "Synthetic reply-second");
    wire.conversation(completed);
    const eventPage = await request(root + `/events?after=${initial.cursor}`);
    const delta = await request(root + query(initial.cursor, initial.version));
    assert.equal(delta.reset, false);
    assert.deepEqual(delta.conversation.messages.slice(-2).map((m) => m.content), ["Synthetic reply-first", "Synthetic reply-second"]);
    assert.deepEqual(delta.conversation.messages.slice(-2).map((m) => m.createdAt), [1700000005000, 1700000005000]);
    assert.equal(new Set(delta.conversation.messages.slice(-2).map((m) => m.messageId)).size, 2);
    assert.ok(eventPage.events.some((e) => e.kind === "turn.updated" && e.payload.turnId === null));
    // Finish the reported caller chain before decoding; prove completed rows exist on RED too.
    t.diagnostic(`submit effects=${upstream.submissions}; completed bubbles=2; initial/events/delta decoding`);
    assert.equal(initialEvents.schema, "aru.selfhost.collaborator-conversation-events.v1");
    assert.equal(initialEvents.conversationId, initial.conversationId);
    wire.events(initialEvents, emissionTime); wire.sync(initial, emissionTime);
    wire.events(eventPage, emissionTime); wire.sync(delta, emissionTime);
    assert.equal((await request(root + query(delta.cursor, delta.version))).unchanged, true);

    // Accumulate >128 events through real Chord updates, then drain with the latest version.
    const cursor = delta.cursor;
    for (let batch = 0; batch < 6; batch++) {
      const rows = Array.from({ length: 30 }, (_, i) => row(`backlog-${batch}-${i}`));
      upstream.seed(rows);
      await eventually(() => request(root), (c) => c.messages.at(-1)?.content === rows.at(-1).text);
    }
    const backlog = await request(root + query(cursor, delta.version)); wire.sync(backlog, emissionTime);
    assert.equal(backlog.events.length, 128); assert.equal(backlog.hasMore, true);
    const remaining = await request(root + query(backlog.cursor, backlog.version)); wire.sync(remaining, emissionTime);
    assert.equal(remaining.unchanged, false); assert.equal(remaining.hasMore, false);
    assert.equal(remaining.events.length, 52); assert.ok(remaining.cursor > backlog.cursor);
    assert.equal((await request(root + query(remaining.cursor, remaining.version))).unchanged, true);
    for (const path of [query(999999, remaining.version), query(remaining.cursor, "different-epoch:0")]) {
      const reset = await request(root + path); wire.sync(reset, emissionTime); assert.equal(reset.reset, true);
    }
    for (let batch = 6; batch < 18; batch++) {
      const rows = Array.from({ length: 30 }, (_, i) => row(`backlog-${batch}-${i}`));
      upstream.seed(rows);
      await eventually(() => request(root), (c) => c.messages.at(-1)?.content === rows.at(-1).text);
    }
    const expired = await request(root + query(cursor, delta.version)); wire.sync(expired, emissionTime);
    assert.equal(expired.reset, true); assert.equal(expired.conversation.messages.length, 30);
    assert.equal((await request(root + `/events?after=${cursor}`)).reset, true);
  });
});

test("phone HTTP: missing upstream image retains required attachment timestamp", async (t) => {
  await owned(t, async ({ upstream, request, root }) => {
    upstream.seed([{ ...row("missing-original"), images: [{ attachmentId: "synthetic-missing-image",
      name: "synthetic.png", mediaType: "image/png", availability: "missing" }] }]);
    const value = await eventually(() => request(root), (c) => c.messages.length === 1);
    assert.equal(value.messages[0].attachments[0].state, "missing");
    wire.messages(value.messages);
    const attachment = value.messages[0].attachments[0];
    assert.equal(attachment.createdAt, 1700000001000);
    assert.equal(attachment.byteCount, null); assert.equal(attachment.sha256, null);
    wire.messages((await request(root + "/messages")).messages);
    wire.sync(await request(root + "/sync"), emissionTime);
  });
});
