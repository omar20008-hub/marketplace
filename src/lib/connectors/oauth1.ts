import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import type { ConnectorProvider } from "./providers";

/**
 * OAuth 1.0a, for the tools that have no OAuth 2 (Trello). Three calls signed
 * with the app's secret, then the person's approval in between:
 *
 *   1. request token  (signed with the app key and secret)
 *   2. the person approves on the tool's own page, which returns a verifier
 *   3. access token   (signed with the app secret and the request token's secret)
 *
 * Signing follows RFC 5849: percent-encode everything, sort the parameters, and
 * HMAC-SHA1 the base string with "consumerSecret&tokenSecret" as the key.
 */

/** RFC 3986 percent-encoding: unlike encodeURIComponent, it also escapes !'()*. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The HMAC-SHA1 signature of one request, as RFC 5849 section 3.4 defines it. */
export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const base = new URL(url);
  const baseUrl = `${base.protocol}//${base.host}${base.pathname}`;

  // Parameters from the query string count too, so they are part of the base string.
  const all: [string, string][] = [
    ...Array.from(base.searchParams.entries()),
    ...Object.entries(params),
  ].map(([key, value]) => [percentEncode(key), percentEncode(value)]);
  all.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aKey < bKey ? -1 : 1,
  );

  const normalized = all.map(([key, value]) => `${key}=${value}`).join("&");
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join("&");
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", key).update(baseString).digest("base64");
}

function protocolParams(consumerKey: string, extra: Record<string, string>) {
  return {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extra,
  };
}

function parseTokenAnswer(text: string): { token: string; secret: string } | null {
  const answer = new URLSearchParams(text);
  const token = answer.get("oauth_token");
  const secret = answer.get("oauth_token_secret");
  return token && secret ? { token, secret } : null;
}

/** Step 1. The callback carries the nonce that binds this sign-in to its cookie. */
export async function requestToken(
  provider: ConnectorProvider,
  callback: string,
): Promise<{ token: string; secret: string } | null> {
  const oauth = provider.oauth1;
  if (!oauth) return null;
  const consumerKey = provider.clientId();
  const consumerSecret = provider.clientSecret();

  const params = protocolParams(consumerKey, { oauth_callback: callback });
  const signed = {
    ...params,
    oauth_signature: oauthSignature("POST", oauth.requestTokenUrl, params, consumerSecret, ""),
  };
  const response = await fetch(oauth.requestTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signed).toString(),
    cache: "no-store",
  });
  if (!response.ok) return null;
  return parseTokenAnswer(await response.text());
}

/** Step 2. Where the person is sent to approve the app. `expiration=never` keeps the grant from lapsing. */
export function approvalUrl(provider: ConnectorProvider, token: string): string {
  const oauth = provider.oauth1;
  if (!oauth) throw new Error("not an OAuth 1.0a provider");
  const params = new URLSearchParams({
    oauth_token: token,
    scope: oauth.scope,
    expiration: "never",
    name: "Builder",
  });
  return `${provider.authorizeUrl}?${params.toString()}`;
}

/** Step 3. Trades the approved request token and its verifier for the access token. */
export async function accessToken(
  provider: ConnectorProvider,
  input: { token: string; secret: string; verifier: string },
): Promise<{ token: string; secret: string } | null> {
  const oauth = provider.oauth1;
  if (!oauth) return null;
  const consumerKey = provider.clientId();
  const consumerSecret = provider.clientSecret();

  const params = protocolParams(consumerKey, {
    oauth_token: input.token,
    oauth_verifier: input.verifier,
  });
  const signed = {
    ...params,
    oauth_signature: oauthSignature("POST", oauth.accessTokenUrl, params, consumerSecret, input.secret),
  };
  const response = await fetch(oauth.accessTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(signed).toString(),
    cache: "no-store",
  });
  if (!response.ok) return null;
  return parseTokenAnswer(await response.text());
}

/** Trello authenticates its API calls with the app key and the person's token as query parameters. */
export function identityRequestUrl(provider: ConnectorProvider, token: string): string {
  const params = new URLSearchParams({ key: provider.clientId(), token });
  return `${provider.identityUrl}?${params.toString()}`;
}
