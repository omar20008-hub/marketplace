/** Why a call to an MCP server did not give an answer. The text is safe to show a person. */
export class McpError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsafe"
      | "unreachable"
      | "unauthorized" // 401: the token is wrong or revoked
      | "forbidden" // 403: the token is known but may not do this
      | "protocol"
      | "too_large"
      | "timeout",
  ) {
    super(message);
    this.name = "McpError";
  }
}
