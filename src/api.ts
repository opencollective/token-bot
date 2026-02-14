/**
 * HTTP API server for token-bot
 * Provides endpoints for external integrations (like Elinor)
 */

import { burnTokensFrom, getBalance, SupportedChain } from "./lib/blockchain.ts";
import { getAccountAddressFromDiscordUserId } from "./lib/citizenwallet.ts";
import { GoogleCalendarClient } from "./lib/googlecalendar.ts";
import { loadGuildFile, loadGuildSettings } from "./lib/utils.ts";
import { Nostr, URI } from "./lib/nostr.ts";
import { Product } from "./types.ts";
import { formatUnits, parseUnits } from "@wevm/viem";
import { Client, TextChannel } from "discord.js";

const API_KEY = Deno.env.get("API_KEY");
const API_PORT = parseInt(Deno.env.get("API_PORT") || "3000");

// Git info (populated at startup)
let gitSha = "unknown";
let gitMessage = "unknown";
let gitBranch = "unknown";
let startTime = new Date();

try {
  const process = new Deno.Command("git", {
    args: ["log", "-1", "--format=%H|%s|%D"],
    stdout: "piped",
  });
  const output = await process.output();
  const result = new TextDecoder().decode(output.stdout).trim();
  const [sha, message, refs] = result.split("|");
  gitSha = sha || "unknown";
  gitMessage = message || "unknown";
  // Extract branch from refs like "HEAD -> main, origin/main"
  const branchMatch = refs?.match(/HEAD -> ([^,]+)/);
  gitBranch = branchMatch?.[1] || "unknown";
} catch {
  console.warn("⚠️  Could not get git info");
}

// Helper functions
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours}h` : `${hours}h${remaining}`;
}

function formatDiscordDate(date: Date): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const dayNum = date.getDate();
  let suffix = "th";
  if (dayNum === 1 || dayNum === 21 || dayNum === 31) suffix = "st";
  else if (dayNum === 2 || dayNum === 22) suffix = "nd";
  else if (dayNum === 3 || dayNum === 23) suffix = "rd";
  return `${dayName} ${monthName} ${dayNum}${suffix}`;
}

function formatDiscordTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  const minutesStr = minutes < 10 ? `0${minutes}` : minutes.toString();
  return `${hours}:${minutesStr}${ampm}`;
}

// Response helpers
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// Auth middleware
function checkAuth(req: Request): Response | null {
  if (!API_KEY) {
    return error("API_KEY not configured", 500);
  }
  const auth = req.headers.get("Authorization");
  if (auth !== `Bearer ${API_KEY}`) {
    return error("Unauthorized", 401);
  }
  return null;
}

// Store Discord client reference
let discordClient: Client | null = null;

export function setDiscordClient(client: Client) {
  discordClient = client;
}

// Book execution endpoint
interface BookRequest {
  userId: string;
  guildId: string;
  room: string; // room slug
  start: string; // ISO datetime
  duration: number; // minutes
  eventName?: string;
  channelId?: string; // channel to post confirmation in
}

interface BookResponse {
  success: boolean;
  txHash?: string;
  eventId?: string;
  calendarUrl?: string;
  error?: string;
  balanceRequired?: number;
  balanceAvailable?: number;
  tokenSymbol?: string;
}

async function handleBookExecute(req: Request): Promise<Response> {
  const authError = checkAuth(req);
  if (authError) return authError;

  let body: BookRequest;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body");
  }

  const { userId, guildId, room, start, duration, eventName, channelId } = body;

  if (!userId || !guildId || !room || !start || !duration) {
    return error("Missing required fields: userId, guildId, room, start, duration");
  }

  try {
    // Load product
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === room);

    if (!product || !product.calendarId) {
      return error(`Room not found or not bookable: ${room}`, 404);
    }

    // Load guild settings
    const guildSettings = await loadGuildSettings(guildId);
    if (!guildSettings || guildSettings.tokens.length === 0) {
      return error("Guild not configured", 500);
    }

    const tokenConfig = guildSettings.tokens[0];
    const tokenSymbol = tokenConfig.symbol;

    // Calculate price
    const hours = duration / 60;
    const priceAmount = product.price[0].amount * hours;

    // Get user's blockchain address
    const userAddress = await getAccountAddressFromDiscordUserId(userId);

    // Check balance
    const balance = await getBalance(
      tokenConfig.chain as SupportedChain,
      tokenConfig.address,
      userAddress,
    );

    const requiredAmount = parseUnits(priceAmount.toString(), tokenConfig.decimals);

    if (balance < requiredAmount) {
      const balanceFormatted = parseFloat(formatUnits(balance, tokenConfig.decimals));
      return json({
        success: false,
        error: "Insufficient balance",
        balanceRequired: priceAmount,
        balanceAvailable: balanceFormatted,
        tokenSymbol,
      } as BookResponse);
    }

    // Process payment
    const txHash = await burnTokensFrom(
      tokenConfig.chain as SupportedChain,
      tokenConfig.address,
      userAddress,
      priceAmount.toString(),
      tokenConfig.decimals,
    );

    if (!txHash) {
      return json({ success: false, error: "Payment failed" } as BookResponse);
    }

    // Create calendar event
    const startTime = new Date(start);
    const endTime = new Date(startTime.getTime() + duration * 60000);
    const calendarClient = new GoogleCalendarClient();

    await calendarClient.ensureCalendarInList(product.calendarId);

    const bookingTime = new Date();
    const bookingDateStr = formatDiscordDate(bookingTime);
    const bookingTimeStr = formatDiscordTime(bookingTime);

    const eventDescription = `Booked by Discord user on ${bookingDateStr} at ${bookingTimeStr} for ${priceAmount.toFixed(2)} ${tokenSymbol}

