import { drizzle as netlifyDrizzle } from "drizzle-orm/netlify-db";
import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const connectionString = process.env.REAL_DB_URL || process.env.NETLIFY_DB_URL;

if (connectionString) {
  if (connectionString.includes("localhost") || connectionString.includes("127.0.0.1")) {
    process.env.NETLIFY_DB_DRIVER = "server";
    if (!connectionString.includes("@")) {
      const updatedString = connectionString
        .replace("postgres://localhost", "postgres://postgres@localhost")
        .replace("postgresql://localhost", "postgresql://postgres@localhost")
        .replace("postgres://127.0.0.1", "postgres://postgres@127.0.0.1")
        .replace("postgresql://127.0.0.1", "postgresql://postgres@127.0.0.1");
      if (process.env.REAL_DB_URL) process.env.REAL_DB_URL = updatedString;
      else process.env.NETLIFY_DB_URL = updatedString;
    }
  } else {
    const updatedString = connectionString
      .replace("channel_binding=require&", "")
      .replace("&channel_binding=require", "")
      .replace("?channel_binding=require", "?");
    if (process.env.REAL_DB_URL) process.env.REAL_DB_URL = updatedString;
    else process.env.NETLIFY_DB_URL = updatedString;
  }
}

const activeConnectionString = process.env.REAL_DB_URL || process.env.NETLIFY_DB_URL;

// In local development or testing with an explicit connection string,
// connect directly using pg.Pool and drizzle-orm/node-postgres to bypass Netlify CLI's local mock DB.
const isLocalDev = process.env.NETLIFY_DEV === "true" || !process.env.NETLIFY_IMAGES_CDN_DOMAIN;

export const db = (isLocalDev && activeConnectionString)
  ? pgDrizzle({ client: new pg.Pool({ connectionString: activeConnectionString }), schema })
  : netlifyDrizzle({ schema });
