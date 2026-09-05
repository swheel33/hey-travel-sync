import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { digest, eventSpec, identify, normalizeSegment, type CalendarPlan, type EventLink, type IdentifiedReservation } from "./types.ts";
import { StateDatabase, type CachedExtraction } from "./database.ts";
import { HeyClient, scoreTravelCandidate, travelFilterVersion, type ThreadRef } from "./hey.ts";
import { OpenCodeExtractor } from "./extractor.ts";

const pipelineVersion = "opencode-v4-zoned-times";

export interface SyncSummary {
  checked: number;
  filtered: number;
  modelCalls: number;
  ignored: number;
  reservations: number;
  creates: number;
  updates: number;
  deletes: number;
  errors: number;
}

interface SyncOptions {
  apply: boolean;
  allPages?: boolean;
  sinceDays?: number;
  signal?: AbortSignal;
}

export class SyncService {
  constructor(private config: Config, private database: StateDatabase, private hey: HeyClient, private extractor: OpenCodeExtractor) {}

  async sync(options: SyncOptions): Promise<SyncSummary> {
    const refs = new Map<number, ThreadRef>();
    for (const box of this.config.sourceBoxes) {
      for (const ref of await this.hey.listBox(box, options.allPages)) {
        const current = refs.get(ref.topicId);
        if (!current || Date.parse(ref.receivedAt) > Date.parse(current.receivedAt)) refs.set(ref.topicId, ref);
      }
    }
    const ordered = [...refs.values()].sort(chronological);
    return this.processRefs(ordered, options);
  }

  async targeted(refs: ThreadRef[], options: SyncOptions): Promise<SyncSummary> {
    return this.processRefs([...refs].sort(chronological), options);
  }

  private async processRefs(refs: ThreadRef[], options: SyncOptions): Promise<SyncSummary> {
    const summary = emptySummary();
    const preview = new Map<string, string>();
    const labelId = options.apply ? await this.hey.labelId(this.config.travelLabel) : undefined;
    if (options.apply && labelId === undefined) throw new Error(`HEY label not found: ${this.config.travelLabel}`);
    for (const ref of refs) {
      if (options.signal?.aborted) throw options.signal.reason;
      await this.process(ref, labelId, options, summary, preview);
    }
    return summary;
  }

  private async process(
    ref: ThreadRef, labelId: number | undefined, options: SyncOptions,
    summary: SyncSummary, preview: Map<string, string>,
  ): Promise<void> {
    try {
      if (tooOld(ref.receivedAt, options.sinceDays)) return;
      summary.checked++;
      const observationRevision = digest([
        "posting-observation-v1", pipelineVersion, travelFilterVersion, ref.postingRevision,
        ref.name, ref.summary, ref.sender, ref.includesAttachments, ref.includesCalendarInvites,
      ]);
      const observed = this.database.observation(ref.topicId);
      if (observed?.revision === observationRevision) {
        if (observed.state === "filtered") return;
        if (observed.extractionKey && this.database.extractionMatches(
          observed.extractionKey, pipelineVersion, this.config.model, this.config.defaultTimezone,
        )) {
          const cached = this.database.cachedExtraction(observed.extractionKey);
          if (!cached) throw new Error(`extraction cache ${observed.extractionKey} is missing`);
          if (!options.apply || observed.appliedKey !== observed.extractionKey) {
            await this.handleExtraction(ref, observed.extractionKey, cached, labelId, options.apply, summary, preview);
          }
          return;
        }
      }
      const decision = scoreTravelCandidate(ref);
      const tracked = observed?.state === "extracted";
      if (!tracked && !decision.candidate) {
        this.database.saveObservation(ref.topicId, ref.boxItemId, observationRevision, "filtered");
        summary.filtered++;
        return;
      }
      console.log(`candidate ${ref.topicId}: ${tracked ? "tracked topic" : `score ${decision.score} (${decision.reasons.join(", ")})`}`);
      const content = await this.hey.readThread(ref, this.config.workPath);
      const extractionKey = digest([
        pipelineVersion, content.contentHash, this.config.model, this.config.defaultTimezone,
      ]);
      let cached = this.database.cachedExtraction(extractionKey);
      if (!cached) {
        summary.modelCalls++;
        const reservations = await this.extractor.extract(content.documents);
        cached = {
          reservations, sourceDate: content.contextDate,
          hasExplicitCancellation: content.hasExplicitCancellation,
        };
        this.database.cacheExtraction(
          extractionKey, content.contentHash, pipelineVersion, this.config.model,
          this.config.defaultTimezone, reservations, content.contextDate, content.hasExplicitCancellation,
        );
      }
      this.database.saveObservation(ref.topicId, ref.boxItemId, observationRevision, "extracted", extractionKey);
      await this.handleExtraction(ref, extractionKey, cached, labelId, options.apply, summary, preview);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      console.error(`thread ${ref.topicId} failed:`, error instanceof Error ? error.message : error);
      summary.errors++;
    }
  }

