import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/config/env";

export type Db = Database.Database;

/** Répertoires de stockage des fichiers d'origine (copies locales). */
export const DATA_DIR = path.join(process.cwd(), "data", "sources");

export function ensureDataDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Ouvre (ou crée) la base, applique WAL + foreign_keys, puis les migrations. */
export function createDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: string }[]).map(
      (r) => r.version
    )
  );
  const dir = path.join(process.cwd(), "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const apply = db.transaction((file: string, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      file,
      new Date().toISOString()
    );
  });
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    apply(file, sql);
  }
}

let dbInstance: Db | null = null;

/** Singleton pointé par DATABASE_PATH — utilisé par les routes et le worker. */
export function getDb(): Db {
  if (!dbInstance) dbInstance = createDb(getConfig().DATABASE_PATH);
  return dbInstance;
}

/** Réinitialise le singleton (tests uniquement). */
export function resetDbForTests(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/** Timestamp ISO courant. */
export function nowIso(): string {
  return new Date().toISOString();
}