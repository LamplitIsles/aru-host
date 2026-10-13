import WebSocket from "ws";
import { openChat } from "@lamplit/contracts/client";
import { validateChatAppearance } from "@lamplit/contracts";
import { HttpError } from "./state.mjs";

export function loopbackOrigin(input) {
  const url = new URL(input);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("CFL origin must be a loopback HTTP origin");
  return url.origin;
}
export function createUpstream({
  origin,
  state,
  headers = {},
  changed = () => {},
}) {
  origin = loopbackOrigin(origin);
  let client,
    socket,
    view,
    connecting,
    closed = false,
    error = "CFL disconnected",
    timer;
  function accept(next) {
    const bound = state.get("session");
    if (bound && bound !== next.sessionId) {
      error = "CFL session identity changed";
      view = null;
      socket?.close();
      return;
    }
    if (!bound) state.put("session", next.sessionId);
    view = next;
    error = null;
    changed(next);
  }
  function schedule() {
    if (!closed && !timer)
      timer = setTimeout(() => {
        timer = null;
        void connect().catch(() => {});
      }, 1000);
  }
  async function connect() {
    if (closed) throw new Error("Closed");
    if (client && view && !error) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      socket = new WebSocket(
        origin.replace("http:", "ws:") + "/api/chat/socket",
        { headers, followRedirects: false, maxPayload: 2 * 1024 * 1024 },
      );
      const current = socket;
      const api = await openChat(
        current,
        (next) => {
          if (current === socket && !closed) accept(next);
        },
        () => {
          if (current !== socket) return;
          client = null;
          view = null;
          error ??= "CFL disconnected";
          changed(null);
          schedule();
        },
      );
      if (error || closed || current !== socket) {
        api.close();
        throw new Error(error ?? "Closed");
      }
      client = api;
      return api;
    })()
      .catch((e) => {
        error ??= "CFL unavailable";
        schedule();
        throw e;
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }
  async function ready() {
    try {
      await connect();
    } catch {
      throw new HttpError(503, "cfl.unavailable", error ?? "CFL unavailable");
    }
    if (!view || error)
      throw new HttpError(503, "cfl.unavailable", error ?? "CFL unavailable");
    return view;
  }
  async function request(path, options = {}) {
    await ready();
    const response = await fetch(origin + path, {
      ...options,
      headers: { ...headers, ...options.headers },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new HttpError(
        response.status === 404 ? 404 : 503,
        "cfl.http_unavailable",
        "CFL resource unavailable",
      );
    return response;
  }
  return {
    origin,
    ready,
    get view() {
      return view;
    },
    get status() {
      return { available: !!view && !error, message: error };
    },
    async history(before) {
      await ready();
      const page = await client.history(before);
      await ready();
      return page;
    },
    async lookup(id) {
      await ready();
      return client.lookup(id);
    },
    async submit(input) {
      await ready();
      return client.submit(input);
    },
    async stop(id) {
      await ready();
      return client.stop(id);
    },
    async appearance() {
      return validateChatAppearance(
        await (await request("/api/chat/appearance")).json(),
      );
    },
    request,
    close() {
      closed = true;
      clearTimeout(timer);
      client?.close();
      socket?.close();
    },
  };
}
