import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createChatHost, imageHttp } from "@lamplit/contracts/server";
export async function fixture({ images = false } = {}) {
  let messages = [],
    activeTurnId = null,
    submissions = 0,
    lost = false,
    stopCalls = 0,
    sessionId = "test-session";
  const limits = {
    mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    maxImagesPerMessage: 6,
    maxImageBytes: 8000000,
    maxMessageImageBytes: 24000000,
  };
  const media = new Map(),
    uploads = new Map();
  const receipts = new Map(),
    listeners = new Set();
  const view = () => ({
    version: 2,
    sessionId,
    name: "Synthetic companion",
    activeTurnId,
    contextUsage: { tokens: null, capacity: null },
    compaction: null,
    messages: messages.slice(-30),
    before: messages.length > 30 ? messages.at(-30).id : null,
    capabilities: {
      text: true,
      steer: true,
      stop: true,
      images: images ? limits : false,
    },
    recovery: [],
  });
  const chat = await createChatHost({
    read: async () => view(),
    history: async (anchor) => {
      const end = messages.findIndex((m) => m.id === anchor);
      if (end < 0) throw Error("Invalid cursor");
      const start = Math.max(0, end - 30);
      return {
        messages: messages.slice(start, end),
        before: start ? messages[start].id : null,
      };
    },
    submit: async (input) => {
      submissions++;
      activeTurnId = "native-turn-" + submissions;
      const receipt = {
        operationId: input.operationId,
        state: "submitted",
        messageId: input.operationId,
        turnId: activeTurnId,
        error: null,
      };
      receipts.set(input.operationId, receipt);
      messages.push({
        id: input.operationId,
        role: "user",
        text: input.text,
        ...(input.images ? { images: input.images } : {}),
        createdAt: Date.now(),
        operationId: input.operationId,
        turnId: activeTurnId,
      });
      for (const f of listeners) f();
      if (lost) throw new Error("lost acknowledgement");
      return receipt;
    },
    lookup: async (id) => receipts.get(id) ?? null,
    stop: async (id) => {
      stopCalls++;
      const stopped = id === activeTurnId;
      if (stopped) {
        activeTurnId = null;
        for (const f of listeners) f();
      }
      return { stopped };
    },
    subscribe: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
  });
  const server = createServer(async (req, res) => {
    if (
      req.url.startsWith("/api/chat/images") ||
      req.url.startsWith("/api/chat/media/")
    ) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const result = await imageHttp(
          new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers: req.headers,
            ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          }),
          {
            async upload(input) {
              const existing = uploads.get(input.operationId);
              if (existing) return existing;
              const refs = input.images.map((image, i) => {
                const attachmentId = `image_${input.operationId}_${i}`;
                media.set(attachmentId, image);
                return {
                  attachmentId,
                  mediaType: image.mediaType,
                  name: image.name,
                  availability: "available",
                };
              });
              const result = {
                operationId: input.operationId,
                sessionId,
                images: refs,
              };
              uploads.set(input.operationId, result);
              return result;
            },
            async media(id, variant) {
              const image = media.get(id);
              return image
                ? {
                    bytes: Buffer.from(image[variant], "base64"),
                    mediaType:
                      variant === "original" ? image.mediaType : "image/jpeg",
                  }
                : null;
            },
          },
          async () => ({ sessionId, limits: images ? limits : false }),
        );
        res.writeHead(result.status, Object.fromEntries(result.headers));
        res.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end("Synthetic fixture failure");
      }
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        companionName: "Synthetic companion",
        userName: "Synthetic human",
      }),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    const channel = chat.connect(ws, async () => true);
    ws.on("message", (data) => channel.receive(String(data)));
    ws.on("close", () => channel.close());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    get uploaded() {
      return [...media.values()];
    },
    get submissions() {
      return submissions;
    },
    get stopCalls() {
      return stopCalls;
    },
    set lost(v) {
      lost = v;
    },
    seed(rows) {
      messages.push(...rows);
      for (const f of listeners) f();
    },
    replaceSession() {
      sessionId = "different-session";
      for (const f of listeners) f();
    },
    disconnect() {
      for (const ws of wss.clients) ws.terminate();
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      chat.close();
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
}
