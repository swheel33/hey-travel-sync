import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Runner, CommandError } from "./command.ts";
import type { CalendarPlan, EventSpec } from "./types.ts";
import type { Document } from "./extractor.ts";

export interface ThreadRef {
  topicId: number;
  boxItemId: number;
  postingRevision: string;
  receivedAt: string;
  order: number;
  name: string;
  summary: string;
  sender: string;
  includesAttachments: boolean;
  includesCalendarInvites: boolean;
}
export type HeyWatchEvent =
  | { change: "ready" | "disconnected"; at: string }
  | { change: "resync"; at: string; box?: { id: number; kind: string; name: string } }
  | { change: "added" | "updated"; at: string; ref: ThreadRef };
export interface ThreadContent {
  sourceId: string;
  topicId: number;
  boxItemId: number;
  contentHash: string;
  contextDate: string;
  hasExplicitCancellation: boolean;
  documents: Document[];
}

export const travelFilterVersion = "travel-score-v1";

export interface TravelCandidateDecision {
  candidate: boolean;
  score: number;
  reasons: string[];
}

const travelCategory = /\b(?:flight|airline|airport|boarding|gate|trip|travel|hotel|lodging|stay|room|restaurant|dining|dinner|table|train|rail|railway|station|bus|coach|journey)\b/i;
const reservationArtifact = /\b(?:booking|booked|reservation|reserved|itinerary|e[ -]?ticket|ticket|boarding pass|check-in|check in (?:for|now|online|opens|is open)|voucher|record locator|pnr|billet|billete|reserva|reservierung|buchung)\b/i;
const transactionSignal = /\b(?:confirm(?:ed|ation)?|receipt)\b/i;
const strongReservationPhrase = /\b(?:booking confirmation|reservation confirmation|trip confirmation|flight confirmation|e[ -]?ticket receipt|boarding pass|upcoming stay|table reservation|journey ticket|you(?:'|\u2019)re booked)\b/i;
const disruptionSignal = /\b(?:cancel(?:led|ed|lation)?|schedule chang(?:e|ed)|gate chang(?:e|ed)|platform chang(?:e|ed)|delayed|rebook(?:ed|ing)?)\b/i;
const marketingSignal = /\b(?:sale|offer|newsletter|inspiration|deal|save \d+%|\d+% off|off your next|bonus (?:miles|points)|earn \d+|limited time)\b/i;
const knownProvider = /\b(?:delta|jetblue|united|southwest|american airlines|alaska airlines|air canada|british airways|lufthansa|klm|air france|emirates|qatar|ryanair|easyjet|hilton|marriott|hyatt|ihg|airbnb|booking\.com|expedia|hotels\.com|opentable|resy|tock|amtrak|trainline|flixbus|greyhound|megabus)\b/i;

export function scoreTravelCandidate(ref: ThreadRef): TravelCandidateDecision {
  const metadata = `${ref.name}\n${ref.summary}`.normalize("NFKC");
  const reasons: string[] = [];
  let score = 0;
  const category = travelCategory.test(metadata);
  const artifact = reservationArtifact.test(metadata);
  if (category) { score += 2; reasons.push("category:+2"); }
  if (artifact) { score += 2; reasons.push("reservation-artifact:+2"); }
  if (transactionSignal.test(metadata)) { score += 1; reasons.push("transaction:+1"); }
  if (strongReservationPhrase.test(metadata)) { score += 2; reasons.push("strong-phrase:+2"); }
  if (disruptionSignal.test(metadata) && (category || artifact)) {
    score += 2;
    reasons.push("travel-change:+2");
  }
  if (category || artifact) {
    let structural = 0;
    if (/\b[A-Z]{2}\s?\d{1,4}\b/.test(metadata)) structural++;
    if (/\b[A-Z]{3}\s*(?:\u2192|->|\u2013|-|to)\s*[A-Z]{3}\b/.test(metadata)) structural++;
    if (/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i.test(metadata)) structural++;
    structural = Math.min(structural, 2);
    if (structural) { score += structural; reasons.push(`structure:+${structural}`); }
  }
  if (knownProvider.test(ref.sender)) { score += 2; reasons.push("provider:+2"); }
  if ((category || artifact) && ref.includesAttachments) { score++; reasons.push("attachment:+1"); }
  if ((category || artifact) && ref.includesCalendarInvites) { score++; reasons.push("calendar-invite:+1"); }
  if (marketingSignal.test(metadata)) { score -= 3; reasons.push("marketing:-3"); }
  return { candidate: score >= 2, score, reasons };
}

export class HeyClient {
  constructor(private command: string, private runner: Runner, private signal?: AbortSignal) {}

  async authStatus(): Promise<Record<string, unknown>> {
    return mapping(await this.json(["auth", "status"]));
  }

  async listBox(box: string, allPages = false, limit = 50): Promise<ThreadRef[]> {
    const data = mapping(await this.json(["box", "view", box, ...(allPages ? ["--all"] : ["--limit", String(limit)])]));
    const refs = (Array.isArray(data.postings) ? data.postings : []).filter(isMapping)
      .flatMap((item, order) => postingRef(item, Number(item.topic_id), order));
    return refs.sort((a, b) => {
      const first = Date.parse(a.receivedAt);
      const second = Date.parse(b.receivedAt);
      return Number.isNaN(first) || Number.isNaN(second) ? b.order - a.order : first - second;
    });
  }

  async watch(boxes: string[], signal: AbortSignal, onEvent: (event: HeyWatchEvent) => void): Promise<void> {
    const arguments_ = [
      this.command, "watch", ...boxes.flatMap((box) => ["--box", box]),
      "--events", "added,updated,resync",
    ];
    await this.runner.lines(arguments_, {
      signal,
      maxLineBytes: 1024 * 1024,
      onLine: (line) => {
        if (!line.trim()) return;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          console.warn("warning: ignoring malformed HEY watch JSON");
          return;
        }
        const event = watchEvent(raw);
        if (event) onEvent(event);
      },
    });
  }

  async readThread(ref: ThreadRef, workPath: string): Promise<ThreadContent> {
    await mkdir(workPath, { recursive: true, mode: 0o700 });
    const thread = await this.json(["thread", "read", String(ref.topicId)]);
    const entries = Array.isArray(thread) ? thread : [];
    const latest = mapping(entries.at(-1));
    const markdown = threadMarkdown(entries, ref);
    const documents: Document[] = [{ filename: `thread-${ref.topicId}.md`, content: new TextEncoder().encode(markdown) }];
    const attachments = await this.json(["attachment", "list", String(ref.topicId)]);
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      if (!isMapping(attachment) || !attachment.id) continue;
      const directory = await mkdtemp(join(workPath, "attachment-"));
      try {
        const filename = basename(String(attachment.filename || `attachment-${attachment.id}`));
        const output = join(directory, filename);
        const saved = mapping(await this.json(["attachment", "save", String(attachment.id), "--output", output]));
        const path = typeof saved.path === "string" ? saved.path : output;
        documents.push({ filename, content: await readFile(path) });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    const hash = createHash("sha256");
    for (const document of documents) hash.update(document.filename).update("\0").update(document.content).update("\0");
    return {
      sourceId: String(latest.id ?? ref.topicId), topicId: ref.topicId, boxItemId: ref.boxItemId,
      contentHash: hash.digest("hex"), contextDate: String(latest.created_at ?? ref.receivedAt),
      hasExplicitCancellation: /\bcancel(?:led|ed|lation)?\b/i.test(markdown), documents,
    };
  }

  async labelId(name: string): Promise<number | undefined> {
    const data = await this.json(["label", "list", "--all"]);
    for (const item of Array.isArray(data) ? data : []) {
      if (isMapping(item) && String(item.name || "").toLowerCase() === name.toLowerCase()) return Number(item.id);
    }
    return undefined;
  }

  async addLabel(boxItemId: number, labelId: number): Promise<void> {
    await this.json(["label", "add", String(boxItemId), "--to", String(labelId)]);
  }

  async applyCalendar(plan: CalendarPlan, calendarId?: number): Promise<number | undefined> {
    if (plan.action === "delete" && plan.eventId) {
      await this.json(["event", "delete", String(plan.eventId)]);
      return plan.eventId;
    }
    if (!plan.spec) return plan.eventId;
    let arguments_: string[];
    if (plan.action === "create") arguments_ = ["event", "add", plan.spec.title];
    else if (plan.action === "update" && plan.eventId) {
      arguments_ = ["event", "edit", String(plan.eventId), (plan.lookupDate || plan.spec.start).slice(0, 10), "--title", plan.spec.title];
    } else return plan.eventId;
    arguments_.push(...eventArguments(plan.spec, plan.action === "create" ? calendarId : undefined, plan.action === "update"));
    const data = await this.json(arguments_);
    if (plan.action === "update") return plan.eventId;
    const id = findId(data);
    if (id === undefined) throw new CommandError("HEY event create response did not contain an event ID");
    return id;
  }

  private async json(arguments_: string[]): Promise<unknown> {
    const payload = await this.runner.json([this.command, ...arguments_, "--json"], 180, this.signal);
    if (isMapping(payload) && payload.ok === false) throw new CommandError(String(payload.error || "HEY command failed"));
    return isMapping(payload) && "data" in payload ? payload.data : payload;
  }
}

function watchEvent(value: unknown): HeyWatchEvent | undefined {
  if (!isMapping(value)) return undefined;
  const change = String(value.change ?? "");
  const at = String(value.at ?? "");
  if (change === "ready" || change === "disconnected") return { change, at };
  if (change === "resync") {
    const rawBox = mapping(value.box);
    const id = Number(rawBox.id);
    const box = Number.isInteger(id)
      ? { id, kind: String(rawBox.kind ?? ""), name: String(rawBox.name ?? "") }
      : undefined;
    return { change, at, ...(box ? { box } : {}) };
  }
  if (change !== "added" && change !== "updated") return undefined;
  const posting = mapping(value.posting);
  const ref = postingRef(posting, Number(value.thread_id), 0)[0];
  return ref ? { change, at, ref } : undefined;
}

function postingRef(item: Record<string, unknown>, topicId: number, order: number): ThreadRef[] {
  const boxItemId = Number(item.id);
  const postingRevision = String(item.updated_at ?? item.active_at ?? item.created_at ?? "");
  const receivedAt = String(item.updated_at ?? item.active_at ?? item.created_at ?? "");
  if (!Number.isInteger(topicId) || !Number.isInteger(boxItemId) || !postingRevision) return [];
  return [{
    topicId, boxItemId, postingRevision, receivedAt, order,
    name: String(item.name ?? ""), summary: String(item.summary ?? ""),
    sender: metadataText(item.creator ?? item.sender ?? item.from),
    includesAttachments: item.includes_attachments === true,
    includesCalendarInvites: item.includes_calendar_invites === true,
  }];
}

function eventArguments(spec: EventSpec, calendarId?: number, includeEmptyLocation = false): string[] {
  const result = ["--notes", spec.notes];
  if (spec.location || includeEmptyLocation) result.push("--location", spec.location);
  if (calendarId !== undefined) result.push("--calendar", String(calendarId));
  if (spec.allDay) return [...result, "--starts-on", spec.start.slice(0, 10), "--ends-on", spec.end.slice(0, 10), "--all-day"];
  const start = localParts(spec.start, spec.timezone);
  const end = localParts(spec.end, spec.timezone);
  return [...result, "--starts-on", start.date, "--start-time", start.time, "--ends-on", end.date, "--end-time", end.time, "--time-zone", spec.timezone];
}

function localParts(value: string, timezone: string): { date: string; time: string } {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) return { date: value.slice(0, 10), time: value.slice(11, 16) };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

function findId(value: unknown): number | undefined {
  if (isMapping(value)) {
    for (const key of ["id", "recording_id", "event_id"]) if (value[key]) return Number(value[key]);
    for (const nested of Object.values(value)) { const found = findId(nested); if (found !== undefined) return found; }
  } else if (Array.isArray(value)) {
    for (const nested of value) { const found = findId(nested); if (found !== undefined) return found; }
  }
  return undefined;
}

function mapping(value: unknown): Record<string, unknown> { return isMapping(value) ? value : {}; }
function isMapping(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function threadMarkdown(entries: unknown[], ref: ThreadRef): string {
  const sections = entries.map((raw, index) => {
    const entry = mapping(raw);
    const sender = metadataText(entry.sender ?? entry.creator ?? entry.from) || "unknown";
    const date = String(entry.created_at ?? entry.sent_at ?? entry.date ?? "unknown");
    const id = String(entry.id ?? index + 1);
    const body = typeof entry.body === "string" ? entry.body : "";
    return `## Entry ${index + 1}\n\nSender: ${sender}\nDate: ${date}\nEntry-ID: ${id}\n\n${body}`;
  });
  return [`# ${ref.name || `Thread ${ref.topicId}`}`, `Summary: ${ref.summary}`, ...sections].join("\n\n");
}

function metadataText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isMapping(value)) return "";
  const name = String(value.name ?? value.display_name ?? "").trim();
  const email = String(value.email_address ?? value.email ?? "").trim();
  return name && email ? `${name} <${email}>` : name || email;
}
