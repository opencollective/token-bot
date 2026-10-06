/**
 * token-bot MCP server (Streamable HTTP, JSON responses).
 *
 * Mounted at POST /mcp by src/api.ts. Clients send JSON-RPC 2.0 messages (single or batched);
 * requests get an application/json response, notifications get 202. There is no server-initiated
 * stream, so GET /mcp answers 405 as the transport allows.
 *
 * Tools fall in two groups:
 * - read tools, to prepare a proposal correctly (permissions, rooms, availability, shifts);
 * - propose_* tools, which only create a pending request: the bot asks the right Discord user to
 *   Confirm or Cancel, and nothing happens until they click (see src/lib/proposals.ts).
 */

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

/** One function per tool. Only check_user_permissions is required; tools without an executor aren't listed. */
export interface McpToolExecutors {
  checkUserPermissions(input: UserPermissionsToolInput): Promise<unknown>;
  listRooms?(input: JsonObject): Promise<unknown>;
  checkRoomAvailability?(input: JsonObject): Promise<unknown>;
  listUpcomingShifts?(input: JsonObject): Promise<unknown>;
  proposeMint?(input: JsonObject): Promise<unknown>;
  proposeShiftSignup?(input: JsonObject): Promise<unknown>;
  proposeRoomBooking?(input: JsonObject): Promise<unknown>;
  getRequestStatus?(input: JsonObject): Promise<unknown>;
}

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const str = (description: string) => ({ type: "string", description });
const GUILD_ID = str("Discord guild/server ID.");
const REQUESTED_BY = str(
  "Who is asking, for the audit log, e.g. \"elinor for <@123> in #general\". The Discord user who confirms is the one who acts.",
);
const CHANNEL_ID = str(
  "Optional. Discord channel where the request was made: the Confirm/Cancel message is posted there. Without it, the bot DMs the person who must confirm.",
);
const ISO = (what: string) => str(`${what}, ISO 8601 with timezone (e.g. 2026-10-07T17:30:00+02:00).`);

type ToolSpec = { definition: McpToolDefinition; executor: keyof McpToolExecutors };

