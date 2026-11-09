# MCP gateway: one endpoint for the tools a person has connected

A person connects MCP servers (their n8n, a Notion server, any other) on the
**Connectors** page. The platform keeps each server's address and token, and offers
the tools of all of them at a single MCP endpoint. An agent (LangGraph or any other)
or an n8n workflow connects there once, with one key, and never holds a server's
token.

    <PUBLIC_URL>/api/mcp        (Streamable HTTP, POST only)

## Who may call it

Two keys open it. Both name a person and nothing else, so what is offered is always
that person's own servers.

| Key | For | Where it comes from |
|---|---|---|
| Agent key `ak_…` | an agent that belongs to the person | the Connectors page (agent key card) |
| Installation key `kb_…` | a workflow built from a product they installed | written into the workflow when it is installed |

Send it as `Authorization: Bearer <key>`. No key, or a revoked one, is a 401.

## Connecting a server

Connectors → Discover → **MCP server** (or Connect an account → MCP server):

- **Name**: shown to people, and the prefix of the server's tools.
- **Server address**: an `https://` address. No user name, password, query string or
  port other than 443. Addresses that lead into a private network are refused (see
  Safety).
- **Access token**: sent to the server as `Authorization: Bearer …`. Encrypted at rest
  and never shown again.
- **Use for**: *My agents and workflows* offers the server through the gateway; *Kept
  for me only* does not.

The platform asks the server for its tools before saving, so a wrong address or token
is reported on the form. Up to 10 servers per person.

## What an agent sees

Every tool is named `<server>__<tool>`, so two servers with a tool called `search` do
not collide: `n8n__search`, `notion__search`. Two servers with the same name get
`n8n` and `n8n_2`, the older keeping the plain one. A tool's description starts with
the server's name in brackets. Only tools are offered: no resources or prompts.

A server that is down is left out of the list, and the others are still offered. A
server that refuses its token is marked **Expired** on the Connectors page and stops
being offered until it is connected again.

## Using it

### From an n8n workflow

Add an **MCP Client Tool** node: endpoint `<PUBLIC_URL>/api/mcp`, transport HTTP
Streamable, authentication Bearer with the installation key the platform wrote into
the workflow.

### From LangGraph (Python), with langchain-mcp-adapters

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "platform": {
        "transport": "streamable_http",
        "url": "https://<PUBLIC_URL host>/api/mcp",
        "headers": {"Authorization": "Bearer ak_…"},
    }
})
tools = await client.get_tools()   # hand these to the agent
```

The option names are the library's; check them against the version you install.

### Connecting n8n's own MCP server

In n8n, turn on instance-level MCP access, then copy the server address and the access
token n8n shows into the form above. Workflows you expose to MCP in n8n then appear as
`<name>__<workflow tool>`.

### Notion

Notion's hosted MCP server signs people in with OAuth, which the gateway does not
support yet. A Notion MCP server that takes an integration token works today, if it
is reachable at a public https address.

## Safety

- **Addresses.** The platform makes requests to addresses people type, so it refuses
  http, credentials or queries in the address, non-standard ports, `localhost`,
  `.local`, `.internal` and `.railway.internal` names, and any name that resolves to a
  private, loopback, link-local (including the cloud metadata address) or otherwise
  non-public address, IPv4 or IPv6, including IPv4 hidden inside IPv6. Redirects are
  never followed. The name is resolved when the person connects and again for each
  call; a name that changes its answer between the two (DNS rebinding) is a narrowed
  gap, not a closed one.
- **Tokens.** Sealed with the platform's secrets key, never returned by the gateway,
  never logged. Disconnecting a server (Revoke) removes the token.
- **Limits.** 300 requests a minute per person; 1 MB per request; 2 MB per server
  answer; at most 200 tools per server; 15 s to connect, 20 s to list, 60 s per call.
  Tool names longer than 64 characters or with characters clients reject are left out.
- **What is logged.** The server's alias and the kind of failure. Never arguments,
  results or tokens.

## Not covered yet

- MCP servers that sign in with OAuth (Notion's hosted server among them).
- Scoping a server to one installation. Today every server marked for agents and
  workflows is offered to all of that person's keys.
- Resources, prompts, and server-to-client notifications. Each call stands alone: no
  session, no event stream (a GET is answered 405, which the protocol allows).
- Per-tool allow lists, and a log of tool calls the person can read.

## Verified how

The client half was run against the official MCP SDK's reference server (event-stream
and plain JSON replies, with sessions and bearer auth), and the gateway was driven by
the official SDK client with both key types. Neither has been run against a real n8n
or Notion server: the session that built it could not reach them. The first real
connection is the test that counts.
