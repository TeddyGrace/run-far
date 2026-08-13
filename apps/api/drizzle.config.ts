import { defineConfig } from "drizzle-kit";
import { config as loadDotenv } from "dotenv";
import path from "node:path";

// drizzle-kit runs with apps/api as cwd; the .env lives at the repo root. Using cwd rather
// than import.meta.dirname because drizzle-kit bundles this config to CJS via esbuild, where
// import.meta is always empty regardless of Node version.
loadDotenv({ path: path.resolve(process.cwd(), "../../.env") });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://runfar:runfar@localhost:5432/runfar",
  },
});
