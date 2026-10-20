/**
 * Web search for the Orchestrator, through the same text relay the n8n tool uses.
 * The query is the only thing sent out: the model never chooses a URL, so this
 * cannot be pointed at internal addresses.
 */

const SEARCH_URL = "https://r.jina.ai/https://html.duckduckgo.com/html/?q=";
const TIMEOUT_MS = 25_000;
const MAX_CHARS = 6000;

function failure(errorType: string): string {
  return JSON.stringify({ result: "error", errorType });
}

export function createWebSearch({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) {
  return async function webSearch(query: string): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(SEARCH_URL + encodeURIComponent(query), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      console.error("Orchestrator web search failed", error);
      return failure("search_unavailable");
    }

    if (!response.ok) {
      console.error(`Orchestrator web search answered ${response.status}`);
      return failure("search_unavailable");
    }
    return (await response.text()).slice(0, MAX_CHARS);
  };
}
