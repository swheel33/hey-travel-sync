import type { Config } from "./config.ts";
import type { Extractor } from "./extract.ts";
import { travelScore } from "./filter.ts";
import type { Hey, ThreadRef } from "./hey.ts";
import { bookingPrefix, eventHash, normalize, type Reservation } from "./reservation.ts";
import type { Store } from "./store.ts";

const maxAttempts = 3;

export interface SyncOptions {
  apply: boolean;
  all?: boolean;
  sinceDays?: number;
  topicId?: number;
}

export interface Summary {
  seen: number;
  filtered: number;
  extracted: number;
  created: number;
  updated: number;
  deleted: number;
  failed: number;
}

export class Sync {
  constructor(private config: Config, private hey: Hey, private extractor: Extractor, private store: Store) {}

  async run(options: SyncOptions): Promise<Summary> {
    const summary: Summary = { seen: 0, filtered: 0, extracted: 0, created: 0, updated: 0, deleted: 0, failed: 0 };
    const refs = new Map<number, ThreadRef>();
    for (const box of this.config.boxes) {
      for (const ref of await this.hey.listBox(box, Boolean(options.all))) {
        if (options.topicId !== undefined && ref.topicId !== options.topicId) continue;
        const known = refs.get(ref.topicId);
        if (!known || ref.receivedAt > known.receivedAt) refs.set(ref.topicId, ref);
      }
    }
    const cutoff = options.sinceDays === undefined ? "" : new Date(Date.now() - options.sinceDays * 86_400_000).toISOString();
    // Oldest first, so a later change to a booking wins.
    const ordered = [...refs.values()].filter((ref) => ref.receivedAt >= cutoff).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const labelId = options.apply ? await this.hey.labelId(this.config.travelLabel) : undefined;
    for (const ref of ordered) {
      summary.seen++;
      try {
        await this.thread(ref, options, summary, labelId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.failed++;
        console.error(`FAILED thread ${ref.topicId} "${ref.subject}": ${message}`);
        if (options.apply) this.store.saveThread(ref.topicId, ref.revision, ref.subject, "failed", message);
      }
    }
    return summary;
  }

  private async thread(ref: ThreadRef, options: SyncOptions, summary: Summary, labelId?: number): Promise<void> {
    const row = this.store.thread(ref.topicId);
    const forced = options.topicId !== undefined;
    if (!forced && row?.revision === ref.revision) {
      if (row.status !== "failed") return;
      if (row.attempts >= maxAttempts) return;
      // Back off an hour per attempt so a persistent failure doesn't call the model every poll.
      if (Date.now() - Date.parse(`${row.updated_at}Z`) < row.attempts * 3_600_000) return;
    }
    // A thread that already produced travel stays tracked, so follow-ups like cancellations get read.
    const score = travelScore(ref);
    if (!forced && row?.status !== "travel" && !score.candidate) {
      summary.filtered++;
      if (options.apply) this.store.saveThread(ref.topicId, ref.revision, ref.subject, "filtered");
      return;
    }

    console.log(`thread ${ref.topicId} "${ref.subject}" (${score.reasons.join(", ") || "tracked"})`);
    const thread = await this.hey.readThread(ref);
    const bodyText = thread.markdown.replace(/^#.*$/gm, "").replace(/📎 attachment|!\[[^\]]*\]\([^)]*\)/g, "").trim();
    if (bodyText.length < 80 && !thread.attachments.length) {
      throw new Error("HEY returned an empty message body; check the hey CLI version");
    }
    const items = await this.extractor.extract(thread);
    summary.extracted++;
    const cancellationStated = /\bcancel(?:led|ed|lation)?\b/i.test(thread.markdown);
    let reservations = 0;
    for (const item of items) {
      const reservation = normalize(item);
      if (typeof reservation === "string") {
        console.warn(`  skip ${item.kind} ${item.provider} ${item.number}: ${reservation}`);
        continue;
      }
      reservations++;
      await this.reconcile(reservation, thread.latestAt, cancellationStated, options.apply, summary);
    }
    if (!options.apply) return;
    this.store.saveThread(ref.topicId, ref.revision, ref.subject, reservations || row?.status === "travel" ? "travel" : "none");
    if (reservations && labelId !== undefined) await this.hey.addLabel(ref.postingId, labelId);
  }

  private async reconcile(reservation: Reservation, sourceAt: string, cancellationStated: boolean, apply: boolean, summary: Summary): Promise<void> {
    const { key, label } = reservation;
    if (reservation.cancelled) {
      if (!cancellationStated) return console.warn(`  ignore cancellation of ${label}: the email never says "cancel"`);
      const exact = this.store.event(key);
      const targets = exact ? [exact] : this.store.eventsWithPrefix(bookingPrefix(reservation.kind, reservation.confirmation));
      if (!targets.length) return console.log(`  cancellation of ${label}: no event on file`);
      for (const target of targets) {
        if (target.event_id === null) throw new Error(`event for ${target.key} has an unfinished create; check HEY Calendar, then delete its row`);
        console.log(`  delete ${target.label} (event ${target.event_id})`);
        summary.deleted++;
        if (!apply) continue;
        await this.hey.deleteEvent(target.event_id);
        this.store.deleteEvent(target.key);
      }
      return;
    }

    const event = reservation.event!;
    const hash = eventHash(event);
    const existing = this.store.event(key);
    if (existing?.event_id === null) throw new Error(`event for ${key} has an unfinished create; check HEY Calendar, then delete its row`);
    if (existing && existing.source_at > sourceAt) return console.log(`  keep ${label}: a newer email already set it`);
    if (existing?.hash === hash) return;
    const when = event.allDay ? `${event.startDate} → ${event.endDate}` : `${event.startDate} ${event.startTime} → ${event.endDate} ${event.endTime} ${event.timeZone}`;
    if (existing) {
      console.log(`  update "${event.title}" ${when}`);
      summary.updated++;
      if (!apply) return;
      await this.hey.editEvent(existing.event_id!, event);
      this.store.saveEvent(key, existing.event_id!, hash, sourceAt, label);
      return;
    }
    // Backfills reach old mail; a trip that is already over isn't worth a new event.
    if (event.endDate < new Date().toISOString().slice(0, 10)) return console.log(`  skip past "${event.title}" ${when}`);
    console.log(`  create "${event.title}" ${when}`);
    summary.created++;
    if (!apply) return;
    this.store.beginCreate(key, sourceAt, label);
    const eventId = await this.hey.createEvent(event, this.config.calendarId);
    this.store.saveEvent(key, eventId, hash, sourceAt, label);
  }
}
