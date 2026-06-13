import { db } from "./db/index.js";
import { odds } from "./db/schema.js";

try {
  const result = await db.select().from(odds).limit(5);
  console.log("Drizzle odds rows:", result);
} catch (err) {
  console.error("Drizzle query failed:", err);
}
