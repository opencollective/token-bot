type JsonRpcId = string | number | null;

type JsonObject = Record<string, unknown>;

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface UserPermissionsToolInput {
  guildId: string;
  userId: string;
}

export interface McpToolExecutors {
  checkUserPermissions(input: UserPermissionsToolInput): Promise<unknown>;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

const CHECK_USER_PERMISSIONS_TOOL: McpToolDefinition = {
  name: "check_user_permissions",
  description:
    "Check what a Discord user is allowed to do in token-bot for a guild, including token issuance, room booking, and shift actions.",
  inputSchema: {
    type: "object",
    properties: {
      guildId: {
        type: "string",
        description: "Discord guild/server ID.",
      },
      userId: {
        type: "string",
        description: "Discord user ID to inspect.",
      },
    },
    required: ["guildId", "userId"],
    additionalProperties: false,
  },
};

export function getMcpTools(): McpToolDefinition[] {
  return [CHECK_USER_PERMISSIONS_TOOL];
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  const error: JsonObject = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function parseUserPermissionsInput(value: unknown): UserPermissionsToolInput | string {
  const input = asObject(value);
  if (!input) {
    return "Tool arguments must be an object";
  }

  const guildId = input.guildId;
  const userId = input.userId;
  if (typeof guildId !== "string" || guildId.trim() === "") {
    return "Missing required string argument: guildId";
  }
  if (typeof userId !== "string" || userId.trim() === "") {
    return "Missing required string argument: userId";
  }

  return { guildId, userId };
}

function buildInitializeResult() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "token-bot",
      version: "0.1.0",
    },
  };
}

function buildToolContent(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function handleMcpRequest(
  req: Request,
  executors: McpToolExecutors,
): Promise<Response> {
  let body: JsonObject;
  try {
    const parsed = await req.json();
    const object = asObject(parsed);
    if (!object) {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    body = object;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const id = (typeof body.id === "string" || typeof body.id === "number" || body.id === null)
    ? body.id
    : null;
  const method = body.method;

  if (typeof method !== "string") {
    return jsonRpcError(id, -32600, "Invalid Request");
  }

  if (method === "initialize") {
    return jsonRpcResult(id, buildInitializeResult());
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: getMcpTools() });
  }

  if (method === "tools/call") {
    const params = asObject(body.params);
    if (!params || typeof params.name !== "string") {
      return jsonRpcError(id, -32602, "Invalid params: missing tool name");
    }

    if (params.name !== CHECK_USER_PERMISSIONS_TOOL.name) {
      return jsonRpcError(id, -32601, `Unknown tool: ${params.name}`);
    }

    const input = parseUserPermissionsInput(params.arguments);
    if (typeof input === "string") {
      return jsonRpcError(id, -32602, input);
    }

    try {
      const result = await executors.checkUserPermissions(input);
      return jsonRpcResult(id, buildToolContent(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Tool execution failed";
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: "text", text: message }],
      });
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