const TOOLS: ToolSpec[] = [
  {
    executor: "checkUserPermissions",
    definition: {
      name: "check_user_permissions",
      description:
        "Check what a Discord user is allowed to do in token-bot for a guild, including token issuance, room booking, and shift actions.",
      inputSchema: {
        type: "object",
        properties: { guildId: GUILD_ID, userId: str("Discord user ID to inspect.") },
        required: ["guildId", "userId"],
        additionalProperties: false,
      },
    },
  },
  {
    executor: "listRooms",
    definition: {
      name: "list_rooms",
      description:
        "List the bookable rooms with their slug, capacity, hourly prices (tokens and euros; euro prices are excl. 21% VAT) and bookableFrom, the earliest start time (e.g. coworking only from 19:00).",
      inputSchema: {
        type: "object",
        properties: { guildId: GUILD_ID },
        required: ["guildId"],
        additionalProperties: false,
      },
    },
  },
  {
    executor: "checkRoomAvailability",
    definition: {
      name: "check_room_availability",
      description: "Check whether a room can be booked between start and end: not available when it overlaps a booking or starts before the room's bookableFrom time (then `reason` says why).",
      inputSchema: {
        type: "object",
        properties: { guildId: GUILD_ID, room: str("Room slug from list_rooms."), start: ISO("Start"), end: ISO("End") },
        required: ["guildId", "room", "start", "end"],
        additionalProperties: false,
      },
    },
  },
  {
    executor: "listUpcomingShifts",
    definition: {
      name: "list_upcoming_shifts",
      description:
        "List caretaking shifts in the coming days with who signed up, plus the standard slots, capacity, reward and timezone, to propose a shift sign-up.",
      inputSchema: {
        type: "object",
        properties: { guildId: GUILD_ID, days: { type: "integer", description: "How many days ahead (1-31, default 7).", minimum: 1, maximum: 31 } },
        required: ["guildId"],
        additionalProperties: false,
      },
    },
  },
  {
    executor: "proposeMint",
    definition: {
      name: "propose_mint",
      description:
        "Propose minting tokens. Creates a pending request only: the bot asks confirmerUserId (who must have the right to mint the token) to Confirm or Cancel. Nothing is minted until they click Confirm. Returns a requestId; follow up with get_request_status.",
      inputSchema: {
        type: "object",
        properties: {
          guildId: GUILD_ID,
          confirmerUserId: str("Discord user ID of the person who asked for the mint and has the right to mint. They confirm, and they are recorded as the minter."),
          recipientUserIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25, description: "Discord user IDs receiving the tokens." },
          amount: { type: "number", exclusiveMinimum: 0, description: "Amount per recipient." },
          token: str("Token symbol (e.g. CHT). Required when the guild has several mintable tokens."),
          description: str("Reason for the mint, shown to the confirmer and recorded with the transaction."),
          requestedBy: REQUESTED_BY,
          channelId: CHANNEL_ID,
        },
        required: ["guildId", "confirmerUserId", "recipientUserIds", "amount", "requestedBy"],
        additionalProperties: false,
      },
    },
  },
  {
    executor: "proposeShiftSignup",
    definition: {
      name: "propose_shift_signup",
      description:
        "Propose signing a member up for a caretaking shift, either an existing shift (eventId from list_upcoming_shifts) or a start/end. Creates a pending request only: the member confirms or cancels.",
      inputSchema: {
        type: "object",
        properties: {
          guildId: GUILD_ID,
          userId: str("Discord user ID of the member who will do the shift. They confirm."),
          eventId: str("Calendar event id of an existing shift (from list_upcoming_shifts). Use this or start/end."),
          start: ISO("Shift start"),
          end: ISO("Shift end"),
          email: str("Optional email for the confirmation email and calendar invite; saved only if the member confirms."),
          requestedBy: REQUESTED_BY,
          channelId: CHANNEL_ID,
        },
        required: ["guildId", "userId", "requestedBy"],
        additionalProperties: false,
      },
    },
  },
  {
    executor: "proposeRoomBooking",
    definition: {
      name: "propose_room_booking",
      description:
        "Propose a room booking. Creates a pending request only: the member confirms, then picks how to pay in the regular /book flow (they pay with their own balance).",
      inputSchema: {
        type: "object",
        properties: {
          guildId: GUILD_ID,
          userId: str("Discord user ID of the member who books and pays. They confirm."),
          room: str("Room slug from list_rooms."),
          start: ISO("Start"),
          end: ISO("End"),
          title: str("Event name shown in the calendar."),
          guestName: str("Optional: book for a guest; their name."),
          guestEmail: str("Optional: the guest's email (gets the confirmation and calendar invite)."),
          requestedBy: REQUESTED_BY,
          channelId: CHANNEL_ID,
        },
        required: ["guildId", "userId", "room", "start", "end", "title", "requestedBy"],
        additionalProperties: false,
      },
    },
  },
  {
    executor: "getRequestStatus",
    definition: {
      name: "get_request_status",
      description:
        "Status of a request created by a propose_* tool: pending, confirmed, cancelled, expired (after 24 hours), failed, or handed_off (a room booking continued in /book, where the member pays).",
      inputSchema: {
        type: "object",
        properties: { requestId: str("The requestId returned by a propose_* tool.") },
        required: ["requestId"],
        additionalProperties: false,
      },
    },
  },
];