To cancel, run the /cancel command in Discord.

User ID: ${userId}
Booking TX: ${txHash}
Booking Chain: ${tokenConfig.chain}`;

    const calendarEvent = await calendarClient.createEvent(product.calendarId, {
      summary: eventName || "Room Booking",
      description: eventDescription,
      start: {
        dateTime: startTime.toISOString(),
        timeZone: guildSettings.guild.timezone || "Europe/Brussels",
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: guildSettings.guild.timezone || "Europe/Brussels",
      },
    });

    const calendarUrl = `https://calendar.google.com/calendar/embed?src=${
      encodeURIComponent(product.calendarId)
    }&ctz=${encodeURIComponent(guildSettings.guild.timezone || "Europe/Brussels")}`;

    const chainId = tokenConfig.chain === "celo" ? 42220 :
                    tokenConfig.chain === "gnosis" ? 100 : 84532;
    const explorerBaseUrl = tokenConfig.chain === "celo" ? "https://celoscan.io" :
                            tokenConfig.chain === "gnosis" ? "https://gnosisscan.io" :
                            "https://sepolia.basescan.org";
    const txUrl = `${explorerBaseUrl}/tx/${txHash}`;

    // Post to transactions channel
    if (guildSettings.channels?.transactions && discordClient) {
      try {
        const guild = await discordClient.guilds.fetch(guildId);
        const transactionsChannel = await guild.channels.fetch(
          guildSettings.channels.transactions
        ) as TextChannel;

        if (transactionsChannel) {
          const dateStr = formatDiscordDate(startTime);
          const startTimeStr = formatDiscordTime(startTime);
          const endTimeStr = formatDiscordTime(endTime);

          await transactionsChannel.send(
            `🗓️ <@${userId}> booked ${product.name} for ${dateStr} from ${startTimeStr} till ${endTimeStr} for ${priceAmount.toFixed(2)} ${tokenSymbol} [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`
          );
        }
      } catch (err) {
        console.error("Error posting to transactions channel:", err);
      }
    }

    // Post to room channel
    if (product.channelId && discordClient) {
      try {
        const guild = await discordClient.guilds.fetch(guildId);
        const roomChannel = await guild.channels.fetch(product.channelId) as TextChannel;

        if (roomChannel) {
          const dateStr = formatDiscordDate(startTime);
          const startTimeStr = formatDiscordTime(startTime);
          const endTimeStr = formatDiscordTime(endTime);

          await roomChannel.send(
            `🗓️ <@${userId}> booked ${product.name} for ${dateStr} from ${startTimeStr} till ${endTimeStr} for ${priceAmount.toFixed(2)} ${tokenSymbol} [[calendar](<${calendarUrl}>)] [[tx](<${txUrl}>)]`
          );
        }
      } catch (err) {
        console.error("Error posting to room channel:", err);
      }
    }

    // Nostr annotation
    try {
      const nostr = Nostr.getInstance();
      const txUri = `ethereum:${chainId}:tx:${txHash}` as URI;

      await nostr.publishMetadata(txUri, {
        content: `Booking ${product.name} room for ${formatDuration(duration)}`,
        tags: [
          ["t", "booking"],
          ["t", product.slug],
        ],
      });
    } catch (err) {
      console.error("Error sending Nostr annotation:", err);
    }

    return json({
      success: true,
      txHash,
      eventId: calendarEvent.id,
      calendarUrl,
    } as BookResponse);
  } catch (err: any) {
    console.error("Error executing booking:", err);
    return json({
      success: false,
      error: err.message || "Unknown error",
    } as BookResponse, 500);
  }
}

// Check room availability
interface AvailabilityRequest {
  guildId: string;
  room: string;
  date: string; // ISO date (YYYY-MM-DD)
}

async function handleCheckAvailability(req: Request): Promise<Response> {
  const authError = checkAuth(req);
  if (authError) return authError;

  let body: AvailabilityRequest;
  try {
    body = await req.json();
  } catch {
    return error("Invalid JSON body");
  }

  const { guildId, room, date } = body;

  if (!guildId || !room || !date) {
    return error("Missing required fields: guildId, room, date");
  }

  try {
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const product = products?.find((p) => p.slug === room);

    if (!product || !product.calendarId) {
      return error(`Room not found: ${room}`, 404);
    }

    const calendarClient = new GoogleCalendarClient();
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const events = await calendarClient.listEvents(product.calendarId, startOfDay, endOfDay);

    return json({
      room: product.name,
      date,
      events: events.map((e) => ({
        summary: e.summary,
        start: e.start.dateTime,
        end: e.end.dateTime,
      })),
    });
  } catch (err: any) {
    console.error("Error checking availability:", err);
    return error(err.message || "Unknown error", 500);
  }
}

// List rooms
async function handleListRooms(req: Request): Promise<Response> {
  const authError = checkAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const guildId = url.searchParams.get("guildId");

  if (!guildId) {
    return error("Missing guildId parameter");
  }

  try {
    const products = (await loadGuildFile(guildId, "products.json")) as unknown as Product[];
    const rooms = products?.filter((p) => p.type === "room" && p.calendarId) || [];

    return json({
      rooms: rooms.map((r) => ({
        slug: r.slug,
        name: r.name,
        capacity: r.capacity,
        price: r.price,
      })),
    });
  } catch (err: any) {
    return error(err.message || "Unknown error", 500);
  }
}

// Request router
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS headers for all responses
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  // Handle preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let response: Response;

  // Route requests
  if (path === "/status.json" && req.method === "GET") {
    response = json({
      status: "ok",
      git: {
        sha: gitSha,
        shortSha: gitSha.slice(0, 7),
        message: gitMessage,
        branch: gitBranch,
      },
      uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
      startedAt: startTime.toISOString(),
    });
  } else if (path === "/api/book/execute" && req.method === "POST") {
    response = await handleBookExecute(req);
  } else if (path === "/api/book/availability" && req.method === "POST") {
    response = await handleCheckAvailability(req);
  } else if (path === "/api/rooms" && req.method === "GET") {
    response = await handleListRooms(req);
  } else {
    response = error("Not found", 404);
  }

  // Add CORS headers to response
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

export function startApiServer() {
  if (!API_KEY) {
    console.warn("⚠️  API_KEY not set - API endpoints will reject all requests");
  }

  console.log(`🌐 Starting API server on port ${API_PORT}`);
  console.log(`   GET  /status.json`);
  console.log(`   POST /api/book/execute`);
  console.log(`   POST /api/book/availability`);
  console.log(`   GET  /api/rooms?guildId=...`);

  Deno.serve({ port: API_PORT }, handleRequest);
}
