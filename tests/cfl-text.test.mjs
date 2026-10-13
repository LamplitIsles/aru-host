import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fixture } from "./fixtures/cfl-chat.mjs";
import { openState, issuePairing } from "../src/cfl/state.mjs";
import { createHost } from "../src/cfl/http.mjs";

test("pair, text, steer, lost acknowledgement, restart lookup and exact stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aru-cfl-text-"));
  const f = await fixture();
  let state, host;
  async function start() {
    state = openState(directory);
    host = createHost({
      state,
      origin: f.origin,
      baseUrl: "http://127.0.0.1:8787",
    });
    host.server.listen(0, "127.0.0.1");
    await once(host.server, "listening");
    return `http://127.0.0.1:${host.server.address().port}`;
  }
  try {
    let url = await start();
    const pairing = issuePairing(state);
    const request = async (path, method = "GET", value, credential) => {
      const response = await fetch(url + path, {
        method,
        headers: {
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          "content-type": "application/json",
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
      return { status: response.status, value: await response.json() };
    };
    const grant = await request("/aru/v1/pair", "POST", {
      pairingToken: pairing.token,
    });
    assert.equal(grant.status, 200);
    const credential = grant.value.credentialSecret;
    assert.equal(
      (await request("/aru/v1/pair", "POST", { pairingToken: pairing.token }))
        .status,
      401,
    );
    const inventory = await request(
      "/aru/v1/hosted-collaborators",
      "GET",
      null,
      credential,
    );
    assert.equal(inventory.status, 200);
    assert.equal(inventory.value.collaborators.length, 1);
    assert.equal(inventory.value.collaborators[0].approvalMode, "always_allow");
    const root = `/aru/v1/hosted-collaborators/${state.identity.collaboratorId}/conversations/${state.identity.conversationId}`;
    const send = async (id, content) =>
      request(
        root + "/messages",
        "POST",
        { clientRequestId: id, text: content },
        credential,
      );
    const first = await send("phone-1", "hello");
    assert.equal(first.value.submission.state, "submitted");
    await new Promise((r) => setTimeout(r, 100));
    const oldTurn = (await request(root, "GET", null, credential)).value
      .activeTurn.turnId;
    f.lost = true;
    const second = await send("phone-2", "steer");
    assert.equal(second.value.submission.state, "unknown");
    assert.equal(f.submissions, 2);
    await host.close();
    assert.equal(f.stopCalls, 0);
    state.close();
    url = await start();
    const recovered = await send("phone-2", "steer");
    assert.equal(recovered.value.submission.state, "submitted");
    assert.equal(f.submissions, 2);
    assert.equal((await send("phone-2", "different")).status, 409);
    assert.equal(
      (await request(root + `/turns/${oldTurn}/cancel`, "POST", {}, credential))
        .value.cancellation.stopped,
      false,
    );
    assert.equal(
      (await request(root, "GET", null, credential)).value.activeTurn !== null,
      true,
    );
    const turn = (await request(root, "GET", null, credential)).value.activeTurn
      .turnId;
    assert.equal(
      (await request(root + `/turns/${turn}/cancel`, "POST", {}, credential))
        .value.cancellation.stopped,
      true,
    );
    assert.equal(
      (await request(root + "/sync", "GET", null, credential)).value.reset,
      true,
    );
    const concurrent = await Promise.all([
      send("concurrent", "same input"),
      send("concurrent", "same input"),
    ]);
    assert.equal(
      concurrent[0].value.submission.operationId,
      concurrent[1].value.submission.operationId,
    );
    assert.equal(f.submissions, 3);
    assert.equal(
      (await request(root + "/cognition", "GET", null, credential)).status,
      501,
    );
    await request(
      "/aru/v1/devices/revoke",
      "POST",
      { deviceId: grant.value.deviceId },
      credential,
    );
    assert.equal((await request(root, "GET", null, credential)).status, 403);
  } finally {
    await host?.close();
    state?.close();
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("history paging, multi-bubble completion, external source, sync conditional and cursor reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aru-cfl-history-"));
  const f = await fixture();
  const rows = Array.from({ length: 95 }, (_, i) => ({
    id: "history-" + i,
    role: i % 2 ? "agent" : "user",
    text: "Synthetic row " + i,
    createdAt: 1700000000000 + i,
    operationId: null,
    turnId: "history-turn",
    ...(i === 94
      ? {
          source: {
            kind: "reminder",
            reminderId: "synthetic-reminder",
            occurrenceId: "synthetic-occurrence",
          },
        }
      : {}),
  }));
  f.seed(rows);
  const state = openState(directory);
  const credential = (await import("../src/cfl/state.mjs")).pair(state, {
    pairingToken: issuePairing(state).token,
  }).credentialSecret;
  const host = createHost({
    state,
    origin: f.origin,
    baseUrl: "http://127.0.0.1:8787",
  });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const root = `/aru/v1/hosted-collaborators/${state.identity.collaboratorId}/conversations/${state.identity.conversationId}`;
  const get = async (path) => {
    const response = await fetch(
      `http://127.0.0.1:${host.server.address().port}` + root + path,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const initial = await get("/sync");
    assert.equal(initial.conversation.messages.length, 30);
    assert.equal(initial.conversation.messages.at(-1).source.kind, "reminder");
    assert.match(initial.conversation.messages.at(-1).content, /CFL reminder/);
    assert.equal(
      (
        await get(
          "/sync?after=" +
            initial.cursor +
            "&version=" +
            encodeURIComponent(initial.version),
        )
      ).unchanged,
      true,
    );
    let page = await get("/messages");
    let all = page.messages;
    while (page.hasMore) {
      page = await get("/messages?before=" + page.before);
      all = [...page.messages, ...all];
    }
    assert.equal(all.length, 95);
    assert.equal(new Set(all.map((m) => m.messageId)).size, 95);
    assert.deepEqual(
      all.map((m) => m.createdAt),
      rows.map((m) => m.createdAt),
    );
    assert.ok(all.every((m, i) => !i || all[i - 1].position < m.position));
    f.seed([
      {
        id: "bubble-1",
        role: "agent",
        text: "First bubble",
        createdAt: 1700000000200,
        operationId: null,
        turnId: "complete-turn",
      },
      {
        id: "bubble-2",
        role: "agent",
        text: "Second bubble",
        createdAt: 1700000000200,
        operationId: null,
        turnId: "complete-turn",
      },
    ]);
    await new Promise((r) => setTimeout(r, 100));
    const update = await get(
      "/sync?after=" +
        initial.cursor +
        "&version=" +
        encodeURIComponent(initial.version),
    );
    assert.deepEqual(
      update.conversation.messages.slice(-2).map((m) => m.content),
      ["First bubble", "Second bubble"],
    );
    assert.ok(
      update.conversation.messages.every((m) => m.status === "completed"),
    );
    assert.equal((await get("/sync?after=999999")).reset, true);
    f.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    const reconnect = await get("");
    assert.equal(reconnect.conversationId, state.identity.conversationId);
  } finally {
    await host.close();
    state.close();
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("expired pairing, corrupt state and changed upstream session fail without replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aru-cfl-state-"));
  const f = await fixture();
  const state = openState(directory);
  const { pair } = await import("../src/cfl/state.mjs");
  const expired = issuePairing(state, Date.now() - 600000);
  assert.throws(() => pair(state, { pairingToken: expired.token }), /expired/);
  const credential = pair(state, {
    pairingToken: issuePairing(state).token,
  }).credentialSecret;
  const identity = { ...state.identity };
  const host = createHost({
    state,
    origin: f.origin,
    baseUrl: "http://127.0.0.1:8787",
  });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  try {
    await host.upstream.ready();
    f.replaceSession();
    await new Promise((r) => setTimeout(r, 100));
    const response = await fetch(
      `http://127.0.0.1:${host.server.address().port}/aru/v1/hosted-collaborators`,
      { headers: { authorization: `Bearer ${credential}` } },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(state.identity, identity);
    assert.equal(state.get("session"), "test-session");
  } finally {
    await host.close();
    state.close();
    await f.close();
  }
  try {
    const path = join(directory, "adapter.sqlite");
    writeFileSync(path, "Synthetic corrupt database");
    assert.throws(() => openState(directory));
    assert.equal(readFileSync(path, "utf8"), "Synthetic corrupt database");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
