import { Database as SQLiteDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { identify, type EventLink, type IdentifiedReservation } from "./types.ts";

const schema = `
CREATE TABLE posting_observations (
  topic_id INTEGER PRIMARY KEY, posting_id INTEGER NOT NULL, revision TEXT NOT NULL,
  extraction_key TEXT, state TEXT NOT NULL, applied_key TEXT,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE extraction_cache (
  cache_key TEXT PRIMARY KEY, content_hash TEXT NOT NULL, pipeline TEXT NOT NULL,
  model TEXT NOT NULL, default_timezone TEXT NOT NULL, reservations_json TEXT NOT NULL,
  source_date TEXT NOT NULL, explicit_cancellation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE reservations (
  reservation_key TEXT NOT NULL, segment_key TEXT PRIMARY KEY, kind TEXT NOT NULL,
  provider TEXT NOT NULL, confirmation TEXT NOT NULL, segment TEXT NOT NULL,
  source_date TEXT NOT NULL, status TEXT NOT NULL, normalized_json TEXT NOT NULL,
  content_hash TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE event_links (
  segment_key TEXT PRIMARY KEY, reservation_key TEXT NOT NULL, event_id INTEGER NOT NULL UNIQUE,
  operation_hash TEXT NOT NULL, owned INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE operations (
  operation_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, action TEXT NOT NULL,
  target_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX operations_pending_scope ON operations(scope) WHERE status = 'pending';
CREATE INDEX event_links_reservation_key ON event_links(reservation_key);
CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

interface LinkRow {
  segment_key: string;
  reservation_key: string;
  event_id: number;
  operation_hash: string;
  owned: number;
  normalized_json: string | null;
}

export interface PostingObservation {
  revision: string;
  extractionKey?: string;
  state: "filtered" | "extracted";
  appliedKey?: string;
}

export interface CachedExtraction {
  reservations: IdentifiedReservation[];
  sourceDate: string;
  hasExplicitCancellation: boolean;
}

export class StateDatabase {
  readonly connection: SQLiteDatabase;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new SQLiteDatabase(path, { create: true });
    this.connection.run("PRAGMA foreign_keys = ON");
    this.connection.run("PRAGMA journal_mode = WAL");
  }

  migrate(): void {
    const existing = this.connection.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const applicationTables = existing.filter((row) => !row.name.startsWith("sqlite_")).map((row) => row.name);
    if (applicationTables.includes("posting_observations")) return;
    if (applicationTables.length) throw new Error("database uses the retired polling schema; configure a new database_path");
    this.connection.exec(schema);
  }

  close(): void { this.connection.close(); }

  observation(topicId: number): PostingObservation | undefined {
    const row = this.connection.query(`SELECT revision, extraction_key, state, applied_key
      FROM posting_observations WHERE topic_id = ?`).get(topicId) as {
        revision: string; extraction_key: string | null; state: "filtered" | "extracted"; applied_key: string | null;
      } | null;
    return row ? {
      revision: row.revision, state: row.state,
      extractionKey: row.extraction_key ?? undefined, appliedKey: row.applied_key ?? undefined,
    } : undefined;
  }

  saveObservation(topicId: number, postingId: number, revision: string, state: "filtered" | "extracted", extractionKey?: string): void {
    this.connection.query(`INSERT INTO posting_observations(topic_id, posting_id, revision, extraction_key, state)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET posting_id=excluded.posting_id,
      revision=excluded.revision, extraction_key=excluded.extraction_key, state=excluded.state,
      applied_key=CASE WHEN posting_observations.extraction_key = excluded.extraction_key
        THEN posting_observations.applied_key ELSE NULL END, observed_at=CURRENT_TIMESTAMP`
    ).run(topicId, postingId, revision, extractionKey ?? null, state);
  }

  markApplied(topicId: number, extractionKey: string): void {
    this.connection.query("UPDATE posting_observations SET applied_key = ? WHERE topic_id = ? AND extraction_key = ?")
      .run(extractionKey, topicId, extractionKey);
  }

  cachedExtraction(cacheKey: string): CachedExtraction | undefined {
    const row = this.connection.query(`SELECT reservations_json, source_date, explicit_cancellation
      FROM extraction_cache WHERE cache_key = ?`).get(cacheKey) as {
        reservations_json: string; source_date: string; explicit_cancellation: number;
      } | null;
    return row ? {
      reservations: (JSON.parse(row.reservations_json) as IdentifiedReservation[]).map(identify),
      sourceDate: row.source_date, hasExplicitCancellation: Boolean(row.explicit_cancellation),
    } : undefined;
  }

  extractionMatches(cacheKey: string, pipeline: string, model: string, defaultTimezone: string): boolean {
    return Boolean(this.connection.query(`SELECT 1 FROM extraction_cache
      WHERE cache_key = ? AND pipeline = ? AND model = ? AND default_timezone = ?`
    ).get(cacheKey, pipeline, model, defaultTimezone));
  }

  cacheExtraction(
    cacheKey: string, contentHash: string, pipeline: string, model: string,
    defaultTimezone: string, reservations: IdentifiedReservation[], sourceDate: string, hasExplicitCancellation: boolean,
  ): void {
    this.connection.query(`INSERT INTO extraction_cache(
      cache_key, content_hash, pipeline, model, default_timezone, reservations_json, source_date, explicit_cancellation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO NOTHING`
    ).run(cacheKey, contentHash, pipeline, model, defaultTimezone, JSON.stringify(reservations), sourceDate, hasExplicitCancellation ? 1 : 0);
  }

  state(key: string): string | undefined {
    return (this.connection.query("SELECT value FROM runtime_state WHERE key = ?").get(key) as { value: string } | null)?.value;
  }

  setState(key: string, value: string): void {
    this.connection.query("INSERT INTO runtime_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  saveReservation(value: IdentifiedReservation, sourceDate: string): void {
    this.connection.query(`INSERT INTO reservations(
      reservation_key, segment_key, kind, provider, confirmation, segment, source_date,
      status, normalized_json, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(segment_key) DO UPDATE SET reservation_key=excluded.reservation_key,
      kind=excluded.kind, provider=excluded.provider, confirmation=excluded.confirmation,
      segment=excluded.segment, source_date=excluded.source_date, status=excluded.status,
      normalized_json=excluded.normalized_json, content_hash=excluded.content_hash,
      updated_at=CURRENT_TIMESTAMP`).run(
      value.reservationKey, value.segmentKey, value.kind, value.provider, value.confirmation,
      value.segment, sourceDate, value.cancelled ? "cancelled" : "active",
      JSON.stringify(value), value.contentHash,
    );
  }

  isOlderThanRecorded(value: IdentifiedReservation, sourceDate: string): boolean {
    const incoming = Date.parse(sourceDate);
    if (Number.isNaN(incoming)) return false;
    let rows: Array<{ source_date: string; provider: string; segment: string; content_hash: string }>;
    if (value.confirmation) {
      rows = this.connection.query(`SELECT source_date, provider, segment, content_hash FROM reservations
        WHERE kind = ? AND confirmation = ? COLLATE NOCASE`).all(value.kind, value.confirmation) as typeof rows;
      if (value.provider) rows = rows.filter((row) => equal(row.provider, value.provider));
      if (value.segment) rows = rows.filter((row) => equal(row.segment, value.segment));
    } else {
      rows = this.connection.query("SELECT source_date, provider, segment, content_hash FROM reservations WHERE segment_key = ?")
        .all(value.segmentKey) as typeof rows;
    }
    return rows.some((row) => {
      const recorded = Date.parse(row.source_date);
      if (Number.isNaN(recorded)) return false;
      if (incoming !== recorded) return incoming < recorded;
      // Multiple confirmations can describe one segment differently at the same source time.
      return value.contentHash < row.content_hash;
    });
  }

  eventLink(segmentKey: string): EventLink | undefined {
    return this.toLink(this.connection.query(`SELECT e.segment_key, e.reservation_key, e.event_id,
      e.operation_hash, e.owned, r.normalized_json FROM event_links e
      LEFT JOIN reservations r ON r.segment_key = e.segment_key WHERE e.segment_key = ?`).get(segmentKey) as LinkRow | null);
  }

  linksForConfirmation(kind: string, confirmation: string): EventLink[] {
    const rows = this.connection.query(`SELECT e.segment_key, e.reservation_key, e.event_id,
      e.operation_hash, e.owned, r.normalized_json FROM event_links e JOIN reservations r ON r.segment_key = e.segment_key
      WHERE r.kind = ? AND r.confirmation = ? COLLATE NOCASE`).all(kind, confirmation) as LinkRow[];
    return rows.map((row) => this.toLink(row)!);
  }

  linkEvent(segmentKey: string, reservationKey: string, eventId: number, contentHash: string, previousSegmentKey?: string): void {
    this.connection.transaction(() => {
      if (previousSegmentKey && previousSegmentKey !== segmentKey) this.connection.query("DELETE FROM event_links WHERE segment_key = ?").run(previousSegmentKey);
      this.connection.query(`INSERT INTO event_links(segment_key, reservation_key, event_id, operation_hash, owned)
        VALUES (?, ?, ?, ?, 1) ON CONFLICT(segment_key) DO UPDATE SET reservation_key=excluded.reservation_key,
        event_id=excluded.event_id, operation_hash=excluded.operation_hash, owned=1, updated_at=CURRENT_TIMESTAMP`
      ).run(segmentKey, reservationKey, eventId, contentHash);
    })();
  }

  unlinkEvent(segmentKey: string): void { this.connection.query("DELETE FROM event_links WHERE segment_key = ?").run(segmentKey); }
  operationDone(operationId: string): boolean {
    return Boolean(this.connection.query("SELECT 1 FROM operations WHERE operation_hash = ? AND status = 'completed'").get(operationId));
  }
  beginOperation(operationId: string, scope: string, action: string): boolean {
    try {
      return this.connection.query("INSERT INTO operations(operation_hash, scope, action, status) VALUES (?, ?, ?, 'pending')")
        .run(operationId, scope, action).changes === 1;
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return false;
      throw error;
    }
  }
  completeOperation(operationId: string, action: string, targetId = ""): void {
    this.connection.query(`INSERT INTO operations(operation_hash, scope, action, target_id, status)
      VALUES (?, ?, ?, ?, 'completed') ON CONFLICT(operation_hash) DO UPDATE SET action=excluded.action,
      target_id=excluded.target_id, status='completed', updated_at=CURRENT_TIMESTAMP`
    ).run(operationId, operationId, action, targetId);
  }

  private toLink(row: LinkRow | null): EventLink | undefined {
    if (!row) return undefined;
    let currentStart = "", currentSegment = "", currentProvider = "";
    try {
      const stored = row.normalized_json ? JSON.parse(row.normalized_json) as Record<string, unknown> : {};
      if (typeof stored.start === "string") currentStart = stored.start;
      if (typeof stored.segment === "string") currentSegment = stored.segment;
      if (typeof stored.provider === "string") currentProvider = stored.provider;
    } catch {}
    return {
      segmentKey: row.segment_key, reservationKey: row.reservation_key, eventId: row.event_id,
      contentHash: row.operation_hash, owned: Boolean(row.owned), currentStart, currentSegment, currentProvider,
    };
  }
}

function equal(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}
