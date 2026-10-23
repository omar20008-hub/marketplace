/**
 * Runs the Orchestrator's behaviour cases against the live model and prints what
 * each one did. Needs a Gemini key, and makes real model calls, so it is a manual
 * check, not part of the test suite.
 *
 *   GEMINI_API_KEY=... npx tsx scripts/orchestrator-eval.ts
 *   GEMINI_API_KEY=... ORCHESTRATOR_MODEL=gemini-2.5-flash-lite npx tsx scripts/orchestrator-eval.ts
 *
 * Exit code 0 when every case passes, 1 when any fails, 2 when no key is set.
 */
import { cases } from "../src/server/orchestrator/eval/cases";
import { runCase } from "../src/server/orchestrator/eval/harness";
import { createGeminiModel } from "../src/server/orchestrator/gemini";

async function main(): Promise<number> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Set GEMINI_API_KEY to run the live evaluation.");
    return 2;
  }

  const model = createGeminiModel({
    apiKey,
    model: process.env.ORCHESTRATOR_MODEL ?? "gemini-3.1-flash-lite",
  });

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  let failed = 0;
  for (const c of cases) {
    const result = await runCase(c, model).catch((error: unknown) => ({
      id: c.id,
      pass: false,
      failures: [`threw: ${error instanceof Error ? error.message : String(error)}`],
      attempts: [],
      reply: "",
    }));

    if (!result.pass) failed += 1;
    console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.id}`);
    for (const failure of result.failures) console.log(`      - ${failure}`);
    if (!result.pass) {
      console.log(`      attempts: ${JSON.stringify(result.attempts)}`);
      console.log(`      reply: ${result.reply.slice(0, 300)}`);
    }

    // The free tier is rate limited; a short pause keeps one run from tripping it.
    await pause(1500);
  }

  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  return failed > 0 ? 1 : 0;
}

main().then((code) => {
  process.exitCode = code;
});
