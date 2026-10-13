import assert from "node:assert/strict";

// Stable public JSON fields from retained Host owners, not CFL vendor DTOs:
// collaborator-conversations.mjs: appendEvent/publicConversation/publicTurn;
// conversation-sync.mjs: messagePage/syncProjection; attachments.mjs: publicAttachment.
// Closed-source iOS enum handling and optional capabilities remain device acceptance.
const schema = (name) => `aru.selfhost.${name}.v1`;
function fields(value, rules, path) {
  for (const [key, type] of Object.entries(rules)) {
    assert.ok(Object.hasOwn(value, key), `协作者页面响应无效，缺少字段${path}.${key}`);
    const v = value[key];
    assert.ok(type === "integer" ? Number.isSafeInteger(v)
      : type === "nullableInteger" ? v === null || Number.isSafeInteger(v)
      : type === "array" ? Array.isArray(v)
      : type === "nullableString" ? v === null || typeof v === "string"
      : typeof v === type, `${path}.${key}: expected ${type}`);
  }
}
// src/server/server.mjs manifest/pair; src/host/collaborator-host.mjs public collaborator.
export function manifest(value) {
  assert.equal(value.schema, schema("manifest"));
  fields(value, { serverId: "string", nodeKind: "string", displayName: "string",
    serverVersion: "string", minClientVersion: "string", transportProfiles: "array",
    capabilities: "object", networkAddress: "object", pairing: "object", diagnostics: "object" }, "manifest");
  fields(value.networkAddress, { mode: "string", url: "string", status: "string" }, "networkAddress");
  for (const profile of value.transportProfiles) fields(profile,
    { id: "string", priority: "integer", kind: "string", baseUrl: "string" }, "transportProfile");
  fields(value.capabilities["collaborator-host"], { enabled: "boolean", endpoint: "string",
    authority: "string", clientProjection: "string", phase: "string", turnExecution: "boolean",
    conversationEndpoint: "string", messageInputKinds: "array", attachmentProtocol: "string",
    maximumAttachmentBytes: "integer", maximumAttachmentsPerMessage: "integer" }, "capability");
  fields(value.pairing, { endpoint: "string", methods: "array" }, "pairing");
  fields(value.diagnostics, { endpoint: "string" }, "diagnostics");
}
export function grant(value) {
  assert.equal(value.schema, schema("pairing-grant"));
  fields(value, { serverId: "string", deviceId: "string", credentialSecret: "string",
    credentialScope: "string", issuedAt: "integer", expiresAt: "nullableInteger",
    rotationPolicy: "string", nextRotationAt: "nullableInteger", bootstrapTokenConsumedAt: "integer" }, "grant");
}
export function collaborator(value) {
  assert.equal(value.schema, schema("hosted-collaborator"));
  fields(value, { collaboratorId: "string", displayName: "string", avatarDataURL: "nullableString",
    supportsAvatarEditing: "boolean", driverId: "string", driverDisplayName: "string",
    driverDetail: "nullableString", providerProfileId: "nullableString", revision: "integer",
    createdAt: "integer", updatedAt: "integer", archivedAt: "nullableInteger", authority: "string",
    clientProjection: "string", activationStatus: "string", turnExecution: "boolean", approvalMode: "string",
    toolAccess: "object" }, "collaborator");
  fields(value.toolAccess, { mode: "string", toolNames: "array" }, "toolAccess");
}
export function attachment(value, path) {
  assert.equal(value.schema, schema("collaborator-conversation-attachment"));
  fields(value, { attachmentId: "string", collaboratorId: "string", conversationId: "string",
    messageId: "nullableString", kind: "string", filename: "string", mimeType: "string",
    state: "string", createdAt: "integer", downloadPath: "string" }, path);
  // Missing CFL originals have explicitly unavailable hash/length, not fabricated bytes.
  assert.ok(value.byteCount === null || Number.isSafeInteger(value.byteCount));
  assert.ok(value.sha256 === null || typeof value.sha256 === "string");
}
export function messages(rows) {
  assert.ok(Array.isArray(rows));
  rows.forEach((m, i) => {
    fields(m, { messageId: "string", role: "string", content: "string", status: "string",
      createdAt: "integer", updatedAt: "integer", position: "integer", attachments: "array" }, `messages.index ${i}`);
    assert.ok(["user", "assistant"].includes(m.role));
    assert.equal(m.status, "completed");
    m.attachments.forEach((a, j) => attachment(a, `messages.index ${i}.attachments.index ${j}`));
  });
}
export function conversation(value) {
  assert.equal(value.schema, schema("collaborator-conversation"));
  fields(value, { collaboratorId: "string", conversationId: "string", title: "string",
    revision: "integer", createdAt: "integer", updatedAt: "integer", archivedAt: "nullableInteger",
    cursor: "integer", messageCount: "integer", pendingApprovalCount: "integer",
    lastMessagePreview: "string", messages: "array", approvals: "array" }, "conversation");
  messages(value.messages);
  assert.ok(Object.hasOwn(value, "activeTurn"));
  if (value.activeTurn !== null) {
    fields(value.activeTurn, { turnId: "string", state: "string", userMessageId: "string",
      assistantMessageId: "string", createdAt: "integer", canCancel: "boolean" }, "activeTurn");
    for (const k of ["startedAt", "completedAt"]) {
      assert.ok(value.activeTurn[k] === null || Number.isSafeInteger(value.activeTurn[k]));
    }
    assert.ok(value.activeTurn.failure === null || typeof value.activeTurn.failure === "string");
  }
}
export function events(value, emissionTime) {
  assert.ok(Array.isArray(value.events));
  let previous = 0;
  value.events.forEach((e, i) => {
    fields(e, { at: "integer", sequence: "integer", kind: "string", payload: "object" }, `events.index ${i}`);
    assert.equal(e.at, emissionTime, "event emission time must differ from historical message time");
    assert.ok(e.sequence > previous); previous = e.sequence;
    assert.ok(e.payload && !Array.isArray(e.payload));
    assert.ok(["message.updated", "turn.updated"].includes(e.kind));
    if (e.kind === "message.updated") fields(e.payload, { messageId: "string", turnId: "nullableString" }, "payload");
    else fields(e.payload, { turnId: "nullableString" }, "payload");
    assert.equal(Object.hasOwn(e, "row"), false);
    assert.equal(Object.hasOwn(e, "createdAt"), false);
  });
  fields(value, { cursor: "integer", reset: "boolean", hasMore: "boolean" }, "page");
}
export function sync(value, emissionTime) {
  assert.equal(value.schema, schema("collaborator-conversation-sync"));
  fields(value, { collaboratorId: "string", conversationId: "string", version: "string", unchanged: "boolean" }, "sync");
  if (value.unchanged) return;
  conversation(value.conversation);
  events(value, emissionTime);
  assert.ok(value.history === null || (typeof value.history.before === "string" || value.history.before === null)
    && typeof value.history.hasMore === "boolean");
}
