export interface Config {
  databasePath: string;
  boxes: string[];
  pollMinutes: number;
  calendarId?: number;
  travelLabel: string;
  model: string;
  effort: "low" | "medium" | "high";
  heyCommand: string;
}

export function loadConfig(env = process.env): Config {
  const boxes = (env.HEY_BOXES ?? "Imbox,Paper Trail").split(",").map((box) => box.trim()).filter(Boolean);
  if (!boxes.length) throw new Error("HEY_BOXES must name at least one box");
  const pollMinutes = Number(env.POLL_MINUTES ?? 5);
  if (!(pollMinutes >= 1)) throw new Error("POLL_MINUTES must be at least 1");
  const calendarId = env.HEY_CALENDAR_ID ? Number(env.HEY_CALENDAR_ID) : undefined;
  if (calendarId !== undefined && !Number.isInteger(calendarId)) throw new Error("HEY_CALENDAR_ID must be an integer");
  const effort = (env.CLAUDE_EFFORT ?? "low") as Config["effort"];
  if (!["low", "medium", "high"].includes(effort)) throw new Error("CLAUDE_EFFORT must be low, medium, or high");
  return {
    databasePath: env.DATABASE_PATH ?? "/data/travel.sqlite3",
    boxes,
    pollMinutes,
    calendarId,
    travelLabel: env.TRAVEL_LABEL ?? "Travel",
    model: env.CLAUDE_MODEL ?? "claude-haiku-5-5",
    effort,
    heyCommand: env.HEY_COMMAND ?? "hey",
  };
}
