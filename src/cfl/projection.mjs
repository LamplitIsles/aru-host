import { randomUUID } from "node:crypto";
import { digest, HttpError } from "./state.mjs";
export const schema = (name) => `aru.selfhost.${name}.v1`;
export function createProjection(state) {
  const { collaboratorId, conversationId, createdAt } = state.identity;
  const epoch = randomUUID();
  let cursor = 0,
    events = [],
    previous = new Map(),
    current = null;
  const refs = state.get("references") ?? {
    messages: {},
    turns: {},
    anchors: {},
    positions: {},
  };
  function ref(kind, native) {
    if (!native) return null;
    const id = `${kind}_${digest(native).slice(0, 40)}`;
    refs[kind === "msg" ? "messages" : "turns"][id] = native;
    return id;
  }
  const positionGap = 1_000_000;
  function rows(messages) {
    // Extend a stable ordered index in either direction; only IDs/positions persist.
    for (let i = 0; i < messages.length; i++) {
      const id = ref("msg", messages[i].id);
      if (refs.positions[id] === undefined) {
        const next = messages
          .slice(i + 1)
          .map((m) => refs.positions[ref("msg", m.id)])
          .find((p) => p !== undefined);
        const prior = i
          ? refs.positions[ref("msg", messages[i - 1].id)]
          : undefined;
        const highest = Math.max(1_000_000_000_000, ...Object.values(refs.positions));
        refs.positions[id] =
          prior !== undefined
            ? next !== undefined
              ? Math.floor((prior + next) / 2)
              : prior + positionGap
            : next !== undefined
              ? next - (messages.length - i) * positionGap
              : highest + positionGap;
      }
    }
    const result = messages.map((m) => {
      const labels =
        m.source?.kind === "reminder"
          ? "[CFL reminder] "
          : m.source?.kind === "matrix"
            ? `[Matrix: ${m.source.senderDisplayName || m.source.senderId}] `
            : m.source?.kind === "keet"
              ? `[Keet: ${m.source.senderLabel}] `
              : "";
      return {
        messageId: ref("msg", m.id),
        role:
          m.role === "agent"
            ? "assistant"
            : m.role === "notice"
              ? "assistant"
              : "user",
        content: labels + m.text,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
        turnId: ref("turn", m.turnId),
        status: "completed",
        position: refs.positions[ref("msg", m.id)],
        ...(m.source ? { source: m.source } : {}),
        operationId: m.operationId,
        attachments: (m.images ?? []).map((image) => ({
          schema: schema("collaborator-conversation-attachment"),
          ...image,
          kind: "image",
          filename: image.name,
          mimeType: image.mediaType,
          state: image.availability === "available" ? "bound" : "missing",
          collaboratorId,
          conversationId,
          messageId: ref("msg", m.id),
          downloadPath: `/aru/v1/hosted-collaborators/${collaboratorId}/conversations/${conversationId}/attachments/${image.attachmentId}/content`,
        })),
      };
    });
    state.put("references", refs);
    return result;
  }
  function accept(view) {
    if (!view) {
      current = null;
      return;
    }
    const messages = rows(view.messages);
    if (messages.length && view.before)
      refs.anchors[messages[0].messageId] = view.before;
    state.put("references", refs);
    for (const row of messages) {
      const value = JSON.stringify(row);
      if (previous.get(row.messageId) !== value) {
        events.push({
          sequence: ++cursor,
          kind: "message.updated",
          createdAt: Date.now(),
          payload: { messageId: row.messageId, turnId: row.turnId },
          row,
        });
        previous.set(row.messageId, value);
      }
    }
    if (
      JSON.stringify(
        current && [
          current.name,
          current.activeTurnId,
          current.recovery,
          current.capabilities,
        ],
      ) !==
      JSON.stringify([
        view.name,
        view.activeTurnId,
        view.recovery,
        view.capabilities,
      ])
    )
      events.push({
        sequence: ++cursor,
        kind: "turn.updated",
        createdAt: Date.now(),
        payload: { turnId: ref("turn", view.activeTurnId) },
      });
    events = events.slice(-512);
    current = { ...view, messages };
  }
  function conversation(messages = current?.messages ?? []) {
    if (!current)
      throw new HttpError(503, "cfl.unavailable", "Conversation unavailable");
    const user = current.messages.findLast(
      (m) =>
        m.role === "user" && m.turnId === ref("turn", current.activeTurnId),
    );
    const assistant = current.messages.findLast(
      (m) =>
        m.role === "assistant" &&
        m.turnId === ref("turn", current.activeTurnId),
    );
    return {
      schema: schema("collaborator-conversation"),
      collaboratorId,
      conversationId,
      title: current.name,
      revision: cursor,
      createdAt,
      updatedAt: Math.max(
        createdAt,
        ...current.messages.map((m) => m.createdAt),
      ),
      archivedAt: null,
      cursor,
      activeTurn: current.activeTurnId
        ? {
            turnId: ref("turn", current.activeTurnId),
            state: "streaming",
            userMessageId: user?.messageId ?? "",
            assistantMessageId: assistant?.messageId ?? "",
            createdAt: user?.createdAt ?? createdAt,
            startedAt: null,
            completedAt: null,
            failure: null,
            canCancel: true,
            cancellation: state.get(
              "cancellation:" + ref("turn", current.activeTurnId),
            ),
          }
        : null,
      messageCount: current.messages.length,
      pendingApprovalCount: 0,
      lastMessagePreview: current.messages.at(-1)?.content.slice(0, 180) ?? "",
      messages,
      approvals: [],
      history: {
        before: current.messages[0]?.messageId ?? null,
        hasMore: !!current.before,
      },
      recovery: current.recovery,
    };
  }
  function sync(after, version) {
    const token = `${epoch}:${cursor}`;
    if (version === token && after === cursor)
      return {
        schema: schema("collaborator-conversation-sync"),
        collaboratorId,
        conversationId,
        version: token,
        unchanged: true,
      };
    const reset =
      after === null ||
      after > cursor ||
      !version?.startsWith(epoch + ":") ||
      (events.length && after < events[0].sequence - 1);
    const page = reset
      ? []
      : events.filter((e) => e.sequence > after).slice(0, 128);
    const rows = reset
      ? current.messages
      : [
          ...new Map(
            page.filter((e) => e.row).map((e) => [e.row.messageId, e.row]),
          ).values(),
        ];
    const next = reset ? cursor : (page.at(-1)?.sequence ?? after);
    return {
      schema: schema("collaborator-conversation-sync"),
      collaboratorId,
      conversationId,
      version: token,
      unchanged: false,
      reset,
      conversation: conversation(rows),
      events: page.map(({ row: _, ...e }) => e),
      cursor: next,
      hasMore: next < cursor,
      history: reset ? conversation().history : null,
    };
  }
  return {
    accept,
    conversation,
    sync,
    rows,
    ref,
    nativeTurn(id) {
      const native = refs.turns[id];
      if (!native) throw new HttpError(404, "turn.unknown", "Unknown turn");
      return native;
    },
    before(id) {
      if (!refs.anchors[id])
        throw new HttpError(
          409,
          "conversation.anchor_unknown",
          "Unknown history anchor",
        );
      return refs.anchors[id];
    },
    page(page, anchor = null) {
      if (anchor && refs.positions[anchor] !== undefined)
        page.messages.forEach((m, i) => {
          const id = ref("msg", m.id);
          if (refs.positions[id] === undefined)
            refs.positions[id] =
              refs.positions[anchor] - (page.messages.length - i) * positionGap;
        });
      const messages = rows(page.messages);
      if (messages.length && page.before)
        refs.anchors[messages[0].messageId] = page.before;
      state.put("references", refs);
      return {
        schema: schema("collaborator-conversation-message-page"),
        collaboratorId,
        conversationId,
        messages,
        before: messages[0]?.messageId ?? null,
        hasMore: !!page.before,
      };
    },
    events(after) {
      const s = sync(after, epoch + ":");
      return {
        schema: schema("collaborator-conversation-events"),
        collaboratorId,
        conversationId,
        events: s.events ?? [],
        cursor: s.cursor ?? cursor,
        reset: s.reset,
        hasMore: s.hasMore,
      };
    },
  };
}
