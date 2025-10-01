import { expect } from "@std/expect/expect";
import { getAccountAddressFromDiscordUserId } from "../src/lib/citizenwallet.ts";

Deno.test("should get account address from user id", async () => {
  const accountAddress = await getAccountAddressFromDiscordUserId(
    "618897639836090398"
  );
  console.log(accountAddress);
  expect(accountAddress).toBe("0x9a7B88480594198A20455ddc10c253909c1E2f3D");
});
