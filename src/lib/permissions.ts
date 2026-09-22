import type { GuildSettings, Product, Token } from "../types.ts";

export const CHT_MINTER_ROLE_ID = "1480923356013269044";

export interface ShiftsPermissionSettings {
  calendarId?: string;
  shiftsMasterRoleId?: string;
}

export interface UserPermissionReportParams {
  userId: string;
  isAdministrator: boolean;
  roleIds: string[];
  guildSettings?: GuildSettings | null;
  products?: Product[] | null;
  shiftsSettings?: ShiftsPermissionSettings | null;
  disabledCalendarIds?: Set<string>;
}

export interface TokenPermission {
  symbol: string;
  name: string;
  allowed: boolean;
  reason: string;
  minterRoleId?: string;
}

export interface RoomPermission {
  slug: string;
  name: string;
  allowed: boolean;
  reason: string;
  calendarId?: string;
}

export interface UserPermissionReport {
  userId: string;
  isAdministrator: boolean;
  roleIds: string[];
  actions: {
    issueTokens: {
      allowed: boolean;
      reason: string;
      tokens: TokenPermission[];
    };
    bookRoom: {
      allowed: boolean;
      reason: string;
      rooms: RoomPermission[];
    };
    signUpForShift: {
      allowed: boolean;
      reason: string;
    };
    rewardShift: {
      allowed: boolean;
      reason: string;
    };
    createRetroactiveShift: {
      allowed: boolean;
      reason: string;
    };
  };
}

function hasRole(roleIds: string[], roleId?: string): boolean {
  return Boolean(roleId && roleIds.includes(roleId));
}

function isMintable(token: Token): boolean {
  return token.mintable === true;
}

function buildTokenPermission(
  token: Token,
  isAdministrator: boolean,
  roleIds: string[],
): TokenPermission {
  if (isAdministrator) {
    return {
      symbol: token.symbol,
      name: token.name,
      allowed: true,
      reason: "server administrator",
      minterRoleId: token.minterRoleId,
    };
  }

  if (hasRole(roleIds, token.minterRoleId)) {
    return {
      symbol: token.symbol,
      name: token.name,
      allowed: true,
      reason: `has minter role <@&${token.minterRoleId}>`,
      minterRoleId: token.minterRoleId,
    };
  }

  return {
    symbol: token.symbol,
    name: token.name,
    allowed: false,
    reason: token.minterRoleId
      ? `requires <@&${token.minterRoleId}> or Administrator`
      : "requires Administrator",
    minterRoleId: token.minterRoleId,
  };
}

function buildBookableRooms(
  products: Product[] | null | undefined,
  disabledCalendarIds: Set<string>,
): RoomPermission[] {
  return (products || [])
    .filter((product) => product.type === "room")
    .map((product) => {
      if (!product.calendarId) {
        return {
          slug: product.slug,
          name: product.name,
          allowed: false,
          reason: "room has no calendar configured",
          calendarId: product.calendarId,
        };
      }
      if (disabledCalendarIds.has(product.calendarId)) {
        return {
          slug: product.slug,
          name: product.name,
          allowed: false,
          reason: "room calendar is currently disabled",
          calendarId: product.calendarId,
        };
      }
      return {
        slug: product.slug,
        name: product.name,
        allowed: true,
        reason: "room is configured and calendar is writable",
        calendarId: product.calendarId,
      };
    });
}

function shiftsMasterReason(
  isAdministrator: boolean,
  roleIds: string[],
  shiftsSettings?: ShiftsPermissionSettings | null,
): { allowed: boolean; reason: string } {
  if (!shiftsSettings?.calendarId) {
    return { allowed: false, reason: "shifts are not configured" };
  }
  if (isAdministrator) {
    return { allowed: true, reason: "server administrator" };
  }
  if (hasRole(roleIds, shiftsSettings.shiftsMasterRoleId)) {
    return {
      allowed: true,
      reason: `has shifts master role <@&${shiftsSettings.shiftsMasterRoleId}>`,
    };
  }
  if (hasRole(roleIds, CHT_MINTER_ROLE_ID)) {
    return { allowed: true, reason: `has CHT minter role <@&${CHT_MINTER_ROLE_ID}>` };
  }
  return {
    allowed: false,
    reason: shiftsSettings.shiftsMasterRoleId
      ? `requires <@&${shiftsSettings.shiftsMasterRoleId}>, <@&${CHT_MINTER_ROLE_ID}>, or Administrator`
      : `requires <@&${CHT_MINTER_ROLE_ID}> or Administrator`,
  };
}

