import mongoose from "mongoose";
import * as dotenv from "dotenv";
dotenv.config();
import { Drop } from "../models/Drop";
import { Wallet } from "../models/Wallet";
import { Hold } from "../models/Hold";
import { Purchase } from "../models/Purchase";
import { Waitlist } from "../models/Waitlist";

async function main() {
  const dbString: any = process.env.MONGO_URI;
  await mongoose.connect(dbString);
  await Promise.all(
    [Drop, Wallet, Hold, Purchase, Waitlist].map((m: any) => m.deleteMany({})),
  );
  await Wallet.create([
    { userId: "alice", balance: 10000 },
    { userId: "bob", balance: 500 },
    { userId: "carol", balance: 0 },
  ]);
  const liveDrop = await Drop.create({
    itemName: "Midnight Hoodie",
    totalStock: 5,
    available: 5,
    pricePerUnit: 200,
    goLiveAt: new Date(Date.now() - 1000),
    maxPerUser: 2,
  });
  const futureDrop = await Drop.create({
    itemName: "Dawn Sneakers",
    totalStock: 100,
    available: 100,
    pricePerUnit: 50,
    goLiveAt: new Date(Date.now() + 3600_000),
    maxPerUser: 3,
  });
  console.log("Seeded.");
  console.log("LIVE drop  :", liveDrop.id, "(5 units, 200 BSP, max 2/user)");
  console.log("FUTURE drop:", futureDrop.id);
  console.log("Users: alice(10000), bob(500), carol(0)");
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
