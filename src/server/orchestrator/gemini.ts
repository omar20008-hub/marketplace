import {
  ModelError,
  ModelUnavailableError,
  type ChatMessage,
  type ChatModel,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
} from "./model";

/**
 * Gemini behind the provider-neutral ChatModel. Only this file knows Gemini's
 * wire format: the engine above it sees ChatMessage and ToolCall and nothing else.
 */

type Part = {
  text?: string;
  /** Gemini 3 sends this with a function call and rejects the next request without it. */
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
};

type GeminiState = { thoughtSignature?: string };

function signatureOf(call: ToolCall): string | undefined {
  return (call.providerState as GeminiState | undefined)?.thoughtSignature;
}

type Content = { role: "user" | "model"; parts: Part[] };

type GeminiResponse = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 30_000;

function toContents(messages: ChatMessage[]): Content[] {
  const contents: Content[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content }] });
    } else if (message.role === "assistant") {
      const parts: Part[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        const signature = signatureOf(call);
        parts.push({
          functionCall: { name: call.name, args: call.args },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
      contents.push({ role: "model", parts });
    } else {
      // Gemini wants every result for one model turn in a single user turn.
      const part: Part = {
        functionResponse: { name: message.name, response: { result: message.content } },
      };
      const last = contents.at(-1);
      if (last && last.role === "user" && last.parts.every((p) => p.functionResponse)) {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
    }
  }
  return contents;
}

function toReply(body: GeminiResponse): ModelReply {
  const candidate = body.candidates?.[0];
  if (!candidate) {
    const reason = body.promptFeedback?.blockReason;
    throw new ModelError(reason ? `Gemini blocked the request: ${reason}` : "Gemini sent no candidate");
  }

  const parts = candidate.content?.parts ?? [];
  const text = parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  // Gemini may put the signature on a text part that comes before the calls; it
  // belongs to the turn, so the first call carries it when its own part has none.
  const turnSignature = parts.find((part) => part.thoughtSignature)?.thoughtSignature;
  const toolCalls: ToolCall[] = [];
  parts.forEach((part, index) => {
    if (!part.functionCall) return;
    const own = part.thoughtSignature ?? (toolCalls.length === 0 ? turnSignature : undefined);
    toolCalls.push({
      id: `call_${index}`,
      name: part.functionCall.name,
      args: part.functionCall.args ?? {},
      ...(own ? { providerState: { thoughtSignature: own } satisfies GeminiState } : {}),
    });
  });

  if (!text && toolCalls.length === 0) {
    throw new ModelError(`Gemini ended without an answer (${candidate.finishReason ?? "no reason"})`);
  }
  return { text, toolCalls };
}

export function createGeminiModel({
  apiKey,
  model,
  temperature = 0.2,
  fetchImpl = fetch,
}: {
  apiKey: string;
  model: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
}): ChatModel {
  return {
    name: `gemini:${model}`,
    async generate(request: ModelRequest): Promise<ModelReply> {
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: toContents(request.messages),
        tools: request.tools.length
          ? [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ]
          : undefined,
        generationConfig: { temperature },
      };

      let response: Response;
      try {
        response = await fetchImpl(`${ENDPOINT}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new ModelUnavailableError(`Gemini request failed: ${(error as Error).message}`);
      }

      if (!response.ok) {
        const message = `Gemini answered ${response.status}`;
        if (response.status === 429 || response.status >= 500) throw new ModelUnavailableError(message);
        throw new ModelError(message);
      }

      return toReply((await response.json()) as GeminiResponse);
    },
  };
}
