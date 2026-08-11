import { defineConfig } from "drizzle-kit";
import { config as loadDotenv } from "dotenv";
import path from "node:path";

// drizzle-kit runs with apps/api as cwd; the .env lives at the repo root.
loadDotenv({ path: path.resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://runfar:runfar@localhost:5432/runfar",
  },
});
