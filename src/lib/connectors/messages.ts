/** What the person is told when a tool's sign-in comes back with ?connect_error=tool_… */
export const TOOL_CONNECT_ERRORS: Record<string, string> = {
  tool_not_configured: "This tool is not set up on the server yet, so it cannot be connected.",
  tool_state: "That sign-in link expired or was not started here. Try connecting again.",
  tool_denied: "The tool's sign-in was declined, so nothing was connected.",
  tool_token: "The tool did not issue a connection. Try again in a moment.",
  tool_identity: "The tool did not confirm which account this is. Try connecting again.",
  tool_failed: "The tool could not complete the connection. Try again in a moment.",
};

export function isToolConnectError(code: string | undefined): boolean {
  return code !== undefined && Object.hasOwn(TOOL_CONNECT_ERRORS, code);
}
