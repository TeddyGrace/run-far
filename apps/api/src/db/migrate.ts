import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./client.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Migrations live at apps/api/drizzle, resolved from this file so cwd doesn't matter. */
export const MIGRATIONS_FOLDER = path.resolve(here, "../../drizzle");

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main() {
  await runMigrations();
  console.log("Migrations applied.");
  await pool.end();
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("migrate.ts") || entry.endsWith("migrate.js")) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
