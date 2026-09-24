import "dotenv/config";

/**
 * The development scheduler.
 *
 * In production something outside the app calls POST /api/schedules/tick once a
 * minute. This is that something, for a machine where nobody wants to install a
 * cron daemon to see a schedule fire: it polls the running dev server on the
 * same interval and prints what each tick did.
 *
 * It deliberately goes through HTTP rather than importing runDueSchedules(), so
 * what runs here is exactly what a real scheduler exercises, token check
 * included. If the token is wrong in production, it is wrong here too, and you
 * find out now.
 */

const url = process.env.SCHEDULER_URL ?? "http://localhost:3000/api/schedules/tick";
const token = process.env.SCHEDULE_TOKEN ?? "";
const everyMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000);

if (!token) {
  console.error(
    "SCHEDULE_TOKEN is not set, and the tick endpoint refuses every call without it.\n" +
      "Add it to .env — see .env.example.",
  );
  process.exit(1);
}

type Tick = {
  ok: boolean;
  checked: number;
  ran: number;
  outcomes: { label: string; action: string; status?: string }[];
};

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

async function tick() {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-schedule-token": token },
    });

    if (!response.ok) {
      const detail = response.status === 401 ? " (is SCHEDULE_TOKEN the same on both sides?)" : "";
      console.error(`${stamp()}  ${response.status} from ${url}${detail}`);
      return;
    }

    const body = (await response.json()) as Tick;
    if (body.checked === 0) return; // Quiet when there is nothing to do.

    for (const outcome of body.outcomes) {
      const status = outcome.status ? ` — ${outcome.status}` : "";
      console.log(`${stamp()}  ${outcome.action.padEnd(17)} ${outcome.label}${status}`);
    }
  } catch {
    console.error(`${stamp()}  cannot reach ${url} — is \`npm run dev\` running?`);
  }
}

// Not top-level await: tsx compiles this to CommonJS, which has none.
async function main() {
  console.log(`Polling ${url} every ${Math.round(everyMs / 1000)}s. Ctrl-C to stop.`);
  await tick();
  setInterval(tick, everyMs);
}

void main();
