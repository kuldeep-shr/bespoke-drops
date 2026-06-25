import mongoose from "mongoose";
import { beforeAll, afterAll, afterEach } from "vitest";

/**
 * Test DB strategy:
 *  - If TEST_MONGO_URI is set (e.g. an Atlas test database), use it directly.
 *    No binary download needed — works in locked-down networks / CI.
 *  - Otherwise spin up an ephemeral in-memory MongoDB (mongodb-memory-server),
 *    which downloads a small engine on first run.
 *
 * ⚠️ When pointing at a real database, tests wipe collections between cases —
 * ALWAYS use a throwaway test DB, never your seeded/prod data.
 */
let mongod: { stop: () => Promise<unknown> } | undefined;

beforeAll(async () => {
  const uri = process.env.MONGO_URI;
  if (uri) {
    await mongoose.connect(uri);
  } else {
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const server = await MongoMemoryServer.create();
    mongod = server;
    await mongoose.connect(server.getUri());
  }
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
