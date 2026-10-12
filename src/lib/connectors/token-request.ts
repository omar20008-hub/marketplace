import type { ConnectorProvider } from "./providers";

/**
 * Calls a tool's token endpoint, the same way for a first sign-in and for a
 * refresh. Tools differ in two things: whether the client id and secret go in
 * an Authorization header or the body, and whether the body is a form or JSON.
 * Both are declared on the provider, so the callers do not care.
 */
export function postToTokenEndpoint(
  provider: ConnectorProvider,
  params: Record<string, string>,
): Promise<Response> {
  const clientId = provider.clientId();
  const clientSecret = provider.clientSecret();
  const basic = provider.tokenAuth === "basic";

  const fields: Record<string, string> = basic
    ? params
    : { ...params, client_id: clientId, client_secret: clientSecret };

  const headers: Record<string, string> = {};
  if (basic) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }

  let body: string;
  if (provider.tokenBody === "json") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(fields);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields).toString();
  }

  return fetch(provider.tokenUrl, { method: "POST", headers, body, cache: "no-store" });
}