/** Tools to list: all of them, or only those with an executor when executors are given. */
export function getMcpTools(executors?: McpToolExecutors): McpToolDefinition[] {
  return TOOLS.filter((t) => !executors || typeof executors[t.executor] === "function").map((t) => t.definition);
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** Check arguments against the tool's schema (required, types). Returns an error message or null. */
export function validateArguments(schema: JsonObject, args: JsonObject): string | null {
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  for (const key of (schema.required ?? []) as string[]) {
    const type = properties[key]?.type;
    const value = args[key];
    const missing = value === undefined || value === null || (type === "string" && typeof value === "string" && value.trim() === "");
    if (missing) return `Missing required ${type === "array" ? "array" : type ?? ""} argument: ${key}`.replace("  ", " ");
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((k) => !(k in properties));
    if (unknown.length) return `Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop || value === undefined || value === null) continue;
    const t = prop.type;
    if (t === "string" && typeof value !== "string") return `Argument ${key} must be a string`;
    if (t === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `Argument ${key} must be a number`;
    if (t === "integer" && !Number.isInteger(value)) return `Argument ${key} must be an integer`;
    if (t === "array") {
      if (!Array.isArray(value)) return `Argument ${key} must be an array`;
      const itemType = (prop.items as JsonObject | undefined)?.type;
      if (itemType === "string" && value.some((v) => typeof v !== "string")) return `Argument ${key} must be an array of strings`;
      if (typeof prop.minItems === "number" && value.length < prop.minItems) return `Argument ${key} needs at least ${prop.minItems} item(s)`;
      if (typeof prop.maxItems === "number" && value.length > prop.maxItems) return `Argument ${key} accepts at most ${prop.maxItems} items`;
    }
    if (typeof value === "number") {
      if (typeof prop.minimum === "number" && value < prop.minimum) return `Argument ${key} must be ≥ ${prop.minimum}`;
      if (typeof prop.maximum === "number" && value > prop.maximum) return `Argument ${key} must be ≤ ${prop.maximum}`;
      if (typeof prop.exclusiveMinimum === "number" && value <= prop.exclusiveMinimum) return `Argument ${key} must be > ${prop.exclusiveMinimum}`;
    }
  }
  return null;
}

function buildToolContent(value: unknown) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

type RpcReply = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: JsonObject };

const ok = (id: JsonRpcId, result: unknown): RpcReply => ({ jsonrpc: "2.0", id, result });
const err = (id: JsonRpcId, code: number, message: string): RpcReply => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Handle one JSON-RPC message. Returns null for notifications (no reply). */
async function handleMessage(message: unknown, executors: McpToolExecutors): Promise<RpcReply | null> {
  const body = asObject(message);
  if (!body) return err(null, -32600, "Invalid Request");
  const hasId = "id" in body;
  const id = (typeof body.id === "string" || typeof body.id === "number" || body.id === null) ? body.id as JsonRpcId : null;
  const method = body.method;

  // A response from the client (we never send requests) or a notification: nothing to answer.
  if (typeof method !== "string") return hasId && ("result" in body || "error" in body) ? null : err(id, -32600, "Invalid Request");
  if (!hasId || method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    const requested = asObject(body.params)?.protocolVersion;
    const protocolVersion = typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    return ok(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "token-bot", version: "0.2.0" },
      instructions:
        "Read tools help you prepare. propose_* tools never act directly: they ask the right Discord user to Confirm or Cancel, and requests expire after 24 hours. Use get_request_status to follow up.",
    });
  }
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: getMcpTools(executors) });

  if (method === "tools/call") {
    const params = asObject(body.params);
    if (!params || typeof params.name !== "string") return err(id, -32602, "Invalid params: missing tool name");
    const spec = TOOLS.find((t) => t.definition.name === params.name);
    const run = spec ? executors[spec.executor] as ((input: never) => Promise<unknown>) | undefined : undefined;
    if (!spec || typeof run !== "function") return err(id, -32601, `Unknown tool: ${params.name}`);

    const args = asObject(params.arguments ?? {});
    if (!args) return err(id, -32602, "Tool arguments must be an object");
    const invalid = validateArguments(spec.definition.inputSchema, args);
    if (invalid) return err(id, -32602, invalid);

    try {
      const result = await run.call(executors, args as never);
      return ok(id, buildToolContent(result));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Tool execution failed";
      return ok(id, { isError: true, content: [{ type: "text", text: message }] });
    }
  }

  return err(id, -32601, `Method not found: ${method}`);
}

export async function handleMcpRequest(req: Request, executors: McpToolExecutors): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json(err(null, -32700, "Parse error"));
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return Response.json(err(null, -32600, "Invalid Request"));
    const replies = (await Promise.all(parsed.map((m) => handleMessage(m, executors)))).filter((r): r is RpcReply => r !== null);
    return replies.length ? Response.json(replies) : new Response(null, { status: 202 });
  }

  const reply = await handleMessage(parsed, executors);
  return reply ? Response.json(reply) : new Response(null, { status: 202 });
}
