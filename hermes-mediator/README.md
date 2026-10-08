# Hermes mediator

A loopback service that sits between Hermes tenants and the upstream model
provider. Tenants never receive the provider key. Each tenant has its own
token and a prepaid credit balance. Every request reserves credit before it
is forwarded and settles the actual cost after the response.

Stdlib only, Python 3.9+. No provider is configured yet: `config.example.json`
uses placeholders with zero prices.

## Files

| File | Purpose |
|---|---|
| `mediator.py` | HTTP server: auth, reservation, forwarding, settlement |
| `ledger.py` | SQLite ledger (balances, usage) and cost rounding |
| `admin.py` | Operator CLI: create tenants, add credit, disable |
| `test_mediator.py` | Tests against a fake upstream on loopback |
| `config.example.json` | Settings template (no secrets) |

## Endpoints

- `POST /v1/chat/completions`: OpenAI chat format, streaming supported.
- `GET /v1/models`: lists public model names only, requires a tenant token.
- `GET /healthz`: liveness, no auth.

Anything else returns 404.

## Behaviour

- **Auth:** `Authorization: Bearer <tenant token>`. The ledger stores only
  the SHA-256 of each token.
- **Model allowlist:** only names in `models` are accepted. Upstream model
  IDs are never exposed.
- **Output cap:** `max_tokens` is capped at `max_output_tokens`. A missing
  value gets `default_output_tokens`.
- **Reservation:** before forwarding, the mediator holds a conservative
  estimate (prompt length divided by 2, plus the output cap). If the balance
  is short, the request gets 402 and nothing is sent upstream.
- **Settlement:** the actual cost, from the provider's `usage`, replaces the
  hold. Costs round up. If the provider sends no usage on a stream, the full
  hold is charged.
- **Failure:** any upstream error or internal exception refunds the hold. The
  client gets a generic 502 or 500. Upstream error bodies are never relayed.
- **Concurrency:** at most `per_tenant_concurrency` in-flight requests per
  tenant. Extra requests get 429.
- **Limits:** request bodies above `max_body_bytes` get 413.
- **Logs:** one JSON line per request with tenant, model, status, token
  counts, cost and latency. Never bodies, headers, tokens or keys.

## Operating it

1. Copy `config.example.json` and set `upstream_base_url`, the model mapping
   and prices, all in micro-USD per million tokens.
2. Write the upstream key to `upstream_key_file`. Mode must be 600 or
   stricter, owned by the mediator user. The service refuses to start
   otherwise.
3. Create a tenant:

   ```
   python3 admin.py --db /var/lib/hermes-mediator/ledger.sqlite create-tenant acme 5000000
   ```

   The token is printed once. Put it in the tenant's config only.
4. Run: `python3 mediator.py /etc/hermes-mediator/config.json`
5. Tests: `python3 -m unittest -v test_mediator` from this directory.

## Not done yet

- **Provider format.** Only OpenAI chat/completions is supported. An
  Anthropic-format provider needs an adapter, not a change to this code.
- **Tool-call validation.** Tool calls are passed through unchanged. The
  tenant's Hermes validates and runs them.
- **Upstream stream options.** `stream_options.include_usage` is sent on
  streams. Some providers reject it. Confirm this with the real provider
  before launch.
- **Ledger backups and rotation.** The SQLite file needs a backup plan.
- **Deployment.** This is not yet a systemd unit, and it runs under no
  dedicated user. That comes after the provider is chosen.
- **Live test.** Nothing here has run against a real provider.
