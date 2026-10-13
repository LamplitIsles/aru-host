import {
  validateSearchInput,
  validateSearchResult,
  validateSearchReadResult,
  SearchReadInputSchema,
  type SearchBackend,
} from "./search.ts";
import {
  panelMethods,
  validatePanelResult,
  type PanelBackend,
} from "./panels.ts";
import {
  RemoteServiceProvider,
  replicatedState,
  createServiceStateEncoder,
  decodeServiceControlCall,
  type ServiceSubscription,
  type JsonValue,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Chat,
  ViewSchema,
  PageSchema,
  validateSubmission,
  ReceiptSchema,
  LookupSchema,
  validate,
  validateId,
  validateRecovery,
  type ChatView,
  type HistoryPage,
  type Receipt,
  type Submission,
} from "./index.ts";
import {
  CompactInputSchema,
  CompactResultSchema,
  type CompactInput,
  type CompactResult,
} from "./compact.ts";
import { decodeFrame, readCall, type WireSocket } from "./wire.ts";

/** Engine adapters own durable admission and execution. Socket disposal never cancels them. */
export interface ChatBackend extends PanelBackend, SearchBackend {
  read(): Promise<ChatView>;
  compact(input: CompactInput): Promise<CompactResult>;
  history(before: string): Promise<HistoryPage>;
  submit(input: Submission): Promise<Receipt>;
  lookup(operationId: string): Promise<Receipt | null>;
  stop(turnId: string): Promise<{ stopped: boolean }>;
  subscribe(changed: () => void): () => void;
}
export async function createChatHost(
  backend: ChatBackend,
  onError: (error: unknown) => void = console.error,
) {
  const initial = validate(ViewSchema, await backend.read());
  initial.recovery.forEach(validateRecovery);
  const view = replicatedState(initial);
  const provider = new RemoteServiceProvider([Chat]);
  let closed = false,
    dirty = false;
  let refreshTask: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    dirty = true;
    if (refreshTask) return refreshTask;
    refreshTask = (async () => {
      try {
        while (dirty && !closed) {
          dirty = false;
          const next = validate(ViewSchema, await backend.read());
          next.recovery.forEach(validateRecovery);
          if (closed) return;
          if (JSON.stringify(next) !== JSON.stringify(view.value))
            view.change(BACKGROUND_CONTEXT, (draft) => {
              draft.messages = next.messages;
              draft.before = next.before;
              draft.activeTurnId = next.activeTurnId;
              draft.name = next.name;
              draft.sessionId = next.sessionId;
              draft.capabilities = next.capabilities;
              draft.recovery = next.recovery;
              draft.contextUsage = next.contextUsage;
              draft.compaction = next.compaction;
            });
        }
      } finally {
        refreshTask = undefined;
      }
    })();
    return refreshTask;
  };
  const panels = Object.fromEntries(
    Object.entries(panelMethods).map(([method, schemas]) => [
      method,
      async (input: unknown) => {
        const read = validate(schemas[0], input);
        if (read.sessionId !== view.value.sessionId)
          throw new Error("Wrong session");
        const result = await (
          backend[method as keyof PanelBackend] as (
            input: unknown,
          ) => Promise<unknown>
        )(read);
        return validatePanelResult(method as keyof PanelBackend, result);
      },
    ]),
  ) as unknown as PanelBackend;
  provider.provide(Chat, {
    ...panels,
    view,
    async search(input) {
      return validateSearchResult(
        await backend.search(validateSearchInput(input)),
      );
    },
    async searchRead(input) {
      const value = validate(SearchReadInputSchema, input);
      return validateSearchReadResult(
        await backend.searchRead(value),
        value.id,
      );
    },
    async compact(input: CompactInput) {
      const value = validate(CompactInputSchema, input);
      await refresh();
      if (value.sessionId !== view.value.sessionId)
        throw new Error("Wrong session");
      if (
        view.value.activeTurnId ||
        view.value.compaction?.status === "running"
      )
        return { sessionId: value.sessionId, accepted: false };
      const result = validate(
        CompactResultSchema,
        await backend.compact(value),
      );
      if (result.sessionId !== value.sessionId)
        throw new Error("Wrong compact session");
      await refresh();
      return result;
    },
    async history(before: string) {
      return validate(PageSchema, await backend.history(validateId(before)));
    },
    async submit(input: Submission) {
      const value = validateSubmission(input);
      const receipt = validate(ReceiptSchema, await backend.submit(value));
      if (receipt.operationId !== value.operationId)
        throw new Error("Wrong operation receipt");
      await refresh();
      return receipt;
    },
    async lookup(id: string) {
      const receipt = validate(
        LookupSchema,
        await backend.lookup(validateId(id)),
      );
      if (receipt && receipt.operationId !== id)
        throw new Error("Wrong operation receipt");
      return receipt;
    },
    async stop(id: string) {
      const result = await backend.stop(validateId(id));
      await refresh();
      return result;
    },
  });
  const off = backend.subscribe(() => {
    void refresh().catch(onError);
  });
  const connections = new Set<ReturnType<typeof connect>>();
  function connect(socket: WireSocket, authorize: () => Promise<boolean>) {
    let disposed = false;
    const subscriptions = new Map<string, ServiceSubscription>();
    let outgoing: Promise<void> = Promise.resolve();
    let queuedBytes = 0;
    const deliver = (frame: unknown) => {
      if (disposed) return;
      const raw = JSON.stringify(frame);
      const bytes = new TextEncoder().encode(raw).byteLength;
      if (
        bytes > 2 * 1024 * 1024 ||
        queuedBytes + bytes + (socket.bufferedAmount ?? 0) > 4 * 1024 * 1024
      ) {
        socket.close(1013, "Reconnect");
        dispose();
        return;
      }
      queuedBytes += bytes;
      outgoing = outgoing
        .then(async () => {
          try {
            if (disposed) return;
            if (!(await authorize())) {
              socket.close(1008, "Session expired");
              dispose();
              return;
            }
            if (!disposed) socket.send(raw);
          } finally {
            queuedBytes -= bytes;
          }
        })
        .catch((error) => {
          onError(error);
          socket.close(1011, "Connection failed");
          dispose();
        });
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const sub of subscriptions.values()) sub.close();
      subscriptions.clear();
      connections.delete(connection);
    }
    async function process(raw: string) {
      if (disposed) return;
      if (!(await authorize())) {
        socket.close(1008, "Session expired");
        dispose();
        return;
      }
      if (disposed) return;
      let id: string | undefined;
      try {
        const frame = decodeFrame(raw);
        if (
          frame.type !== "call" ||
          frame.version !== 1 ||
          typeof frame.id !== "string" ||
          frame.id.length > 100
        )
          throw new Error("Invalid request");
        id = frame.id;
        const call = readCall(frame.call);
        const control = decodeServiceControlCall(call);
        let result: unknown;
        if (control?.type === "subscribe") {
          if (subscriptions.size || subscriptions.has(control.subscriptionId))
            throw new Error("Already subscribed");
          const encoder = createServiceStateEncoder();
          const sub = provider.subscribe(
            control.serviceId,
            control.mode,
            (update) =>
              deliver({
                type: "update",
                subscriptionId: control.subscriptionId,
                update: encoder.encodeUpdate(update),
              }),
          );
          subscriptions.set(control.subscriptionId, sub);
          result = encoder.encodeSnapshot(sub.snapshot);
          deliver({ type: "result", id, result });
          sub.activate();
          return;
        } else if (control?.type === "unsubscribe") {
          subscriptions.get(control.subscriptionId)?.close();
          subscriptions.delete(control.subscriptionId);
          result = null;
        } else if (control?.type === "catalogue") result = provider.catalogue;
        else {
          if (
            call.serviceId !== Chat.id ||
            call.instance ||
            ![
              "history",
              "submit",
              "lookup",
              "stop",
              "compact",
              "search",
              "searchRead",
              ...Object.keys(panelMethods),
            ].includes(call.member) ||
            call.args.length !== 1
          )
            throw new Error("Invalid method");
          result = (await provider.invoke(
            call,
            BACKGROUND_CONTEXT,
          )) as JsonValue;
        }
        const reply = { type: "result", id, result: result ?? null };
        // Method results fail in isolation before the transport would disconnect.
        if (
          new TextEncoder().encode(JSON.stringify(reply)).byteLength >
          2 * 1024 * 1024
        )
          throw new Error("Method result exceeds frame limit");
        deliver(reply);
      } catch (error) {
        if (!id) {
          socket.close(1002, "Invalid frame");
          dispose();
        } else
          deliver({
            type: "error",
            id,
            error: "Request could not be completed",
          });
        onError(error);
      }
    }
    const connection = {
      receive(raw: string) {
        return process(raw).catch(onError);
      },
      close: dispose,
      disconnect() {
        socket.close(1012, "Reconnect");
        dispose();
      },
    };
    connections.add(connection);
    return connection;
  }
  await refresh();
  return {
    connect,
    refresh,
    close() {
      closed = true;
      off();
      for (const c of connections) c.disconnect();
      provider.dispose();
    },
  };
}

export { imageHttp, type ImageBackend } from "./image-http.ts";
