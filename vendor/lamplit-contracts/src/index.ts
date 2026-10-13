export * from "./appearance.ts";
export * from "./search.ts";
import type { SearchBackend } from "./search.ts";
import { ReminderSourceSchema, type PanelBackend } from "./panels.ts";
export * from "./panels.ts";
export * from "./images.ts";
export * from "./compact.ts";
import {
  ContextUsageSchema,
  CompactionSchema,
  type CompactInput,
  type CompactResult,
} from "./compact.ts";
import {
  OperationIdSchema,
  ImageRefSchema,
  ImageLimitsSchema,
  RecoverySchema,
} from "./images.ts";
import { Type, type Static } from "typebox";
import { Format } from "typebox/format";
import { validate } from "./validation.ts";
export { validate } from "./validation.ts";
import {
  defineService,
  type ReplicatedState,
  type Context,
} from "@earendil-works/chord";

export const PROTOCOL_VERSION = 2;
export const CHAT_PATH = "/api/chat/socket";
export const PAGE_SIZE = 30;
const Id = Type.String({ minLength: 1, maxLength: 300 });
const NullableId = Type.Union([Id, Type.Null()]);
export const SubmissionSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    text: Type.String({ maxLength: 16000 }),
    images: Type.Optional(Type.Array(ImageRefSchema, { maxItems: 6 })),
    replacementSourceIds: Type.Optional(
      Type.Array(Id, { maxItems: 20, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);
export const ReceiptSchema = Type.Object(
  {
    operationId: Id,
    state: Type.Union([Type.Literal("submitted"), Type.Literal("failed")]),
    messageId: NullableId,
    turnId: NullableId,
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
// Native Keet labels are single-line names bounded to 512 Unicode code points.
const KeetLabelSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!.*[\\r\\n\\u2028\\u2029])(?=.*\\S).+$",
});
export const KeetSourceSchema = Type.Object(
  {
    kind: Type.Literal("keet"),
    channel: Type.Union([Type.Literal("dm"), Type.Literal("group")]),
    senderLabel: KeetLabelSchema,
    destination: KeetLabelSchema,
  },
  { additionalProperties: false },
);
// JSON Schema length counts code points; the gateway capacity counts UTF-16 units.
Format.Set("matrix-label", (value) => value.length <= 255);
const MatrixLabelSchema = Type.String({
  maxLength: 255,
  format: "matrix-label",
});
export const MatrixSourceSchema = Type.Object(
  {
    kind: Type.Literal("matrix"),
    senderId: Type.String({ ...MatrixLabelSchema, minLength: 1 }),
    senderDisplayName: MatrixLabelSchema,
    roomId: Type.String({ ...MatrixLabelSchema, minLength: 1 }),
  },
  { additionalProperties: false },
);
export type MatrixSource = Static<typeof MatrixSourceSchema>;
export const MessageSourceSchema = Type.Union([
  ReminderSourceSchema,
  KeetSourceSchema,
  MatrixSourceSchema,
]);
export type KeetSource = Static<typeof KeetSourceSchema>;
export type MessageSource = Static<typeof MessageSourceSchema>;

export const MessageSchema = Type.Object(
  {
    images: Type.Optional(Type.Array(ImageRefSchema, { maxItems: 6 })),
    source: Type.Optional(MessageSourceSchema),
    id: Id,
    role: Type.Union([
      Type.Literal("user"),
      Type.Literal("agent"),
      Type.Literal("notice"),
    ]),
    text: Type.String(),
    thinking: Type.Optional(Type.String()),
    createdAt: Type.Number(),
    operationId: NullableId,
    turnId: NullableId,
  },
  { additionalProperties: false },
);
export const PageSchema = Type.Object(
  {
    messages: Type.Array(MessageSchema, { maxItems: PAGE_SIZE }),
    before: NullableId,
  },
  { additionalProperties: false },
);
export const ViewSchema = Type.Object(
  {
    version: Type.Literal(PROTOCOL_VERSION),
    sessionId: Id,
    name: Type.String(),
    activeTurnId: NullableId,
    contextUsage: ContextUsageSchema,
    compaction: CompactionSchema,
    messages: Type.Array(MessageSchema, { maxItems: PAGE_SIZE }),
    before: NullableId,
    recovery: Type.Array(RecoverySchema, { maxItems: 20 }),
    capabilities: Type.Object(
      {
        text: Type.Literal(true),
        steer: Type.Literal(true),
        stop: Type.Literal(true),
        images: Type.Union([Type.Literal(false), ImageLimitsSchema]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Submission = Static<typeof SubmissionSchema>;
export const LookupSchema = Type.Union([ReceiptSchema, Type.Null()]);
export type Receipt = Static<typeof ReceiptSchema>;
export type ChatMessage = Static<typeof MessageSchema>;
export type HistoryPage = Static<typeof PageSchema>;
export type ChatView = Static<typeof ViewSchema>;
type PanelService = {
  [K in keyof PanelBackend]: (
    input: Parameters<PanelBackend[K]>[0],
    context: Context,
  ) => ReturnType<PanelBackend[K]>;
};
type SearchService = {
  [K in keyof SearchBackend]: (
    input: Parameters<SearchBackend[K]>[0],
    context: Context,
  ) => ReturnType<SearchBackend[K]>;
};
export interface ChatService extends PanelService, SearchService {
  view: ReplicatedState<ChatView>;
  compact(input: CompactInput, context: Context): Promise<CompactResult>;
  history(before: string, context: Context): Promise<HistoryPage>;
  submit(input: Submission, context: Context): Promise<Receipt>;
  lookup(operationId: string, context: Context): Promise<Receipt | null>;
  stop(turnId: string, context: Context): Promise<{ stopped: boolean }>;
}
export const Chat = defineService<ChatService>("lamplit.chat.v2");
export function validateId(value: unknown): string {
  return validate(Id, value);
}
export const capabilities: ChatView["capabilities"] = {
  text: true,
  steer: true,
  stop: true,
  images: false,
};

/** Optional image/replacement fields are omitted for ordinary text, not a second submission path. */
export function validateSubmission(value: unknown): Submission {
  const input = validate(SubmissionSchema, value);
  if (!input.text.trim() && !input.images?.length)
    throw new Error("Empty message");
  if (
    input.images &&
    (new Set(input.images.map((r) => r.attachmentId)).size !==
      input.images.length ||
      input.images.some((r) => r.availability !== "available"))
  )
    throw new Error("Invalid submitted images");
  if (input.text === "/compact" && !input.images?.length)
    throw new Error("Use native compact command");
  return input;
}
