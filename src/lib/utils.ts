type MessageAction = {
  type: "burn" | "mint";
  amount: string;
  currency: string;
  description: string;
  txHash: string;
  discordUserId: string;
  accountAddress: string;
};
export function parseMessageContent(
  messageContent: string
): MessageAction | null {
  const result: MessageAction = {
    type: "burn",
    amount: "0",
    currency: "CHT",
    description: "",
    txHash: "",
    discordUserId: "",
    accountAddress: "",
  };

  const matches = messageContent.match(
    /(Burned|Minted) ([0-9]+) ([A-Z]{2,5}) [a-z]+.*<@([0-9]+)>(?: for (.*))?.*\(\[.*\/tx\/(0x.{64})(?:.*\/address\/(0x.{40})*)?/im
  );
  if (matches) {
    result.type = matches[1] === "Burned" ? "burn" : "mint";
    result.amount = matches[2];
    result.currency = matches[3];
    result.discordUserId = matches[4];
    result.description = (matches[5] || "").trim();
    result.txHash = matches[6];
    result.accountAddress = matches[7];
  } else {
    return null;
  }
  return result;
}

export function getEnv(key: string): string | undefined {
  try {
    if (typeof Deno !== "undefined" && Deno.env?.get) return Deno.env.get(key);
  } catch {
    // ignore
  }
  if (typeof process !== "undefined") return process.env[key];
  return undefined;
}
