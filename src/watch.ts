import type { Config } from "./config.ts";
import { StateDatabase } from "./database.ts";
import type { HeyWatchEvent, ThreadRef } from "./hey.ts";
import { HeyClient } from "./hey.ts";
import { SyncService, type SyncSummary } from "./sync.ts";

export class WatchSupervisor {
  private targets = new Map<number, { ref: ThreadRef; due: number }>();
  private normalPending = false;
  private fullPending = false;
  private dailyPendingDate?: string;
  private dailyInFlightDate?: string;
  private readySeen = false;
  private stopped = false;
  private active?: Promise<void>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private dailyTimer?: ReturnType<typeof setTimeout>;
  private fatalReject!: (error: unknown) => void;
  private readonly fatal = new Promise<never>((_, reject) => { this.fatalReject = reject; });

  constructor(
    private config: Config,
    private database: StateDatabase,
    private hey: HeyClient,
    private service: SyncService,
    private apply: boolean,
    private signal: AbortSignal,
  ) {}

  async run(): Promise<void> {
    this.scheduleDaily();
    const watcher = this.hey.watch(this.config.sourceBoxes, this.signal, (event) => this.accept(event));
    await Promise.race([watcher, this.fatal]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.dailyTimer) clearTimeout(this.dailyTimer);
    this.targets.clear();
    this.normalPending = false;
    this.fullPending = false;
    await this.active;
  }

  private accept(event: HeyWatchEvent): void {
    if (this.stopped) return;
    if (event.change === "ready") {
      if (!this.readySeen) {
        this.readySeen = true;
        console.log("HEY watch ready; starting reconciliation");
        if (this.dailyDue()) this.requestFull(true);
        else this.requestNormal();
      } else console.log("HEY watch ready after reconnect");
      return;
    }
    if (event.change === "disconnected") {
      console.warn("HEY watch disconnected; waiting for reconnect");
      return;
    }
    if (event.change === "resync") {
      this.requestFull(false);
      return;
    }
    if (event.change === "added" || event.change === "updated") this.requestTarget(event.ref);
  }

  private requestTarget(ref: ThreadRef): void {
    if (this.fullPending) return;
    this.targets.set(ref.topicId, { ref, due: Date.now() + this.config.watchDebounceSeconds * 1000 });
    this.pump();
  }

  private requestNormal(): void {
    this.normalPending = true;
    this.pump();
  }

  private requestFull(daily: boolean): void {
    if (daily) {
      const date = localDate(new Date(), this.config.defaultTimezone);
      if (this.database.state("daily_reconcile_date") === date
        || this.dailyPendingDate === date || this.dailyInFlightDate === date) return;
      this.dailyPendingDate = date;
    }
    this.fullPending = true;
    this.normalPending = false;
    this.targets.clear();
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.active || !this.readySeen) return;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    let work: (() => Promise<SyncSummary>) | undefined;
    let dailyDate: string | undefined;
    if (this.fullPending) {
      this.fullPending = false;
      dailyDate = this.dailyPendingDate;
      this.dailyPendingDate = undefined;
      this.dailyInFlightDate = dailyDate;
      work = () => this.service.sync({ apply: this.apply, allPages: true, signal: this.signal });
    } else if (this.normalPending) {
      this.normalPending = false;
      work = () => this.service.sync({ apply: this.apply, signal: this.signal });
    } else {
      const now = Date.now();
      const due = [...this.targets.values()].filter((item) => item.due <= now);
      if (due.length) {
        for (const item of due) this.targets.delete(item.ref.topicId);
        work = () => this.service.targeted(due.map((item) => item.ref), { apply: this.apply, signal: this.signal });
      } else if (this.targets.size) {
        const next = Math.min(...[...this.targets.values()].map((item) => item.due));
        this.wakeTimer = setTimeout(() => { this.wakeTimer = undefined; this.pump(); }, Math.max(0, next - now));
      }
    }
    if (!work) return;
    this.active = work().then((summary) => {
      console.log(JSON.stringify(summary));
      if (dailyDate && summary.errors === 0) this.database.setState("daily_reconcile_date", dailyDate);
    }).catch((error) => {
      if (!this.signal.aborted) {
        this.stopped = true;
        this.fatalReject(error);
      }
    }).finally(() => {
      this.active = undefined;
      if (this.dailyInFlightDate === dailyDate) this.dailyInFlightDate = undefined;
      this.pump();
    });
  }

  private dailyDue(): boolean {
    const now = new Date();
    const parts = localParts(now, this.config.defaultTimezone);
    return parts.time >= this.config.dailyReconcileAt
      && this.database.state("daily_reconcile_date") !== parts.date;
  }

  private scheduleDaily(): void {
    if (this.stopped) return;
    const delay = nextWallClockDelay(this.config.dailyReconcileAt, this.config.defaultTimezone);
    this.dailyTimer = setTimeout(() => {
      this.dailyTimer = undefined;
      if (this.dailyDue()) this.requestFull(true);
      this.scheduleDaily();
    }, delay);
  }
}

function localParts(date: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

function localDate(date: Date, timezone: string): string { return localParts(date, timezone).date; }

function nextWallClockDelay(time: string, timezone: string): number {
  const now = Date.now();
  let candidate = Math.floor(now / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 49 * 60; minute++, candidate += 60_000) {
    if (localParts(new Date(candidate), timezone).time === time) return Math.max(1, candidate - now);
  }
  throw new Error(`could not find the next ${time} in ${timezone}`);
}
