import { createServer } from "node:http";
import { HttpError, authenticate, pair, digest } from "./state.mjs";
import { schema, createProjection } from "./projection.mjs";
import { createUpstream } from "./upstream.mjs";
export function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export async function body(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(413, "request.too_large", "Request too large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "request.invalid_json", "JSON object required");
  }
}
export function createHost({
  state,
  origin,
  baseUrl,
  upstreamHeaders = {},
  imagesFactory,
}) {
  const projection = createProjection(state);
  const upstream = createUpstream({
    origin,
    state,
    headers: upstreamHeaders,
    changed: projection.accept,
  });
  const images = imagesFactory?.({
    state,
    upstream,
    json,
    body,
    assertDevice: (req) => authenticate(state, req),
  });
  const { collaboratorId, conversationId, serverId, createdAt } =
    state.identity;
  const root = `/aru/v1/hosted-collaborators/${collaboratorId}`;
  const conversationRoot = `${root}/conversations/${conversationId}`;
  function manifest() {
    const limits = upstream.view?.capabilities.images;
    return {
      schema: schema("manifest"),
      serverId,
      nodeKind: "local-device",
      displayName: "CFL Aru Host",
      serverVersion: "cfl-1",
      minClientVersion: "1.0",
      networkAddress: { mode: "fixed", url: baseUrl, status: "configured" },
      transportProfiles: [
        {
          id: "primary",
          priority: 10,
          kind: baseUrl.startsWith("https:") ? "public-https" : "lan",
          baseUrl,
        },
      ],
      capabilities: {
        "collaborator-host": {
          enabled: true,
          endpoint: "/aru/v1/hosted-collaborators",
          authority: "computer-host",
          clientProjection: "read-only-replica",
          phase: "computer-authoritative-conversations",
          turnExecution: upstream.status.available,
          conversationEndpoint:
            "/aru/v1/hosted-collaborators/{collaboratorId}/conversations",
          messageInputKinds: limits && images ? ["text", "image"] : ["text"],
          attachmentProtocol: schema("collaborator-conversation-attachment"),
          maximumAttachmentBytes: limits?.maxImageBytes ?? 0,
          maximumAttachmentsPerMessage: limits?.maxImagesPerMessage ?? 0,
        },
      },
      pairing: { endpoint: "/aru/v1/pair", methods: ["qr-token"] },
      diagnostics: { endpoint: "/aru/v1/diagnostics" },
    };
  }
  async function collaborator() {
    await upstream.ready();
    const appearance = await upstream.appearance();
    let avatarDataURL = null;
    if (appearance.companionAvatar) {
      // The schema admits only local /api assets. Redirects stay forbidden.
      const response = await upstream.request(appearance.companionAvatar);
      const bytes = Buffer.from(await response.arrayBuffer());
      const mime = response.headers.get("content-type")?.split(";")[0];
      if (
        bytes.length <= 2 * 1024 * 1024 &&
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)
      )
        avatarDataURL = `data:${mime};base64,${bytes.toString("base64")}`;
    }
    return {
      schema: schema("hosted-collaborator"),
      collaboratorId,
      displayName: appearance.companionName,
      avatarDataURL,
      supportsAvatarEditing: false,
      driverId: "cfl",
      driverDisplayName: "Codex for Love",
      driverDetail: null,
      providerProfileId: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      authority: "computer-host",
      clientProjection: "read-only-replica",
      activationStatus: "driver-ready",
      turnExecution: true,
      approvalMode: "always_allow",
      approvalPolicy: "never",
      toolAccess: {
        schema: schema("collaborator-tool-access"),
        mode: "all",
        toolNames: [],
        supported: false,
        enforcement: "CFL",
      },
    };
  }
  async function send(req, device) {
    const input = await body(req, 256 * 1024);
    input.text ??= "";
    if (
      Object.keys(input).some(
        (key) => !["text", "clientRequestId", "attachmentIds"].includes(key),
      )
    )
      throw new HttpError(400, "message.invalid", "Unsupported message fields");
    if (
      typeof input.clientRequestId !== "string" ||
      !input.clientRequestId.length ||
      input.clientRequestId.length > 300 ||
      typeof input.text !== "string" ||
      input.text.length > 16000 ||
      (!input.text.trim() && !input.attachmentIds?.length)
    )
      throw new HttpError(
        400,
        "message.invalid",
        "clientRequestId and text or images required",
      );
    const attachmentIds = input.attachmentIds ?? [];
    if (!Array.isArray(attachmentIds))
      throw new HttpError(400, "attachment.invalid", "Attachment IDs required");
    const ids = attachmentIds.map((a) => {
      if (typeof a !== "string")
        throw new HttpError(
          400,
          "attachment.invalid",
          "Attachment IDs must be strings",
        );
      return a;
    });
    if (input.text === "/compact" && !ids.length)
      throw new HttpError(
        501,
        "capability.unsupported",
        "Native compaction is managed by CFL",
      );
    const fingerprint = digest(
      JSON.stringify({ text: input.text, attachmentIds: ids }),
    );
    let operation = state.operation(device.deviceId, input.clientRequestId);
    if (operation && operation.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        "message.identity_conflict",
        "Request ID owns different input",
      );
    await upstream.ready();
    let receipt;
    if (operation) {
      try {
        receipt = await upstream.lookup(operation.id);
      } catch {
        receipt = null;
      }
      if (!receipt && operation.receipt)
        receipt = JSON.parse(operation.receipt);
    } else {
      if (ids.length && !images)
        throw new HttpError(
          415,
          "attachment.unsupported",
          "Images unavailable",
        );
      const prepared = ids.length ? await images.prepare(ids, device) : [];
      authenticate(state, req);
      // Persist before upload or submit. Nothing can automatically replay this intent.
      operation = state.operation(device.deviceId, input.clientRequestId);
      if (operation) {
        if (operation.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "message.identity_conflict",
            "Request ID owns different input",
          );
        try {
          receipt = await upstream.lookup(operation.id);
        } catch {
          receipt = null;
        }
      } else {
        operation = state.admit(
          device.deviceId,
          input.clientRequestId,
          fingerprint,
        );
        try {
          const refs = prepared.length
            ? await images.upload(operation.id, prepared, device)
            : [];
          authenticate(state, req);
          receipt = await upstream.submit({
            operationId: operation.id,
            text: input.text,
            ...(refs.length ? { images: refs } : {}),
          });
        } catch {
          receipt = null;
        }
      }
    }
    if (receipt) state.receipt(operation.id, receipt);
    return {
      ...projection.conversation(),
      submission: {
        operationId: operation.id,
        state: receipt?.state ?? "unknown",
        receipt: receipt ?? null,
      },
    };
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://host"),
        path = url.pathname;
      async function reply(res, status, value) {
        if (images) await images.decorate(value);
        if (path !== "/.well-known/aru.json" && path !== "/aru/v1/pair")
          authenticate(state, req);
        json(res, status, value);
      }
      if (path === "/.well-known/aru.json" && req.method === "GET")
        return await reply(res, 200, manifest());
      if (path === "/aru/v1/pair" && req.method === "POST")
        return await reply(res, 200, pair(state, await body(req)));
      const device = authenticate(state, req);
      if (path === "/aru/v1/diagnostics" && req.method === "GET")
        return await reply(res, 200, {
          schema: schema("diagnostics"),
          serverId,
          cfl: upstream.status,
        });
      if (path === "/aru/v1/devices" && req.method === "GET")
        return await reply(res, 200, {
          devices: state
            .get("devices")
            .map(({ credentialSHA256: _, ...d }) => d),
        });
      if (path === "/aru/v1/devices/revoke" && req.method === "POST") {
        const input = await body(req);
        authenticate(state, req);
        const devices = state.get("devices"),
          target = devices.find((d) => d.deviceId === input.deviceId);
        if (!target)
          throw new HttpError(404, "device.unknown", "Unknown device");
        target.revokedAt ??= Date.now();
        state.put("devices", devices);
        return json(res, 200, {
          deviceId: target.deviceId,
          revokedAt: target.revokedAt,
        });
      }
      if (path === "/aru/v1/hosted-collaborators" && req.method === "GET")
        return await reply(res, 200, {
          schema: schema("hosted-collaborator-inventory"),
          serverId,
          authority: "computer-host",
          collaborators: [await collaborator()],
        });
      if (path === root && req.method === "GET")
        return await reply(res, 200, await collaborator());
      if (path === root + "/conversations" && req.method === "GET") {
        await upstream.ready();
        return await reply(res, 200, {
          schema: schema("collaborator-conversation-inventory"),
          collaboratorId,
          conversations: [projection.conversation()],
        });
      }
      if (path === conversationRoot && req.method === "GET") {
        await upstream.ready();
        return await reply(res, 200, projection.conversation());
      }
      if (path.startsWith(conversationRoot + "/")) {
        const suffix = path.slice(conversationRoot.length);
        await upstream.ready();
        if (images && (await images.route(req, res, suffix, device))) return;
        if (suffix === "/messages" && req.method === "POST")
          return await reply(res, 202, await send(req, device));
        if (suffix === "/messages" && req.method === "GET") {
          const anchor = url.searchParams.get("before");
          const view = upstream.view;
          return await reply(
            res,
            200,
            projection.page(
              anchor
                ? await upstream.history(projection.before(anchor))
                : { messages: view.messages, before: view.before },
              anchor,
            ),
          );
        }
        if (
          (suffix === "/sync" || suffix === "/events") &&
          req.method === "GET"
        ) {
          const value = url.searchParams.get("after"),
            after = value === null ? null : Number(value);
          if (after !== null && (!Number.isSafeInteger(after) || after < 0))
            throw new HttpError(
              400,
              "conversation.cursor_invalid",
              "Invalid cursor",
            );
          return await reply(
            res,
            200,
            suffix === "/sync"
              ? projection.sync(after, url.searchParams.get("version"))
              : projection.events(after ?? 0),
          );
        }
        const cancel = /^\/turns\/([^/]+)\/cancel$/.exec(suffix);
        if (cancel && req.method === "POST") {
          const turnId = cancel[1],
            native = projection.nativeTurn(turnId);
          authenticate(state, req);
          const stopped = (
            await upstream.stop(native, () => authenticate(state, req))
          ).stopped;
          const cancellation = {
            status: stopped ? "confirmed" : "failed",
            message: stopped
              ? null
              : "Stop unconfirmed; inspect CFL and retry this turn only",
          };
          state.put("cancellation:" + turnId, cancellation);
          return await reply(res, 202, {
            ...projection.conversation(),
            cancellation: {
              turnId,
              status: stopped ? "confirmed" : "unconfirmed",
              stopped,
            },
          });
        }
      }
      if (path.startsWith("/aru/v1/"))
        throw new HttpError(
          501,
          "capability.unsupported",
          "Operation unsupported by this CFL access node",
        );
      throw new HttpError(404, "route.unknown", "Unknown route");
    } catch (error) {
      if (!res.headersSent)
        json(res, error.status ?? 503, {
          error: {
            code: error.code ?? "cfl.unavailable",
            message: error.status ? error.message : "CFL request unavailable",
          },
        });
      else res.destroy();
    }
  });
  return {
    server,
    upstream,
    manifest,
    async close() {
      upstream.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
