import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { openState, issuePairing, digest } from "../src/cfl/state.mjs";
const upstreamPath = process.env.CFL_TEST_CHECKOUT;
if (!upstreamPath)
  throw new Error(
    "CFL_TEST_CHECKOUT must identify a prepared test-owned fixed CFL fixture",
  );
test(
  "real CFL Partner + fake official server: images, steer, native history, lost ack and stop",
  {},
  async () => {
    const { imageAcceptanceFixture } = await import(
      pathToFileURL(
        join(
          resolve(upstreamPath),
          "apps/partner/tests/image-send-recovery-fixture.ts",
        ),
      )
    );
    const directory = await mkdtemp(join(tmpdir(), "aru-cfl-integration-"));
    const fixture = await imageAcceptanceFixture(directory);
    let state, host, url, envelope;
    async function start() {
      const headersFile = join(directory, "test-headers.json");
      await writeFile(
        headersFile,
        JSON.stringify({ cookie: "image-fixture-owner=1" }),
        { mode: 0o600 },
      );
      const child = spawn(
        process.execPath,
        [
          process.env.CFL_ADAPTER_ENTRY ?? "src/cfl/cli.mjs",
          "--data-dir",
          join(directory, "adapter"),
          "--cfl-origin",
          fixture.origin,
          "--base-url",
          "http://127.0.0.1:8787",
          "--port",
          "0",
          "--upstream-headers-file",
          headersFile,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let errors = "";
      child.stderr.on("data", (b) => {
        errors += b;
      });
      const lines = createInterface({ input: child.stdout });
      envelope = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Adapter startup timed out: " + errors)),
          10000,
        );
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error("Adapter exited " + code + ": " + errors));
        });
        lines.on("line", (line) => {
          if (line.startsWith("{")) {
            clearTimeout(timer);
            resolve(JSON.parse(line));
          }
        });
      });
      url = envelope.listenUrl;
      state = openState(join(directory, "adapter"));
      host = {
        async close() {
          child.kill("SIGTERM");
          await once(child, "exit");
          lines.close();
        },
      };
    }
    let credential;
    async function request(path, method = "GET", value, bytes = false) {
      const response = await fetch(url + path, {
        method,
        headers: {
          authorization: `Bearer ${credential ?? ""}`,
          "content-type": bytes
            ? "application/octet-stream"
            : "application/json",
        },
        ...(value !== undefined
          ? { body: bytes ? value : JSON.stringify(value) }
          : {}),
      });
      const data = response.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.json()
        : Buffer.from(await response.arrayBuffer());
      assert.ok(response.ok, JSON.stringify(data));
      return data;
    }
    async function eventually(check) {
      const end = Date.now() + 10000;
      while (!(await check())) {
        if (Date.now() > end) throw new Error("Timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      await start();
      credential = (
        await request("/aru/v1/pair", "POST", {
          pairingToken: envelope.pairingToken,
        })
      ).credentialSecret;
      const identity = { ...state.identity };
      const root = `/aru/v1/hosted-collaborators/${identity.collaboratorId}/conversations/${identity.conversationId}`;
      assert.equal(
        (await request("/aru/v1/hosted-collaborators")).collaborators[0]
          .displayName,
        "Mica",
      );
      const originals = [],
        ids = [];
      for (const [index, format] of ["png", "jpeg", "webp", "gif"].entries()) {
        const bytes = execFileSync(process.execPath, [
          "--input-type=module",
          "-e",
          `import sharp from 'sharp';process.stdout.write(await sharp({create:{width:32,height:20,channels:3,background:'#acdcff'}}).toFormat('${format}').toBuffer())`,
        ]);
        originals.push(bytes);
        const r = await request(root + "/attachments", "POST", {
          clientUploadId: "synthetic-" + index,
          kind: "image",
          filename: `photo.${format}`,
          mimeType: `image/${format}`,
          byteCount: bytes.length,
          sha256: digest(bytes),
        });
        ids.push(r.attachmentId);
        await request(
          root + `/attachments/${r.attachmentId}/content`,
          "PUT",
          bytes,
          true,
        );
      }
      const first = await request(root + "/messages", "POST", {
        clientRequestId: "images-only",
        text: "",
        attachmentIds: ids,
      });
      assert.equal(first.submission.state, "submitted");
      await eventually(async () =>
        (await fixture.action({ action: "state" })).messages.some(
          (m) => m.images?.length === 4,
        ),
      );
      const native = await fixture.action({ action: "state" });
      const uploaded = native.messages.find(
        (m) => m.operationId === first.submission.operationId,
      ).images;
      assert.deepEqual(
        uploaded.map((i) => i.mediaType),
        ["image/png", "image/jpeg", "image/webp", "image/gif"],
      );
      for (let i = 0; i < uploaded.length; i++)
        assert.deepEqual(
          await request(
            root + `/attachments/${uploaded[i].attachmentId}/content`,
          ),
          originals[i],
        );
      const captionImage = await request(root + "/attachments", "POST", {
        clientUploadId: "caption-image",
        kind: "image",
        filename: "caption.png",
        mimeType: "image/png",
        byteCount: originals[0].length,
        sha256: digest(originals[0]),
      });
      await request(
        root + `/attachments/${captionImage.attachmentId}/content`,
        "PUT",
        originals[0],
        true,
      );
      await fixture.action({ action: "mode", state: "lost" });
      const second = await request(root + "/messages", "POST", {
        clientRequestId: "steer-lost",
        text: "Synthetic steering text",
        attachmentIds: [captionImage.attachmentId],
      });
      assert.equal(second.submission.state, "unknown");
      const calls = (await fixture.action({ action: "state" })).submitCalls;
      await host.close();
      state.close();
      await start();
      assert.deepEqual(state.identity, identity);
      const receipt = await request(root + "/messages", "POST", {
        clientRequestId: "steer-lost",
        text: "Synthetic steering text",
        attachmentIds: [captionImage.attachmentId],
      });
      assert.equal(receipt.submission.state, "submitted");
      assert.equal(
        (await fixture.action({ action: "state" })).submitCalls,
        calls,
      );
      const recoveredNative = await fixture.action({ action: "state" });
      assert.equal(
        recoveredNative.messages.filter(
          (m) => m.operationId === second.submission.operationId,
        ).length,
        1,
      );
      assert.equal(
        recoveredNative.messages.find(
          (m) => m.operationId === second.submission.operationId,
        ).images.length,
        1,
      );
      await fixture.action({ action: "complete" });
      await eventually(async () =>
        (await request(root)).messages.some(
          (m) => m.content === "完整图片回复",
        ),
      );
      const completed = await request(root);
      assert.ok(completed.messages.some((m) => m.attachments.length > 0));
      await fixture.action({ action: "mode", state: "submitted" });
      await request(root + "/messages", "POST", {
        clientRequestId: "stop",
        text: "Synthetic stop target",
      });
      await eventually(async () => (await request(root)).activeTurn !== null);
      const turn = (await request(root)).activeTurn.turnId;
      const stopped = await request(root + `/turns/${turn}/cancel`, "POST", {});
      assert.equal(stopped.cancellation.stopped, true);
      const page = await request(root + "/messages");
      assert.ok(page.messages.length > 0);
      const attachment = page.messages
        .flatMap((m) => m.attachments)
        .find((a) => a.mimeType === "image/png");
      assert.ok(attachment.downloadPath);
      assert.equal(attachment.sha256.length, 64);
      assert.ok(attachment.byteCount > 0);
      const definite = await request(root + "/messages", "POST", {
        clientRequestId: "definite-failure",
        text: "拒绝输入",
      });
      assert.equal(definite.submission.state, "failed");
      await fixture.action({ action: "mode", state: "null" });
      const unknown = await request(root + "/messages", "POST", {
        clientRequestId: "unknown-null",
        text: "Synthetic unknown",
      });
      assert.equal(unknown.submission.state, "unknown");
      const unknownCalls = (await fixture.action({ action: "state" }))
        .submitCalls;
      assert.equal(
        (
          await request(root + "/messages", "POST", {
            clientRequestId: "unknown-null",
            text: "Synthetic unknown",
          })
        ).submission.state,
        "unknown",
      );
      assert.equal(
        (await fixture.action({ action: "state" })).submitCalls,
        unknownCalls,
      );
      const bad = Buffer.from("Synthetic invalid image");
      const badUpload = await request(root + "/attachments", "POST", {
        clientUploadId: "bad-image",
        kind: "image",
        filename: "bad.png",
        mimeType: "image/png",
        byteCount: bad.length,
        sha256: digest(bad),
      });
      const badResponse = await fetch(
        url + root + `/attachments/${badUpload.attachmentId}/content`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${credential}` },
          body: bad,
        },
      );
      assert.equal(badResponse.status, 400);
      const limitResponse = await fetch(url + root + "/attachments", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientUploadId: "over-limit",
          kind: "image",
          filename: "huge.png",
          mimeType: "image/png",
          byteCount: 8000001,
          sha256: "a".repeat(64),
        }),
      });
      assert.equal(limitResponse.status, 400);
      await fixture.action({ action: "disabled", enabled: true });
      await new Promise((r) => setTimeout(r, 100));
      const disabledResponse = await fetch(url + root + "/attachments", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientUploadId: "disabled",
          kind: "image",
          filename: "small.png",
          mimeType: "image/png",
          byteCount: originals[0].length,
          sha256: digest(originals[0]),
        }),
      });
      assert.equal(disabledResponse.status, 415);
      const unsupported = await fetch(url + root + "/attachments", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientUploadId: "audio",
          kind: "audio",
          mimeType: "audio/mp3",
        }),
      });
      assert.equal(unsupported.status, 415);
    } finally {
      await host?.close();
      state?.close();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
