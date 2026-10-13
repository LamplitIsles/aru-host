import {
  UPLOAD_PATH,
  MEDIA_PATH,
  MediaIdSchema,
  MAX_UPLOAD_BODY_BYTES,
  UploadResultSchema,
  validateUpload,
  type ImageLimits,
  type ImageUpload,
} from "./images.ts";
import { validate } from "./validation.ts";
// Existing native-generated originals may exceed new-input intake limits.
const MAX_ORIGINAL_MEDIA_BYTES = 32 * 1024 * 1024;
export interface ImageBackend {
  /** Authenticated owner/session adapter; stores immutable operation+ordered upload payload. */
  upload(input: ImageUpload): Promise<unknown>;
  media(
    id: string,
    variant: "original" | "preview" | "model",
  ): Promise<{ bytes: Uint8Array; mediaType: string } | null>;
}
/** Mount before static assets. Authorization must resolve the current owner and session on every request. */
export async function imageHttp(
  request: Request,
  backend: ImageBackend,
  authorize: () => Promise<{
    sessionId: string;
    limits: ImageLimits | false;
  } | null>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== UPLOAD_PATH && !url.pathname.startsWith(MEDIA_PATH))
    return;
  const owner = await authorize();
  if (!owner) return new Response("Unauthorized", { status: 401 });
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  try {
    if (url.pathname === UPLOAD_PATH) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (request.headers.get("origin") !== url.origin)
        return new Response(null, { status: 403 });
      if (!owner.limits)
        return new Response("Images unavailable", { status: 503 });
      if (request.headers.get("content-type") !== "application/json")
        return new Response(null, { status: 415 });
      if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BODY_BYTES)
        return new Response(null, { status: 413 });
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Missing body");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_UPLOAD_BODY_BYTES) {
            await reader.cancel();
            return new Response(null, { status: 413 });
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const input = validateUpload(
        JSON.parse(new TextDecoder().decode(bytes)),
        owner.limits,
      );
      if (input.sessionId !== owner.sessionId)
        return new Response(null, { status: 403 });
      const current = await authorize();
      if (!current || current.sessionId !== owner.sessionId)
        return new Response(null, { status: 403 });
      if (!current.limits) return new Response(null, { status: 503 });
      validateUpload(input, current.limits);
      const result = validate(UploadResultSchema, await backend.upload(input));
      if (
        result.sessionId !== input.sessionId ||
        result.operationId !== input.operationId ||
        result.images.length !== input.images.length ||
        new Set(result.images.map((r) => r.attachmentId)).size !==
          result.images.length ||
        result.images.some(
          (r, i) =>
            r.mediaType !== input.images[i]!.mediaType ||
            r.name !== input.images[i]!.name ||
            r.availability !== "available",
        )
      )
        throw new Error("Invalid upload result");
      const final = await authorize();
      if (!final || final.sessionId !== owner.sessionId)
        return new Response(null, { status: 403 });
      return Response.json(result, { headers });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const parts = url.pathname.slice(MEDIA_PATH.length).split("/");
    const id = validate(MediaIdSchema, parts[0]);
    const variant = parts[1];
    if (
      parts.length !== 2 ||
      !["original", "preview", "model"].includes(variant!)
    )
      throw new Error("Invalid media path");
    const media = await backend.media(
      id,
      variant as "original" | "preview" | "model",
    );
    if (
      media &&
      (media.bytes.length >
        (variant === "original"
          ? MAX_ORIGINAL_MEDIA_BYTES
          : variant === "preview"
            ? 160_000
            : 320_000) ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          media.mediaType,
        ) ||
        (variant !== "original" && media.mediaType !== "image/jpeg"))
    )
      throw new Error("Invalid media result");
    const current = await authorize();
    if (!current || current.sessionId !== owner.sessionId)
      return new Response(null, { status: 403 });
    if (!media) return new Response("Missing image", { status: 404, headers });
    return new Response(media.bytes as BodyInit, {
      headers: { ...headers, "Content-Type": media.mediaType },
    });
  } catch {
    return new Response("Image request failed", { status: 400, headers });
  }
}
