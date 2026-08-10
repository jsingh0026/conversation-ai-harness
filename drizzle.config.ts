import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle config for tooling (`pnpm db:studio` to browse, introspection). Note:
 * runtime migrations are applied by `pnpm db:migrate` from the SQL files in
 * `db/` (they handle the pgvector `CREATE EXTENSION` that drizzle-kit can't) —
 * this config exists for the Drizzle Studio browser + schema introspection.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/config/schema.ts',
  out: './db/drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
