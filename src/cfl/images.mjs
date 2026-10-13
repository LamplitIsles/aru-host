import sharp from "sharp";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  validate,
  UploadResultSchema,
  validateUpload,
  mediaUrl,
} from "@lamplit/contracts";
import { HttpError, digest } from "./state.mjs";
import { schema } from "./projection.mjs";
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const formats = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export function createImages(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return ({ state, upstream, json, body, assertDevice }) => {
    const { collaboratorId, conversationId } = state.identity;
    const collection = () => state.get("attachments") ?? {};
    function limits() {
      const value = upstream.view?.capabilities.images;
      if (!value)
        throw new HttpError(
          415,
          "attachment.unsupported",
          "CFL images unavailable",
        );
      return value;
    }
    function record(id, device) {
      if (!idPattern.test(id))
        throw new HttpError(400, "attachment.invalid", "Invalid attachment ID");
      const value = collection()[id];
      if (!value || value.deviceId !== device.deviceId)
        throw new HttpError(404, "attachment.unknown", "Unknown attachment");
      return value;
    }
    const contentPath = (id) => join(directory, id + ".original");
    const publicRecord = ({
      deviceId: _,
      upstreamId: __,
      operationId: ___,
      ...r
    }) => ({
      schema: schema("collaborator-conversation-attachment"),
      ...r,
      collaboratorId,
      conversationId,
      downloadPath: `/aru/v1/hosted-collaborators/${collaboratorId}/conversations/${conversationId}/attachments/${r.attachmentId}/content`,
    });
    async function decode(bytes, mime) {
      try {
        const image = sharp(bytes, {
          limitInputPixels: 40_000_000,
          failOn: "warning",
        });
        const metadata = await image.metadata();
        if (metadata.format !== formats[mime])
          throw new Error("Format mismatch");
        // GIF/WebP animation is retained in original; preview/model use first frame.
        await image
          .clone()
          .resize({ width: 16, height: 16, fit: "inside" })
          .raw()
          .toBuffer();
      } catch {
        throw new HttpError(
          400,
          "attachment.invalid_image",
          "Image cannot be decoded or exceeds safe dimensions",
        );
      }
    }
    async function derivative(bytes, edge, maximum) {
      for (const quality of [80, 60, 40]) {
        const result = await sharp(bytes, {
          limitInputPixels: 40_000_000,
          failOn: "warning",
        })
          .rotate()
          .resize({
            width: edge,
            height: edge,
            fit: "inside",
            withoutEnlargement: true,
          })
          .flatten({ background: "#fff" })
          .jpeg({ quality })
          .toBuffer();
        if (result.length <= maximum) return result.toString("base64");
      }
      throw new HttpError(
        413,
        "attachment.derivative_too_large",
        "Image derivative exceeds CFL limit",
      );
    }
    return {
      async decorate(value) {
        const messages =
          value?.messages ??
          value?.conversation?.messages ??
          value?.conversations?.flatMap((c) => c.messages ?? []) ??
          [];
        for (const message of messages)
          for (const attachment of message.attachments ?? []) {
            if (attachment.availability === "missing") {
              attachment.byteCount = null;
              attachment.sha256 = null;
              continue;
            }
            const key = "media:" + attachment.attachmentId;
            let metadata = state.get(key);
            if (!metadata) {
              const response = await upstream.request(
                mediaUrl(attachment.attachmentId),
              );
              const bytes = Buffer.from(await response.arrayBuffer());
              if (bytes.length > 8_000_000)
                throw new HttpError(
                  413,
                  "attachment.too_large",
                  "Upstream image too large",
                );
              metadata = { byteCount: bytes.length, sha256: digest(bytes) };
              state.put(key, metadata);
            }
            Object.assign(attachment, metadata, {
              createdAt: message.createdAt,
            });
          }
      },
      async route(req, res, suffix, device) {
        if (suffix === "/attachments" && req.method === "POST") {
          const input = await body(req);
          assertDevice(req);
          const l = limits();
          if (input.kind !== "image" || !l.mediaTypes.includes(input.mimeType))
            throw new HttpError(
              415,
              "attachment.unsupported",
              "Only CFL supported images are accepted",
            );
          if (
            typeof input.clientUploadId !== "string" ||
            !input.clientUploadId.length ||
            input.clientUploadId.length > 300 ||
            typeof input.filename !== "string" ||
            !input.filename.length ||
            input.filename.length > 160 ||
            /[\\/\x00-\x1f]/.test(input.filename) ||
            !/^[a-f0-9]{64}$/.test(input.sha256) ||
            !Number.isSafeInteger(input.byteCount) ||
            input.byteCount < 1 ||
            input.byteCount > l.maxImageBytes
          )
            throw new HttpError(
              400,
              "attachment.invalid",
              "Invalid image metadata or limits",
            );
          const records = collection();
          const fingerprint = digest(
            JSON.stringify([
              input.kind,
              input.mimeType,
              input.filename,
              input.sha256,
              input.byteCount,
            ]),
          );
          const existing = Object.values(records).find(
            (r) =>
              r.deviceId === device.deviceId &&
              r.clientUploadId === input.clientUploadId,
          );
          if (existing) {
            if (existing.fingerprint !== fingerprint)
              throw new HttpError(
                409,
                "attachment.identity_conflict",
                "Upload ID owns different content",
              );
            json(res, 201, publicRecord(existing));
            return true;
          }
          const id = `hostatt_${randomUUID()}`;
          const r = {
            attachmentId: id,
            clientUploadId: input.clientUploadId,
            fingerprint,
            deviceId: device.deviceId,
            kind: "image",
            mimeType: input.mimeType,
            filename: input.filename,
            byteCount: input.byteCount,
            sha256: input.sha256,
            state: "uploading",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageId: null,
          };
          records[id] = r;
          state.put("attachments", records);
          json(res, 201, publicRecord(r));
          return true;
        }
        const match = /^\/attachments\/([A-Za-z0-9_-]+)(\/content)?$/.exec(
          suffix,
        );
        if (!match) return false;
        const id = match[1];
        if (match[2] && req.method === "GET") {
          // Known local owner can read staged bytes. CFL-bound IDs are read only from CFL.
          const local = collection()[id];
          if (
            local &&
            local.deviceId === device.deviceId &&
            !local.upstreamId
          ) {
            if (local.state !== "ready")
              throw new HttpError(
                409,
                "attachment.not_ready",
                "Image not ready",
              );
            const bytes = readFileSync(contentPath(id));
            assertDevice(req);
            res.writeHead(200, {
              "content-type": local.mimeType,
              "cache-control": "no-store",
            });
            res.end(bytes);
            return true;
          }
          const target = local?.upstreamId ?? id;
          const response = await upstream.request(mediaUrl(target));
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 8_000_000)
            throw new HttpError(
              413,
              "attachment.too_large",
              "Upstream image too large",
            );
          assertDevice(req);
          res.writeHead(200, {
            "content-type":
              response.headers.get("content-type") ??
              "application/octet-stream",
            "cache-control": "no-store",
          });
          res.end(bytes);
          return true;
        }
        const r = record(id, device);
        if (match[2] && req.method === "PUT") {
          if (r.byteCount > limits().maxImageBytes)
            throw new HttpError(
              413,
              "attachment.too_large",
              "Image exceeds current CFL limit",
            );
          let count = 0;
          const chunks = [];
          for await (const chunk of req) {
            count += chunk.length;
            if (count > r.byteCount)
              throw new HttpError(
                413,
                "attachment.too_large",
                "Image exceeds admitted size",
              );
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          if (count !== r.byteCount || digest(bytes) !== r.sha256)
            throw new HttpError(
              400,
              "attachment.integrity",
              "Image length or hash mismatch",
            );
          assertDevice(req);
          if (r.state !== "uploading") {
            json(res, 200, publicRecord(r));
            return true;
          }
          await decode(bytes, r.mimeType);
          assertDevice(req);
          const temp = contentPath(id) + "." + randomUUID();
          writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
          renameSync(temp, contentPath(id));
          r.state = "ready";
          r.updatedAt = Date.now();
          const records = collection();
          records[id] = r;
          state.put("attachments", records);
          json(res, 200, publicRecord(r));
          return true;
        }
        if (!match[2] && req.method === "DELETE") {
          if (r.operationId)
            throw new HttpError(
              409,
              "attachment.bound",
              "Image belongs to an admitted operation",
            );
          const records = collection();
          delete records[id];
          state.put("attachments", records);
          rmSync(contentPath(id), { force: true });
          json(res, 200, { attachmentId: id, deleted: true });
          return true;
        }
        return false;
      },
      async prepare(ids, device) {
        const l = limits();
        if (
          ids.length > l.maxImagesPerMessage ||
          new Set(ids).size !== ids.length
        )
          throw new HttpError(
            400,
            "attachment.invalid",
            "Too many or duplicate images",
          );
        const records = ids.map((id) => record(id, device));
        if (
          records.some(
            (r) =>
              r.state !== "ready" ||
              r.operationId ||
              !l.mediaTypes.includes(r.mimeType),
          ) ||
          records.reduce((sum, r) => sum + r.byteCount, 0) >
            l.maxMessageImageBytes
        )
          throw new HttpError(
            400,
            "attachment.invalid",
            "Image unavailable, bound, or over CFL limits",
          );
        return Promise.all(
          records.map(async (r, order) => {
            const bytes = readFileSync(contentPath(r.attachmentId));
            if (digest(bytes) !== r.sha256)
              throw new HttpError(
                409,
                "attachment.integrity",
                "Staged image damaged",
              );
            await decode(bytes, r.mimeType);
            return {
              id: r.attachmentId,
              order,
              name: r.filename,
              mediaType: r.mimeType,
              original: bytes.toString("base64"),
              preview: await derivative(bytes, 512, 160000),
              model: await derivative(bytes, 1024, 320000),
            };
          }),
        );
      },
      async upload(operationId, prepared, device) {
        const input = validateUpload(
          { sessionId: state.get("session"), operationId, images: prepared },
          limits(),
        );
        const records = collection();
        for (const image of prepared) {
          const r = record(image.id, device);
          if (r.operationId)
            throw new HttpError(409, "attachment.bound", "Image already bound");
          records[image.id].operationId = operationId;
        }
        state.put("attachments", records);
        const result = validate(
          UploadResultSchema,
          await (
            await upstream.request("/api/chat/images", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: upstream.origin,
              },
              body: JSON.stringify(input),
            })
          ).json(),
        );
        if (
          result.sessionId !== input.sessionId ||
          result.operationId !== operationId ||
          result.images.length !== prepared.length ||
          result.images.some(
            (r, i) =>
              r.name !== prepared[i].name ||
              r.mediaType !== prepared[i].mediaType ||
              r.availability !== "available",
          )
        )
          throw new Error("Invalid upload receipt identity");
        const latest = collection();
        result.images.forEach((ref, i) => {
          latest[prepared[i].id].upstreamId = ref.attachmentId;
          latest[prepared[i].id].state = "bound";
        });
        state.put("attachments", latest);
        return result.images;
      },
    };
  };
}