export function buildUserPermissionReport(
  params: UserPermissionReportParams,
): UserPermissionReport {
  const roleIds = [...new Set(params.roleIds)];
  const mintableTokens = (params.guildSettings?.tokens || []).filter(isMintable);
  const tokenPermissions = mintableTokens.map((token) =>
    buildTokenPermission(token, params.isAdministrator, roleIds)
  );
  const allowedTokens = tokenPermissions.filter((token) => token.allowed);

  const rooms = buildBookableRooms(params.products, params.disabledCalendarIds || new Set());
  const allowedRooms = rooms.filter((room) => room.allowed);

  const shiftsConfigured = Boolean(params.shiftsSettings?.calendarId);
  const master = shiftsMasterReason(params.isAdministrator, roleIds, params.shiftsSettings);

  return {
    userId: params.userId,
    isAdministrator: params.isAdministrator,
    roleIds,
    actions: {
      issueTokens: {
        allowed: allowedTokens.length > 0,
        reason: allowedTokens.length > 0
          ? `can issue ${allowedTokens.map((token) => token.symbol).join(", ")}`
          : mintableTokens.length > 0
          ? "no matching token minter role"
          : "no mintable tokens configured",
        tokens: tokenPermissions,
      },
      bookRoom: {
        allowed: allowedRooms.length > 0,
        reason: allowedRooms.length > 0
          ? `can book ${allowedRooms.map((room) => room.name).join(", ")}`
          : rooms.length > 0
          ? "no rooms with writable calendars are available"
          : "no bookable rooms configured",
        rooms: allowedRooms,
      },
      signUpForShift: {
        allowed: shiftsConfigured,
        reason: shiftsConfigured ? "shifts are configured" : "shifts are not configured",
      },
      rewardShift: master,
      createRetroactiveShift: master,
    },
  };
}

function formatAllowedList(values: string[], empty: string): string {
  return values.length > 0 ? values.join(", ") : empty;
}

export function formatUserPermissionReport(report: UserPermissionReport): string {
  const issue = report.actions.issueTokens;
  const book = report.actions.bookRoom;
  const signup = report.actions.signUpForShift;
  const reward = report.actions.rewardShift;
  const retro = report.actions.createRetroactiveShift;

  const allowedTokenSymbols = issue.tokens
    .filter((token) => token.allowed)
    .map((token) => token.symbol);
  const deniedTokenLines = issue.tokens
    .filter((token) => !token.allowed)
    .map((token) => `  • ${token.symbol}: ${token.reason}`);

  const lines = [
    `**🔐 Permissions for <@${report.userId}>**`,
    "",
    `${issue.allowed ? "✅" : "❌"} Issue tokens: ${
      issue.allowed ? formatAllowedList(allowedTokenSymbols, "none") : issue.reason
    }`,
  ];

  if (deniedTokenLines.length > 0) {
    lines.push(...deniedTokenLines);
  }

  lines.push(
    `${book.allowed ? "✅" : "❌"} Book a room: ${
      book.allowed ? formatAllowedList(book.rooms.map((room) => room.name), "none") : book.reason
    }`,
    `${signup.allowed ? "✅" : "❌"} Sign up for a shift: ${signup.reason}`,
    `${reward.allowed ? "✅" : "❌"} Reward shifts: ${reward.reason}`,
    `${retro.allowed ? "✅" : "❌"} Create retroactive shifts: ${retro.reason}`,
  );

  return lines.join("\n");
}
