import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join } from "node:path";
import sharp from "sharp";
import { messages } from "./aru-wire.mjs";
import { digest } from "../../src/cfl/state.mjs";
import { fixture } from "./cfl-chat.mjs";

// Public contract fixture only: this is not real CFL/native app-server evidence.
export async function processAcceptance(entry, directory) {
  const upstream = await fixture({ images: true });
  let child, lines, credential, url, envelope;
  const data = join(directory, "runtime-state");
  async function start() {
    child = spawn(
      process.execPath,
      [
        entry,
        "--data-dir",
        data,
        "--cfl-origin",
        upstream.origin,
        "--base-url",
        "http://host.example:8787",
        "--port",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    lines = createInterface({ input: child.stdout });
    envelope = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Process startup timeout: " + errors)),
        10000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error("Process exited: " + code + " " + errors));
      });
      lines.on("line", (line) => {
        if (line.startsWith("{")) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        }
      });
    });
    url = envelope.listenUrl;
  }
  async function stop() {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    lines?.close();
  }
  async function request(path, method = "GET", value, raw = false) {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        "content-type": raw ? "application/octet-stream" : "application/json",
      },
      ...(value !== undefined
        ? { body: raw ? value : JSON.stringify(value) }
        : {}),
    });
    const result = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  try {
    await start();
    const grant = await request("/aru/v1/pair", "POST", {
      pairingToken: envelope.pairingToken,
    });
    credential = grant.credentialSecret;
    const collaborator = (await request("/aru/v1/hosted-collaborators"))
      .collaborators[0];
    const conversation = (
      await request(
        `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations`,
      )
    ).conversations[0];
    const root = `/aru/v1/hosted-collaborators/${collaborator.collaboratorId}/conversations/${conversation.conversationId}`;
    const images = [],
      originals = [];
    for (const format of ["png", "jpeg", "webp", "gif"]) {
      const bytes = await sharp({
        create: { width: 24, height: 16, channels: 3, background: "#aaccee" },
      })
        .toFormat(format)
        .toBuffer();
      originals.push(bytes);
      const attachment = await request(root + "/attachments", "POST", {
        clientUploadId: format,
        kind: "image",
        filename: `synthetic.${format}`,
        mimeType: "image/" + format,
        byteCount: bytes.length,
        sha256: digest(bytes),
      });
      await request(attachment.downloadPath, "PUT", bytes, true);
      images.push(attachment.attachmentId);
    }
    upstream.lost = true;
    const input = {
      clientRequestId: "process-images",
      attachmentIds: images,
    };
    const first = await request(root + "/messages", "POST", input);
    assert.equal(first.submission.state, "unknown");
    await stop();
    assert.equal(upstream.stopCalls, 0);
    await start();
    assert.equal(envelope.serverId, grant.serverId);
    const uploads = upstream.uploadCalls;
    for (const patch of [{}, { text: null }, { text: '' }]) {
      const recovered = await request(root + '/messages', 'POST', { ...input, ...patch });
      assert.equal(recovered.submission.state, 'submitted');
      assert.equal(recovered.submission.operationId, first.submission.operationId);
    }
    assert.equal(upstream.uploadCalls, uploads);
    for (const text of ['Changed caption', 12, false, {}]) {
      const response = await fetch(url + root + '/messages', { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...input, text }) });
      assert.equal(response.status, typeof text === 'string' ? 409 : 400);
    }
    assert.equal(upstream.submissions, 1);
    const page = await request(root + "/messages");
    messages(page.messages);
    const attachments = page.messages.at(-1).attachments;
    assert.equal(attachments.length, 4);
    for (let i = 0; i < attachments.length; i++) {
      assert.deepEqual(
        await request(attachments[i].downloadPath),
        originals[i],
      );
      assert.equal(attachments[i].sha256, digest(originals[i]));
    }
    for (const image of upstream.uploaded) {
      assert.ok(Buffer.from(image.preview, "base64").length <= 160000);
      assert.ok(Buffer.from(image.model, "base64").length <= 320000);
      assert.equal(
        (await sharp(Buffer.from(image.preview, "base64")).metadata()).format,
        "jpeg",
      );
    }
    const active = (await request(root)).activeTurn;
    assert.equal(
      (await request(root + `/turns/${active.turnId}/cancel`, "POST", {}))
        .cancellation.stopped,
      true,
    );
    const revoke = await request("/aru/v1/devices/revoke", "POST", {
      deviceId: grant.deviceId,
    });
    assert.ok(revoke.revokedAt);
    for (const [path, method, value] of [
      [root, "GET"],
      [root + "/messages", "POST", input],
      [attachments[0].downloadPath, "GET"],
    ]) {
      const response = await fetch(url + path, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
      assert.equal(response.status, 403);
    }
  } finally {
    await stop();
    await upstream.close();
  }
}