  private async handleExtraction(
    ref: ThreadRef, extractionKey: string, cached: CachedExtraction,
    labelId: number | undefined, apply: boolean, summary: SyncSummary,
    preview: Map<string, string>,
  ): Promise<void> {
    if (!cached.reservations.length) {
      summary.ignored++;
      if (apply) this.database.markApplied(ref.topicId, extractionKey);
      return;
    }
    if (apply) {
      await this.applyExtraction(ref, extractionKey, cached, labelId, summary);
      return;
    }
    for (const reservation of cached.reservations) {
      await this.reconcile(reservation, cached.sourceDate, cached.hasExplicitCancellation, false, summary, preview);
    }
    summary.reservations += cached.reservations.length;
  }

  private async applyExtraction(
    ref: ThreadRef, extractionKey: string, cached: CachedExtraction,
    labelId: number | undefined, summary: SyncSummary,
  ): Promise<void> {
    let settled = true;
    for (const reservation of cached.reservations) {
      settled = await this.reconcile(
        reservation, cached.sourceDate, cached.hasExplicitCancellation, true, summary,
      ) && settled;
    }
    if (settled && labelId !== undefined) {
      const labelOperation = digest(["label", ref.boxItemId, labelId]);
      if (!this.database.operationDone(labelOperation)) {
        await this.hey.addLabel(ref.boxItemId, labelId);
        this.database.completeOperation(labelOperation, "label", String(ref.boxItemId));
      }
      this.database.markApplied(ref.topicId, extractionKey);
    }
    summary.reservations += cached.reservations.length;
  }

  private async reconcile(
    reservation: IdentifiedReservation,
    sourceDate: string,
    hasExplicitCancellation: boolean,
    apply: boolean,
    summary: SyncSummary,
    preview?: Map<string, string>,
  ): Promise<boolean> {
    if (this.database.isOlderThanRecorded(reservation, sourceDate)) {
      console.log(`noop ${reservation.segmentKey}: newer reservation state is already recorded`);
      return true;
    }
    let plan = this.plan(reservation, hasExplicitCancellation);
    if (!apply && plan.action === "create" && plan.spec) {
      const previousHash = preview?.get(reservation.segmentKey);
      if (previousHash) {
        plan = previousHash === plan.spec.contentHash
          ? { action: "noop", reason: "duplicate reservation in this pass" }
          : { ...plan, action: "update", reason: "later reservation state in this pass" };
      }
      preview?.set(reservation.segmentKey, plan.spec?.contentHash || previousHash || "");
    }
    console.log(`${plan.action} ${reservation.segmentKey}: ${plan.reason}`);
    if (plan.action === "noop") {
      if (apply && plan.reason === "unchanged") this.database.saveReservation(reservation, sourceDate);
      return !reservation.cancelled;
    }
    summary[`${plan.action}s` as "creates" | "updates" | "deletes"]++;
    if (!apply) return true;
    const operationId = randomUUID();
    const scopeSegment = plan.linkSegmentKey || reservation.segmentKey;
    const scope = `calendar:${scopeSegment}`;
    const matchedLink = plan.action === "delete" ? this.database.eventLink(scopeSegment) : undefined;
    if (!this.database.beginOperation(operationId, scope, plan.action)) {
      throw new Error(`an operation for ${scope} is pending from an interrupted run; verify the HEY event before retrying`);
    }
    const eventId = await this.hey.applyCalendar(plan, this.config.calendarId);
    if (plan.action === "delete") {
      const recorded = identify({ ...reservation, segment: reservation.segment || matchedLink?.currentSegment || "" });
      this.database.unlinkEvent(scopeSegment);
      this.database.saveReservation(recorded, sourceDate);
      this.database.completeOperation(operationId, plan.action, String(plan.eventId || ""));
      return true;
    }
    if (!plan.spec || eventId === undefined) throw new Error("calendar mutation did not return an event ID");
    this.database.saveReservation(reservation, sourceDate);
    this.database.linkEvent(reservation.segmentKey, reservation.reservationKey, eventId, plan.spec.contentHash, plan.linkSegmentKey);
    this.database.completeOperation(operationId, plan.action, String(eventId));
    return true;
  }

