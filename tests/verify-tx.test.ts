import { expect } from "@std/expect/expect";
import { parseMessageContent } from "../src/lib/utils.ts";

const messages = [
  "Minted 9 CHT to <@197741353772384256> for Heartbeat 1/9 (level 4) #heartbeat ([tx](<https://celoscan.io/tx/0xa1e6f912b88c0ad485ee22d097bde750e4ec3b13b16a32f3f013c618875f84f0>))",
  "Burned 10 CHT for <@247491094709796865> for monthly contribution for shifters role ([tx](<https://celoscan.io/tx/0xb6ba6127f2594dfeccc6836c86dd7a564398c587f2b7f26e283e3b0a4c5e4fb6>)), new balance: 40 CHT ([View account](<https://txinfo.xyz/celo/address/0x666f012DEfe0972fC00849D8C98d2Fc986DC88bE>))",
  "Minted 3 CHT for <@1231683412855619645> for Toilet steward role ([tx](<https://celoscan.io/tx/0x67f9da1c1dadd9aa9cfdd739033cb9df3f1d50c1cd3ac530a1926961ad0a8c7f>)), new balance: 33 CHT ([View account](<https://txinfo.xyz/celo/address/0x9d840633d06D97d6E27BFd72ed8F57737DBC159b>))",
  "Minted 3 CHT for <@1283396134055972906> for Kitchen steward role ([tx](<https://celoscan.io/tx/0x67f9da1c1dadd9aa9cfdd739033cb9df3f1d50c1cd3ac530a1926961ad0a8c7f>)), new balance: 218 CHT ([View account](<https://txinfo.xyz/celo/address/0x163b9Eb3604c49Ab48eB7c83cD048a61F5bc8488>))",
  "Minted 1 CHT for <@337769522100568076> for Note taker steward role ([tx](<https://celoscan.io/tx/0x63fa907cf0d9722e4cbe66ac61732dad0c9081269824d0a4af7da6142d552f8d>)), new balance: 192.75 CHT ([View account](<https://txinfo.xyz/celo/address/0x4088abE77cC9c0dee85cad3267A319beA40B55cd>))",
  "Burned 3 CHT for <@1184447565366825012> for monthly contribution for coworker role ([tx](<https://celoscan.io/tx/0xd693db98cca17efb13fb683df64bf40ad296b97f7020e1ce7f1a90908a8687eb>)), new balance: 58 CHT ([View account](<https://txinfo.xyz/celo/address/0x1f06128Eca14a0ad7c506Bd72E186FAefE632ECB>))",
  "Burned 10 CHT for <@618897639836090398> for monthly contribution for shifters role ([tx](<https://celoscan.io/tx/0xd693db98cca17efb13fb683df64bf40ad296b97f7020e1ce7f1a90908a8687eb>)), new balance: 517 CHT ([View account](<https://txinfo.xyz/celo/address/0x9a7B88480594198A20455ddc10c253909c1E2f3D>))",
];

Deno.test("should verify tx", () => {
  const messageActions = messages.map((message) =>
    parseMessageContent(message)
  );
  expect(messageActions[0]).not.toBeNull();
  expect(messageActions[0]?.type).toBe("mint");
  expect(messageActions[0]?.amount).toBe("9");
  expect(messageActions[0]?.currency).toBe("CHT");
  expect(messageActions[0]?.description).toBe(
    "Heartbeat 1/9 (level 4) #heartbeat"
  );
  expect(messageActions[0]?.txHash).toBe(
    "0xa1e6f912b88c0ad485ee22d097bde750e4ec3b13b16a32f3f013c618875f84f0"
  );
  expect(messageActions[0]?.discordUserId).toBe("197741353772384256");
  expect(messageActions[0]?.accountAddress).toBe(undefined);
  expect(messageActions.length).toBe(messages.length);
  expect(messageActions[1]).not.toBeNull();
  expect(messageActions[1]?.type).toBe("burn");
  expect(messageActions[1]?.amount).toBe("10");
  expect(messageActions[1]?.currency).toBe("CHT");
  expect(messageActions[1]?.discordUserId).toBe("247491094709796865");
  expect(messageActions[1]?.txHash).toBe(
    "0xb6ba6127f2594dfeccc6836c86dd7a564398c587f2b7f26e283e3b0a4c5e4fb6"
  );
  expect(messageActions[1]?.accountAddress).toBe(
    "0x666f012DEfe0972fC00849D8C98d2Fc986DC88bE"
  );
});
