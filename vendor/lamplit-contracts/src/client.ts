import {
  validateSearchInput,
  validateSearchResult,
  validateSearchReadResult,
  SearchReadInputSchema,
  type SearchInput,
  type SearchReadInput,
} from "./search.ts";
import {
  panelMethods,
  validatePanelResult,
  type PanelBackend,
} from "./panels.ts";
import {
  createRemoteServiceBinding,
  createServiceCatalogueCall,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  createServiceStateDecoder,
  parseWireServiceSubscriptionSnapshot,
  parseWireServiceProviderUpdate,
  type Context,
  type JsonValue,
  type RemoteServiceTransport,
  type ServiceSubscription,
} from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
} from "@earendil-works/chord/context";
import {
  Chat,
  ViewSchema,
  PageSchema,
  ReceiptSchema,
  LookupSchema,
  validate,
  validateRecovery,
  validateSubmission,
  type ChatView,
} from "./index.ts";
import {
  CompactInputSchema,
  CompactResultSchema,
  type CompactInput,
} from "./compact.ts";
import { decodeFrame, sendFrame } from "./wire.ts";

export async function openChat(
  socket: WebSocket,
  changed: (view: ChatView) => void,
  offline: () => void,
) {
  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === 1) return resolve();
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error("Connection timed out"));
    }, 10000);
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Connection failed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
    };
    socket.addEventListener("open", opened);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
  });
  let sequence = 0,
    closed = false;
  const pending = new Map<
    string,
    {
      resolve(v: JsonValue): void;
      reject(e: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Map<string, (update: unknown) => void>();
  const invoke = (
    call: Parameters<RemoteServiceTransport["invoke"]>[0],
    context: Context,
  ): Promise<JsonValue> => {
    const task = new Promise<JsonValue>((resolve, reject) => {
      if (closed) return reject(new Error("Offline"));
      const id = String(++sequence);
      const timer = setTimeout(() => {
        reject(new Error("Request timed out"));
        pending.delete(id);
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      try {
        sendFrame(socket, { type: "call", version: 1, id, call });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error as Error);
      }
    });
    return awaitWithContext(task, context);
  };
  const transport: RemoteServiceTransport = {
    invoke,
    async subscribe(
      serviceId,
      mode,
      listener,
      context,
    ): Promise<ServiceSubscription> {
      const subscriptionId = `view-${++sequence}`;
      const decoder = createServiceStateDecoder();
      let active = false,
        hydrated = false;
      const queue: unknown[] = [];
      const accept = (raw: unknown) => {
        if (!hydrated || !active) {
          if (queue.length >= 100) throw new Error("Subscription overflow");
          queue.push(raw);
          return;
        }
        listener(
          decoder.decodeUpdate(parseWireServiceProviderUpdate(raw)),
          BACKGROUND_CONTEXT,
        );
      };
      listeners.set(subscriptionId, accept);
      try {
        const raw = await invoke(
          createServiceSubscribeCall(subscriptionId, serviceId, mode),
          context,
        );
        const snapshot = decoder.decodeSnapshot(
          parseWireServiceSubscriptionSnapshot(raw),
        );
        hydrated = true;
        return {
          snapshot,
          activate() {
            active = true;
            for (const raw of queue.splice(0)) accept(raw);
          },
          close() {
            listeners.delete(subscriptionId);
            if (!closed)
              void invoke(
                createServiceUnsubscribeCall(subscriptionId),
                BACKGROUND_CONTEXT,
              ).catch(() => {});
          },
        };
      } catch (e) {
        listeners.delete(subscriptionId);
        throw e;
      }
    },
  };
  const binding = createRemoteServiceBinding({
    services: [Chat],
    transport,
    onError: () => {
      socket.close(1002, "Invalid state");
      finish();
    },
  });
  const service = binding.use(Chat);
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    listeners.clear();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Offline"));
    }
    pending.clear();
    void binding.dispose(BACKGROUND_CONTEXT).catch(() => {});
    offline();
  };
  const message = (event: MessageEvent) => {
    try {
      if (typeof event.data !== "string") throw new Error("Invalid frame");
      const frame = decodeFrame(event.data);
      if (frame.type === "update") {
        if (
          typeof frame.subscriptionId !== "string" ||
          !listeners.has(frame.subscriptionId)
        )
          throw new Error("Unknown subscription");
        listeners.get(frame.subscriptionId)!(frame.update);
      } else if (
        (frame.type === "result" || frame.type === "error") &&
        typeof frame.id === "string"
      ) {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.type === "error")
          p.reject(new Error("Request could not be completed"));
        else p.resolve(frame.result as JsonValue);
      } else throw new Error("Invalid frame");
    } catch {
      socket.close(1002, "Invalid protocol");
      finish();
    }
  };
  socket.addEventListener("message", message);
  socket.addEventListener("close", finish, { once: true });
  socket.addEventListener("error", finish, { once: true });
  heartbeat = setInterval(() => {
    void invoke(createServiceCatalogueCall(), BACKGROUND_CONTEXT).catch(() => {
      socket.close();
      finish();
    });
  }, 15000);
  try {
    await binding.ready(BACKGROUND_CONTEXT);
    unsubscribe = service.view.subscribe((value) => {
      try {
        const view = validate(ViewSchema, value);
        view.recovery.forEach(validateRecovery);
        changed(view);
      } catch {
        socket.close(1002, "Invalid view");
        finish();
      }
    });
    const panels = Object.fromEntries(
      Object.entries(panelMethods).map(([method, schemas]) => [
        method,
        async (input: unknown) => {
          const read = validate(schemas[0], input);
          const result = await (
            service[method as keyof PanelBackend] as (
              input: unknown,
              context: Context,
            ) => Promise<unknown>
          )(read, BACKGROUND_CONTEXT);
          return validatePanelResult(method as keyof PanelBackend, result);
        },
      ]),
    ) as unknown as PanelBackend;
    const api = {
      ...panels,
      async search(input: SearchInput) {
        return validateSearchResult(
          await service.search(validateSearchInput(input), BACKGROUND_CONTEXT),
        );
      },
      async searchRead(input: SearchReadInput) {
        const value = validate(SearchReadInputSchema, input);
        return validateSearchReadResult(
          await service.searchRead(value, BACKGROUND_CONTEXT),
          value.id,
        );
      },
      async compact(input: CompactInput) {
        const value = validate(CompactInputSchema, input);
        const result = validate(
          CompactResultSchema,
          await service.compact(value, BACKGROUND_CONTEXT),
        );
        if (result.sessionId !== value.sessionId)
          throw new Error("Wrong compact session");
        return result;
      },
      async history(before: string) {
        return validate(
          PageSchema,
          await service.history(before, BACKGROUND_CONTEXT),
        );
      },
      async submit(input: import("./index.ts").Submission) {
        const receipt = validate(
          ReceiptSchema,
          await service.submit(validateSubmission(input), BACKGROUND_CONTEXT),
        );
        if (receipt.operationId !== input.operationId)
          throw new Error("Wrong operation receipt");
        return receipt;
      },
      async lookup(id: string) {
        const receipt = validate(
          LookupSchema,
          await service.lookup(id, BACKGROUND_CONTEXT),
        );
        if (receipt && receipt.operationId !== id)
          throw new Error("Wrong operation receipt");
        return receipt;
      },
      async stop(id: string) {
        const v = await service.stop(id, BACKGROUND_CONTEXT);
        if (!v || typeof v.stopped !== "boolean")
          throw new Error("Invalid stop result");
        return v;
      },
    };
    return {
      ...api,
      close() {
        socket.removeEventListener("message", message);
        finish();
        socket.close();
      },
    };
  } catch (error) {
    finish();
    socket.close();
    throw error;
  }
}