  private plan(reservation: IdentifiedReservation, hasExplicitCancellation: boolean): CalendarPlan {
    if (reservation.cancelled) {
      if (!hasExplicitCancellation) return { action: "noop", reason: "source does not explicitly state cancellation" };
      const candidates = this.matchingReferenceLinks(reservation);
      if (candidates.length > 1) return { action: "noop", reason: "cancellation is ambiguous across owned segments" };
      const link = candidates[0];
      if (!link) return { action: "noop", reason: "no owned event matches cancellation" };
      return { action: "delete", eventId: link.eventId, linkSegmentKey: link.segmentKey, reason: "confirmed cancellation" };
    }
    const spec = eventSpec(reservation, this.config.defaultTimezone);
    let link = this.database.eventLink(reservation.segmentKey);
    if (!link && reservation.confirmation) {
      const candidates = this.confirmedReferenceLinks(reservation);
      if (candidates.length === 1) link = candidates[0];
      else if (candidates.length > 1) return { action: "noop", reason: "reservation reference is ambiguous across owned events" };
    }
    if (!link) return { action: "create", spec, reason: "new managed segment" };
    if (!reservation.confirmation) return { action: "noop", spec, eventId: link.eventId, reason: "confirmation-free events are create-only" };
    if (!link.owned) return { action: "noop", reason: "existing event is not owned" };
    if (link.contentHash === spec.contentHash) return { action: "noop", spec, eventId: link.eventId, reason: "unchanged" };
    return {
      action: "update", spec, eventId: link.eventId, linkSegmentKey: link.segmentKey,
      lookupDate: link.currentStart || reservation.start, reason: "reservation changed",
    };
  }

  private matchingReferenceLinks(reservation: IdentifiedReservation): EventLink[] {
    let candidates = this.database.linksForConfirmation(reservation.kind, reservation.confirmation).filter((item) => item.owned);
    candidates = candidates.filter((item) => item.currentProvider.trim().toLowerCase() === reservation.provider.trim().toLowerCase());
    if (reservation.segment) candidates = candidates.filter(
      (item) => normalizeSegment(item.currentSegment) === normalizeSegment(reservation.segment),
    );
    return candidates;
  }

  private confirmedReferenceLinks(reservation: IdentifiedReservation): EventLink[] {
    const candidates = this.database.linksForConfirmation(reservation.kind, reservation.confirmation).filter((item) => item.owned);
    const providerMatches = candidates.filter(
      (item) => item.currentProvider.trim().toLowerCase() === reservation.provider.trim().toLowerCase(),
    );
    return providerMatches.length ? providerMatches : candidates;
  }
}

function emptySummary(): SyncSummary {
  return { checked: 0, filtered: 0, modelCalls: 0, ignored: 0, reservations: 0, creates: 0, updates: 0, deletes: 0, errors: 0 };
}

function chronological(a: ThreadRef, b: ThreadRef): number {
  const first = Date.parse(a.receivedAt), second = Date.parse(b.receivedAt);
  return Number.isNaN(first) || Number.isNaN(second) ? b.order - a.order : first - second;
}

function tooOld(receivedAt: string, sinceDays?: number): boolean {
  if (sinceDays === undefined || !receivedAt) return false;
  const received = Date.parse(receivedAt);
  return !Number.isNaN(received) && received < Date.now() - sinceDays * 86_400_000;
}
