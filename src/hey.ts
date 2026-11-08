import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface ThreadRef {
  topicId: number;
  postingId: number;
  revision: string;
  receivedAt: string;
  subject: string;
  summary: string;
  sender: string;
  hasAttachments: boolean;
}

export interface Attachment {
  filename: string;
  content: Uint8Array;
}

export interface Thread {
  markdown: string;
  latestAt: string;
  attachments: Attachment[];
}

export interface EventInput {
  title: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  timeZone?: string;
  location: string;
  notes: string;
}

export class Hey {
  constructor(private command: string) {}

  async listBox(box: string, all: boolean): Promise<ThreadRef[]> {
    const data = record(await this.json(["box", "view", box, ...(all ? ["--all"] : ["--limit", "50"])]));
    const postings = Array.isArray(data.postings) ? data.postings.filter(isRecord) : [];
    return postings.flatMap((posting) => {
      const topicId = Number(posting.topic_id);
      const postingId = Number(posting.id);
      // active_at moves only when mail arrives; updated_at also moves when we label the thread.
      const revision = String(posting.active_at ?? posting.updated_at ?? posting.created_at ?? "");
      if (!Number.isInteger(topicId) || !Number.isInteger(postingId) || !revision) return [];
      return [{
        topicId, postingId, revision, receivedAt: revision,
        subject: String(posting.name ?? ""), summary: String(posting.summary ?? ""),
        sender: person(posting.creator ?? posting.sender),
        hasAttachments: posting.includes_attachments === true || posting.includes_calendar_invites === true,
      }];
    });
  }

  async readThread(ref: ThreadRef): Promise<Thread> {
    const entries = (await this.json(["thread", "read", String(ref.topicId)]) as unknown[]).filter(isRecord);
    const sections = entries.map((entry) => [
      `## From ${person(entry.creator ?? entry.sender) || "unknown"} at ${entry.created_at ?? "unknown"}`,
      typeof entry.body === "string" ? entry.body : "",
    ].join("\n\n"));
    const markdown = [`# ${ref.subject || `Thread ${ref.topicId}`}`, ...sections].join("\n\n");
    const attachments: Attachment[] = [];
    const listed = await this.json(["attachment", "list", String(ref.topicId)]);
    for (const item of Array.isArray(listed) ? listed.filter(isRecord) : []) {
      if (!item.id) continue;
      const directory = await mkdtemp(join(tmpdir(), "hey-attachment-"));
      try {
        const filename = basename(String(item.filename || `attachment-${item.id}`));
        const saved = record(await this.json(["attachment", "save", String(item.id), "--output", join(directory, filename)]));
        attachments.push({ filename, content: await readFile(typeof saved.path === "string" ? saved.path : join(directory, filename)) });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    return { markdown, latestAt: String(entries.at(-1)?.created_at ?? ref.receivedAt), attachments };
  }

  async labelId(name: string): Promise<number | undefined> {
    const labels = await this.json(["label", "list", "--all"]);
    const match = (Array.isArray(labels) ? labels.filter(isRecord) : [])
      .find((label) => String(label.name ?? "").toLowerCase() === name.toLowerCase());
    return match ? Number(match.id) : undefined;
  }

  async addLabel(postingId: number, labelId: number): Promise<void> {
    await this.json(["label", "add", String(postingId), "--to", String(labelId)]);
  }

  async createEvent(event: EventInput, calendarId?: number): Promise<number> {
    const args = ["event", "add", event.title, ...eventFlags(event)];
    if (calendarId !== undefined) args.push("--calendar", String(calendarId));
    const id = findId(await this.json(args));
    if (id === undefined) throw new Error("HEY did not return an event ID");
    return id;
  }

  async editEvent(id: number, event: EventInput): Promise<void> {
    await this.json(["event", "edit", String(id), "--title", event.title, ...eventFlags(event)]);
  }

  async deleteEvent(id: number): Promise<void> {
    await this.json(["event", "delete", String(id)]);
  }

  async version(): Promise<string> {
    return (await run([this.command, "--version"])).trim();
  }

  private async json(args: string[]): Promise<unknown> {
    const output = await run([this.command, ...args, "--json"]);
    let payload: unknown;
    try {
      payload = JSON.parse(output);
    } catch {
      throw new Error(`hey ${args[0]} ${args[1]} returned malformed JSON`);
    }
    if (isRecord(payload) && payload.ok === false) throw new Error(`hey ${args[0]} ${args[1]}: ${payload.error ?? "failed"}`);
    return isRecord(payload) && "data" in payload ? payload.data : payload;
  }
}

function eventFlags(event: EventInput): string[] {
  const flags = ["--notes", event.notes, "--location", event.location, "--starts-on", event.startDate, "--ends-on", event.endDate];
  if (event.allDay) return [...flags, "--all-day"];
  return [...flags, "--start-time", event.startTime!, "--end-time", event.endTime!, "--time-zone", event.timeZone!];
}

async function run(cmd: string[]): Promise<string> {
  const process = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} exited ${code}: ${(stderr || stdout).trim().slice(0, 2000)}`);
  return stdout;
}

function findId(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.map(findId).find((id) => id !== undefined);
  if (!isRecord(value)) return undefined;
  if (value.id) return Number(value.id);
  return Object.values(value).map(findId).find((id) => id !== undefined);
}

function person(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  const name = String(value.name ?? "").trim();
  const email = String(value.email_address ?? "").trim();
  return name && email ? `${name} <${email}>` : name || email;
}

function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
