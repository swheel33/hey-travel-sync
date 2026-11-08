import { Database } from "bun:sqlite";

export type ThreadStatus = "filtered" | "travel" | "none" | "failed";

export interface ThreadRow {
  topic_id: number;
  revision: string;
  status: ThreadStatus;
  attempts: number;
  error: string | null;
  subject: string;
  updated_at: string;
}

export interface EventRow {
  key: string;
  event_id: number | null;
  hash: string;
  source_at: string;
  label: string;
}

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        topic_id INTEGER PRIMARY KEY, revision TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT, subject TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- event_id is NULL while a create is in flight; a NULL row left behind by a crash
      -- blocks that reservation until someone checks HEY Calendar for a stray event.
      CREATE TABLE IF NOT EXISTS events (
        key TEXT PRIMARY KEY, event_id INTEGER UNIQUE, hash TEXT NOT NULL,
        source_at TEXT NOT NULL, label TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  thread(topicId: number): ThreadRow | null {
    return this.db.query<ThreadRow, [number]>("SELECT * FROM threads WHERE topic_id = ?").get(topicId);
  }

  saveThread(topicId: number, revision: string, subject: string, status: ThreadStatus, error?: string): void {
    this.db.query(`
      INSERT INTO threads (topic_id, revision, status, attempts, error, subject) VALUES ($id, $revision, $status, $attempts, $error, $subject)
      ON CONFLICT (topic_id) DO UPDATE SET revision = $revision, status = $status, error = $error, subject = $subject,
        attempts = CASE WHEN $status = 'failed' AND threads.revision = $revision THEN threads.attempts + 1 ELSE $attempts END,
        updated_at = datetime('now')
    `).run({ id: topicId, revision, status, attempts: status === "failed" ? 1 : 0, error: error ?? null, subject });
  }

  failedThreads(): ThreadRow[] {
    return this.db.query<ThreadRow, []>("SELECT * FROM threads WHERE status = 'failed' ORDER BY updated_at DESC").all();
  }

  event(key: string): EventRow | null {
    return this.db.query<EventRow, [string]>("SELECT * FROM events WHERE key = ?").get(key);
  }

  eventsWithPrefix(prefix: string): EventRow[] {
    return this.db.query<EventRow, [string, string]>("SELECT * FROM events WHERE key = ? OR key LIKE ? || '|%'").all(prefix, prefix);
  }

  events(): EventRow[] {
    return this.db.query<EventRow, []>("SELECT * FROM events ORDER BY updated_at DESC").all();
  }

  beginCreate(key: string, sourceAt: string, label: string): void {
    this.db.query("INSERT INTO events (key, event_id, hash, source_at, label) VALUES (?, NULL, '', ?, ?)").run(key, sourceAt, label);
  }

  saveEvent(key: string, eventId: number, hash: string, sourceAt: string, label: string): void {
    this.db.query(`
      INSERT INTO events (key, event_id, hash, source_at, label) VALUES ($key, $eventId, $hash, $sourceAt, $label)
      ON CONFLICT (key) DO UPDATE SET event_id = $eventId, hash = $hash, source_at = $sourceAt, label = $label, updated_at = datetime('now')
    `).run({ key, eventId, hash, sourceAt, label });
  }

  deleteEvent(key: string): void {
    this.db.query("DELETE FROM events WHERE key = ?").run(key);
  }
}
