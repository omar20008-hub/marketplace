/**
 * What the Orchestrator needs from any language model, and nothing provider-specific.
 *
 * Each provider (Gemini today; Anthropic or OpenAI later) is one file that maps
 * these shapes to its own wire format. The engine only ever sees these types, so
 * changing provider means writing an adapter, not touching the engine.
 */

export type JsonSchema = Record<string, unknown>;

export type ToolSpec = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * Provider data the model needs back on the next request (Gemini's thought
   * signature). Only the adapter reads it; the engine passes it through untouched.
   */
  providerState?: unknown;
};

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ModelRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
};

export type ModelReply = {
  text: string;
  toolCalls: ToolCall[];
};

export interface ChatModel {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelReply>;
}

/** Busy, rate-limited or unreachable. The engine may answer with the next model instead. */
export class ModelUnavailableError extends Error {
  override name = "ModelUnavailableError";
}

/** Refused for a reason another model would also hit (bad key, bad request, blocked content). */
export class ModelError extends Error {
  override name = "ModelError";
}
