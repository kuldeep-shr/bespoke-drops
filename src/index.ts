import * as dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { createApp } from "./app";
import { startSweeper } from "./sweeper";
import { env } from "./lib/env";

async function main() {
  const dbString: any = process.env.MONGO_URI;

  await mongoose.connect(dbString);
  console.log("mongo connected");
  startSweeper();
  createApp().listen(env.port, () => console.log(`listening on :${env.port}`));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
