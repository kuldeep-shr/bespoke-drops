import { describe, it, expect } from "vitest";
import "./setup";
import { Drop } from "../models/Drop";
import { Wallet } from "../models/Wallet";
import { Hold } from "../models/Hold";
import { Purchase } from "../models/Purchase";
import { claim } from "../services/claimService";
import { pay } from "../services/payService";
import { cancel } from "../services/cancelService";
import { topUp } from "../services/walletService";

const liveDrop = (over = {}) =>
  Drop.create({
    itemName: "X",
    totalStock: 5,
    available: 5,
    pricePerUnit: 100,
    goLiveAt: new Date(Date.now() - 1000),
    maxPerUser: 5,
    ...over,
  });

describe("cancel + refund", () => {
  it("cancelling an active hold returns the stock", async () => {
    const drop = await liveDrop({ totalStock: 3, available: 3 });
    const { hold } = await claim({
      dropId: drop.id,
      userId: "alice",
      units: 2,
    });
    expect((await Drop.findById(drop.id))!.available).toBe(1);
    const out = await cancel({ holdId: hold.id, userId: "alice" });
    expect(out.stockReturned).toBe(2);
    expect(out.refunded).toBe(0);
    expect((await Drop.findById(drop.id))!.available).toBe(3);
    expect((await Hold.findById(hold.id))!.status).toBe("cancelled");
  });

  it("cancelling a paid hold refunds coins and restocks", async () => {
    const drop = await liveDrop();
    await Wallet.create({ userId: "alice", balance: 1000 });
    const { hold } = await claim({
      dropId: drop.id,
      userId: "alice",
      units: 2,
    });
    await pay({ holdId: hold.id, userId: "alice" });
    expect((await Wallet.findOne({ userId: "alice" }))!.balance).toBe(800);

    const out = await cancel({ holdId: hold.id, userId: "alice" });
    expect(out.refunded).toBe(200);
    expect(out.stockReturned).toBe(2);
    expect((await Wallet.findOne({ userId: "alice" }))!.balance).toBe(1000); // fully refunded
    expect(await Purchase.countDocuments({ holdId: hold.id })).toBe(0); // purchase gone
    expect((await Drop.findById(drop.id))!.available).toBe(5); // stock back
  });

  it("double-cancel is idempotent — refunds and restocks once", async () => {
    const drop = await liveDrop();
    await Wallet.create({ userId: "alice", balance: 1000 });
    const { hold } = await claim({
      dropId: drop.id,
      userId: "alice",
      units: 1,
    });
    await pay({ holdId: hold.id, userId: "alice" });

    const [a, b] = await Promise.allSettled([
      cancel({ holdId: hold.id, userId: "alice" }),
      cancel({ holdId: hold.id, userId: "alice" }),
    ]);
    const ok = [a, b].filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1); // exactly one cancel wins
    expect((await Wallet.findOne({ userId: "alice" }))!.balance).toBe(1000); // refunded once
    expect((await Drop.findById(drop.id))!.available).toBe(5); // restocked once
  });

  it("can't cancel someone else's hold", async () => {
    const drop = await liveDrop();
    const { hold } = await claim({
      dropId: drop.id,
      userId: "alice",
      units: 1,
    });
    await expect(
      cancel({ holdId: hold.id, userId: "bob" }),
    ).rejects.toMatchObject({ code: "NOT_OWNER" });
  });
});

describe("wallet top-up", () => {
  it("credits an existing wallet atomically", async () => {
    await Wallet.create({ userId: "bob", balance: 100 });
    const out = await topUp({ userId: "bob", amount: 250 });
    expect(out.balance).toBe(350);
  });
  it("creates a wallet on first top-up", async () => {
    const out = await topUp({ userId: "newuser", amount: 500 });
    expect(out.balance).toBe(500);
  });
  it("rejects non-positive amounts", async () => {
    await expect(topUp({ userId: "bob", amount: 0 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
