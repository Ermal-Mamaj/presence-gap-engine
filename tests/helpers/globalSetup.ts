import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string | undefined;

/**
 * Builds one migrated SQLite database from the real migration files. Each test
 * file copies it, so tests start from a schema produced by `prisma migrate
 * deploy` (which also validates the migrations apply to an empty database)
 * without paying for a migration run per test. The developer's own database is
 * never touched.
 */
export default function setup() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pge-test-"));
  const templatePath = path.join(tempDir, "template.db");
  const prismaCli = path.resolve("node_modules/prisma/build/index.js");

  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: `file:${templatePath.split(path.sep).join("/")}` },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
  process.env.TEST_TEMPLATE_DB = templatePath;
}

export function teardown() {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
