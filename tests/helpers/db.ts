import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";

/** A fresh, fully migrated database for one test file. */
export function createTestDb() {
  const template = process.env.TEST_TEMPLATE_DB;
  if (!template) throw new Error("TEST_TEMPLATE_DB is not set; is the Vitest globalSetup running?");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pge-db-"));
  const file = path.join(dir, "test.db");
  fs.copyFileSync(template, file);

  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: file }) });
  return {
    prisma,
    /** The database file, for code that opens its own client from DATABASE_URL. */
    file,
    async cleanup() {
      await prisma.$disconnect();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
