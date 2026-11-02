import { promises as fs } from "fs";
import path from "path";
import type {
  Incident,
  RecoveryAction,
  Transaction,
  WebhookEventRecord,
} from "@/lib/domain/types";

// Simple JSON file store for now. Everything goes through readDb/withDb so
// we can swap in Postgres later without touching callers.
// Only works with a single server process.

export interface Database {
  transactions: Record<string, Transaction>;
  webhookEvents: Record<string, WebhookEventRecord>;
  incidents: Record<string, Incident>;
  recoveryActions: Record<string, RecoveryAction>;
}

const DB_PATH =
  process.env.PAYTRACE_DB_PATH ||
  path.join(process.cwd(), ".data", "paytrace-db.json");

function emptyDb(): Database {
  return { transactions: {}, webhookEvents: {}, incidents: {}, recoveryActions: {} };
}

async function load(): Promise<Database> {
  try {
    const raw = await fs.readFile(/*turbopackIgnore: true*/ DB_PATH, "utf8");
    return { ...emptyDb(), ...(JSON.parse(raw) as Partial<Database>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDb();
    throw error;
  }
}

async function save(db: Database): Promise<void> {
  await fs.mkdir(/*turbopackIgnore: true*/ path.dirname(DB_PATH), { recursive: true });
  // write to a temp file first so a crash can't leave a half-written db
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ tmp, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(/*turbopackIgnore: true*/ tmp, DB_PATH);
}

let queue: Promise<unknown> = Promise.resolve();

// Runs fn with the db locked and saves afterwards. Writes are queued one at a
// time, which is what makes the webhook duplicate check safe.
export function withDb<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const db = await load();
    const result = await fn(db);
    await save(db);
    return result;
  });
  // don't let one failure block everything after it
  queue = run.catch(() => undefined);
  return run;
}

export function readDb(): Promise<Database> {
  const run = queue.then(load);
  queue = run.catch(() => undefined);
  return run;
}
