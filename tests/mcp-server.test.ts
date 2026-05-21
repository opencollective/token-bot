import { assertEquals, assertExists } from "jsr:@std/assert@1.0.13";
import { getMcpTools, handleMcpRequest } from "../src/mcp/server.ts";

function mcpRequest(body: unknown): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function json(response: Response): Promise<any> {
  return await response.json();
}

Deno.test("MCP tools list exposes the user permissions tool schema", () => {
  const tools = getMcpTools();
  const permissionsTool = tools.find((tool) => tool.name === "check_user_permissions");

  assertExists(permissionsTool);
  assertEquals(permissionsTool.inputSchema.required, ["guildId", "userId"]);
});

Deno.test("MCP initialize returns token-bot server capabilities", async () => {
  const response = await handleMcpRequest(
    mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    {
      checkUserPermissions: async () => ({}),
    },
  );

  const body = await json(response);
  assertEquals(body.jsonrpc, "2.0");
  assertEquals(body.id, 1);
  assertEquals(body.result.serverInfo.name, "token-bot");
  assertExists(body.result.capabilities.tools);
});

Deno.test("MCP tools/call executes check_user_permissions", async () => {
  let received: unknown;
  const response = await handleMcpRequest(
    mcpRequest({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: {
        name: "check_user_permissions",
        arguments: { guildId: "guild-1", userId: "user-1" },
      },
    }),
    {
      checkUserPermissions: async (input) => {
        received = input;
        return {
          userId: input.userId,
          actions: {
            issueTokens: { allowed: true, tokens: [{ symbol: "CHT" }] },
          },
        };
      },
    },
  );

  const body = await json(response);
  assertEquals(received, { guildId: "guild-1", userId: "user-1" });
  assertEquals(body.id, "call-1");
  assertEquals(body.result.content[0].type, "text");
  assertEquals(body.result.content[0].text.includes('"userId": "user-1"'), true);
});

Deno.test("MCP tools/call validates required permission arguments", async () => {
  const response = await handleMcpRequest(
    mcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "check_user_permissions",
        arguments: { guildId: "guild-1" },
      },
    }),
    {
      checkUserPermissions: async () => {
        throw new Error("should not run");
      },
    },
  );

  const body = await json(response);
  assertEquals(body.id, 2);
  assertEquals(body.error.code, -32602);
  assertEquals(body.error.message, "Missing required string argument: userId");
});
