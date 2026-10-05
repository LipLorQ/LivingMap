// ClaudeCodeCliAiRunner (ADR-0007): the first, vendor-specific AiRunner adapter. Electron main only —
// the renderer can never reach it, choose the executable or change a flag. The AI host gets no built-in
// tools and exactly one MCP server (LivingMap's own), so it can act only through the mcp-ai AiSurface.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type {
  AiRunner,
  AiRunOutcome,
  CancelSignal,
  ReviewEvidencePack,
  ReviewRunOutcome,
} from "@living-map/application";
import { type AiFailure, CaptureAiResultSchema, ReviewAiTransportSchema } from "@living-map/contracts";
import { z } from "zod";

export type McpServerLaunch = { command: string; args: string[]; env: Record<string, string> };

// A replan (read context + memory, build a route proposal) measured ~170 s live; a question ~20 s.
const TIMEOUT_MS = 5 * 60_000;
const MAX_STDOUT_CHARS = 4 * 1024 * 1024;

/**
 * `LIVING_MAP_CLAUDE_PATH` (only that, when set) → `claude.exe` on PATH → npm global install → native
 * installer. A `.js`/`.mjs`/`.cjs` path is run with this runtime in Node mode (older npm installs).
 */
export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const override = env.LIVING_MAP_CLAUDE_PATH?.trim();
  if (override) return exists(override) ? override : null;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    ...(env.PATH ?? env.Path ?? "")
      .split(delimiter)
      .filter((dir) => isAbsolute(dir)) // a relative entry (".") would resolve against the cwd
      .map((dir) => join(dir, exe)),
    env.APPDATA && join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", exe),
    env.USERPROFILE && join(env.USERPROFILE, ".local", "bin", exe),
    env.HOME && join(env.HOME, ".local", "bin", exe),
  ];
  return candidates.find((c): c is string => typeof c === "string" && exists(c)) ?? null;
}

const SYSTEM_PROMPT = `You are the AI inside «Живая карта» (LivingMap), a Russian-language app that helps one person turn big intentions into finished results. The user typed one message into the app's universal «+». It is already saved; your job is to interpret it.

Work only through the living-map tools. First call get_living_map_context and read \`meanings\` — the permissions there are binding. Then call search_memory with the key words of the message (and once with an empty query when unsure) and respect what you find: earlier decisions and constraints still hold.

Then do the smallest right thing:
- A question («Что мне сейчас делать?» etc.) → answer from the real state and memory. kind "answer". A question itself is not a memory: do not save it.
- Something worth remembering (decision, fact, observation, preference/constraint, idea) → save_memory with the captureId. kind "memory".
- A dated event or obligation → save_memory type "commitment" with the absolute date and time. You cannot write to the external calendar; say so briefly. kind "commitment".
- A request to change the route or order, or news that makes the current order wrong (something is finished, «Сейчас» needs a replan) → if only the order of already-approved unfinished actions must change, reorder_existing_actions; otherwise create_route_proposal. The user reviews proposals in the app — never say a proposal is applied. kind "proposal", proposalId = the created proposal id (null after a reorder).
- A clearly one-off everyday errand of personal life that is neither project work nor a dated calendar event («записаться к стоматологу», «забрать байк из ремонта», «позвонить маме») → kind "household" with householdText = the errand as one short line in the user's words. Do not save it as memory and do not turn it into an action. You only suggest it: the user decides whether it goes into «Быт» — never say it was added. When unsure (it may be project work, an idea, or a dated event), do NOT use household.
- Nothing to do → kind "no_operation".
One message may need several of these (e.g. remember and propose); report the kind that matters most.

Rules: never invent facts; never claim a change you did not make; you cannot mark actions done or change the Season or «Чем ты не хочешь жертвовать ради целей?» — suggest those to the user in words. If a write returns CONFLICT_RELOAD, call get_living_map_context again and retry once. The reply is in Russian, 1–4 short sentences, warm and concrete, without IDs or technical terms. About the app, say only what is true: proposals appear at the top of the main screen for the user to confirm; manual editing (stages, actions, the current stage) is on the «Проекты» tab. Call the user's projects «проекты» (never «замыслы»).

Your final step is ALWAYS a call to the StructuredOutput tool with { kind, reply, proposalId, householdText } (householdText only for kind "household", otherwise null) — never answer in plain text; plain text is discarded and the user sees nothing.`;

// Claude Code 2.1 silently drops the whole structured-output tool for a schema carrying `$schema` or `format`
// (e.g. "uuid"); the UUID `pattern` stays, and the result is re-validated with Zod before anything is recorded.
// `io: "input"`: what the AI must send (the schema normalises it afterwards; transforms have no JSON Schema form).
const RESULT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(CaptureAiResultSchema, { io: "input" }), (key, value) =>
  key === "format" || key === "$schema" ? undefined : value,
);

/** Fixed flags (ADR-0007): the only variable parts are LivingMap-built strings, never user text. */
export function buildClaudeArgs(mcpServer: McpServerLaunch): string[] {
  const mcpConfig = JSON.stringify({ mcpServers: { "living-map": { type: "stdio", ...mcpServer } } });
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--allowedTools",
    "mcp__living-map",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt",
    SYSTEM_PROMPT,
    "--json-schema",
    RESULT_JSON_SCHEMA,
  ];
}

/** The user's text travels only on stdin, framed by LivingMap — never on the command line. */
export function buildUserMessage(input: { captureId: string; rawText: string }, now: Date, timeZone: string): string {
  const today = new Intl.DateTimeFormat("ru-RU", { dateStyle: "full", timeStyle: "short", timeZone }).format(now);
  return `Сейчас: ${today} (${timeZone}). captureId: ${input.captureId}\nСообщение пользователя из «+» (дословно):\n${input.rawText}`;
}

// Stage 7: a second job kind through the same replaceable transport (ADR-0007). Unlike a Capture,
// a Review never needs to call a tool — every fact it may cite is already handed to it on stdin.
// `--tools ""` blocks built-ins; `--strict-mcp-config` with an empty server list additionally blocks
// the user's own `~/.claude.json`/project `.mcp.json` servers from being loaded at all (without it,
// Claude Code would still load THOSE even though this run passes none of its own).
const REVIEW_SYSTEM_PROMPT = `You are the AI inside «Живая карта» (LivingMap), reviewing one closed period of the user's real life (Stage 7: разборы и обучение на прожитом). This is NOT a diary and NOT a status summary — a finding earns its place only if it would change a future decision.

You have no tools. Every fact you may use is given to you below as a numbered evidence list with stable ids — you cannot look anything else up, and you must never invent a fact that is not in that list. If the list says facts were omitted, do not assume the period was actually quieter than it was — say so is fine, inventing what might be missing is not.

Review types differ in what matters:
- daily: what changed about how work actually went today vs assumed, one repeated blocker, a commitment that changed what was possible. Not a log of the day.
- weekly: real results completed, an Intention/Stage that stalled with no activity, actual working capacity vs the target, important commitments, candidate patterns.
- seasonal: what actually changed since the season before, what assumptions proved wrong, whether the season's direction still makes sense given the evidence.
- yearly: only what the actual evidence of the year supports. There is no long-horizon life map yet to compare against — never invent one or describe a "trajectory"; if you cannot say something grounded, that is a truthful "no_useful_change" for this dimension, not a reason to guess.

Do the smallest right thing:
- If nothing in the evidence would change a future decision, answer kind "no_useful_change" — this is the common, healthy outcome; do not force a finding to exist.
- Otherwise, list findings (0–3 is the normal range; more only if something is genuinely critical). Each finding: "text" in Russian, 1-3 sentences — what should change future decisions, never a chronological recap, never praise, never "ты поработал N минут" by itself. "evidenceRefs" must be copied exactly from the ids given to you (at least one; anything you did not receive makes your whole answer rejected). "suggestion": a short optional note if a real strategic change seems warranted (route/season/etc.) — you cannot apply it, only the user can, by raising it themselves; otherwise null.
- Write "text" the way a close friend who actually paid attention would say it out loud, not the way a status report or a consulting deck would. Plain, everyday Russian words; direct verbs; one concrete thought per finding. Never abstract-noun piles ("тенденция к изменению последовательности"), never fake profundity, never analysis-report tone ("наблюдается", "имеет место", "динамика"). Name the actual thing, and — when the evidence supports a count — say the count plainly instead of hedging it away. Bad: «Наблюдается тенденция к изменению последовательности выполнения действий после достижения промежуточных этапов.» Better: «После завершённого этапа ты часто меняешь порядок следующих действий.» Even better, when the evidence shows it twice: «После завершённого этапа ты дважды поменяла порядок следующих действий.» Never make the claim stronger than the evidence just to sound punchier.
- "patternKey": ONLY if this looks like a recurring theme worth watching for across periods. You are given a list of themes already being tracked, each with an example — if one of them is genuinely the same theme, reuse ITS EXACT slug so the system can recognize the repetition; do not invent a near-duplicate (e.g. "doctor-visits" vs "medical-appointments" must not both exist for the same theme). Only mint a new slug (lowercase-with-hyphens, 3-60 chars) if none of the known themes fit. Otherwise null.

Never claim you changed anything — this job cannot write anything at all.

Your final step is ALWAYS a call to the StructuredOutput tool with { result: { kind, findings? } } — never plain text; plain text is discarded and nothing is recorded.`;

// A discriminated union's JSON Schema is a root `oneOf` with no top-level `type`, which the API
// rejects for a custom tool's `input_schema` (`tools.0.custom.input_schema.type: Field required`);
// `ReviewAiTransportSchema` wraps it in an object so the root satisfies Claude while the nested
// value is still exactly the strict, discriminated `ReviewAiResultSchema` (see contracts/review.ts).
const REVIEW_RESULT_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(ReviewAiTransportSchema), (key, value) =>
  key === "format" || key === "$schema" ? undefined : value,
);

/** `--tools ""` blocks built-ins; `--strict-mcp-config` + an empty server list blocks every MCP server too. */
export function buildReviewClaudeArgs(): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt",
    REVIEW_SYSTEM_PROMPT,
    "--json-schema",
    REVIEW_RESULT_JSON_SCHEMA,
  ];
}

/** The whole evidence pack travels on stdin — the closed set of facts the AI may cite (Stage 7 §21). */
export function buildReviewUserMessage(evidence: ReviewEvidencePack, now: Date, timeZone: string): string {
  const today = new Intl.DateTimeFormat("ru-RU", { dateStyle: "full", timeStyle: "short", timeZone }).format(now);
  const period = `${evidence.periodStart} — ${evidence.periodEnd} (${evidence.timeZone})`;
  const list = evidence.items.map((item) => `[${item.id}] ${item.text}`).join("\n");
  const cutNotice = evidence.truncated
    ? `\n(показаны первые ${evidence.items.length} фактов из большего числа — остальные не показаны)`
    : "";
  const themes = evidence.knownPatternThemes.length
    ? `\nУже отслеживаемые темы (patternKey — пример): ${evidence.knownPatternThemes.map((t) => `${t.patternKey} — "${t.text}"`).join("; ")}`
    : "";
  return `Сейчас: ${today}. Тип разбора: ${evidence.type}. Период: ${period}.\nДоказательства за период (id в квадратных скобках — используй только эти id в evidenceRefs):\n${list || "(за этот период нет доступных фактов)"}${cutNotice}${themes}`;
}

/** Child environment: no API keys / alternative providers, so a run can only use the subscription login. */
export function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /^(ANTHROPIC_|CLAUDE_CODE_USE_)/i.test(key) || key === "ELECTRON_RUN_AS_NODE") continue;
    clean[key] = value;
  }
  return clean;
}

export type ProcessOutcome = {
  exitCode: number | null;
  stdout: string;
  stopped: null | "not_found" | "timeout" | "overflow" | "cancelled" | "refused";
};

/**
 * `spawn` without a shell, stdin written once, bounded output, a hard timeout and cancellation. Always
 * resolves. stderr is drained but never kept: it may hold local paths or account details.
 */
export function runProcess(
  file: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    stdin: string;
    signal: CancelSignal;
    timeoutMs?: number | undefined;
    maxStdoutChars?: number;
    shouldStop?: (stdoutSoFar: string) => boolean;
  },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stopped: ProcessOutcome["stopped"] = null;
    let settled = false;
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true });
    const stop = (why: NonNullable<ProcessOutcome["stopped"]>) => {
      stopped ??= why;
      child.kill();
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs ?? TIMEOUT_MS);
    const onAbort = () => stop("cancelled");
    opts.signal.addEventListener("abort", onAbort, { once: true });
    if (opts.signal.aborted) onAbort();
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stopped });
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return;
      stdout += chunk;
      if (stdout.length > (opts.maxStdoutChars ?? MAX_STDOUT_CHARS)) stop("overflow");
      else if (opts.shouldStop?.(stdout)) stop("refused");
    });
    child.stderr.resume(); // drained so the child never blocks on a full pipe; content deliberately discarded
    child.stdin.on("error", () => {}); // EPIPE when the child exits before reading everything
    child.stdin.end(opts.stdin);
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EINVAL") stopped ??= "not_found";
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

type CliEvent = Record<string, unknown>;

function events(stdout: string): CliEvent[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === "object" ? [value as CliEvent] : [];
    } catch {
      return [];
    }
  });
}

const findInit = (list: CliEvent[]) => list.find((e) => e.type === "system" && e.subtype === "init");

/** Subscription login reports `apiKeySource: "none"`; anything else would be a (paid) API key. */
function usesApiKey(init: CliEvent): boolean {
  return typeof init.apiKeySource === "string" && init.apiKeySource !== "none";
}

function classifyErrorText(text: string): AiFailure {
  if (/not logged in|log ?in|auth|credential|api key|token/i.test(text)) return "not_authenticated";
  if (/usage limit|rate.?limit|quota|429|limit reached/i.test(text)) return "rate_limited";
  if (/connect|network|fetch failed|enotfound|econn|etimedout|offline|socket|dns/i.test(text)) return "offline";
  return "failed";
}

/**
 * Claude Code `stream-json` output → vendor-neutral outcome. Only `structured_output` is ever
 * trusted. Shared by both job kinds; `requireMcp` is true only for a Capture (a Review has no MCP
 * server to check at all — see `REVIEW_SYSTEM_PROMPT` above).
 */
function interpretStructuredOutput<T>(
  stdout: string,
  parse: (value: unknown) => { success: boolean; data?: T },
  requireMcp: boolean,
): { ok: true; result: T } | { ok: false; failure: AiFailure } {
  const fail = (failure: AiFailure) => ({ ok: false, failure }) as const;
  const list = events(stdout);
  const init = findInit(list);
  const apiError = list.find((e) => e.type === "assistant" && typeof e.error === "string")?.error;
  const result = list.findLast((e) => e.type === "result");

  if (apiError === "authentication_failed" || apiError === "billing_error") return fail("not_authenticated");
  if (apiError === "rate_limit") return fail("rate_limited");
  if (init && usesApiKey(init)) return fail("not_authenticated");
  if (requireMcp) {
    const servers = Array.isArray(init?.mcp_servers)
      ? (init.mcp_servers as Array<{ name?: unknown; status?: unknown }>)
      : [];
    // Claude Code emits `init` after waiting only ~2.5 s for MCP: a slower start reads "pending" there, then
    // connects and its tools work (Gate B: a real Proposal was created by a run marked mcp_failed). Only an
    // MCP that is absent or reported as anything else (failed / needs-auth) is a transport failure.
    const mcp = servers.find((s) => s.name === "living-map")?.status;
    if (init && mcp !== "connected" && mcp !== "pending") return fail("mcp_failed");
  }
  if (!result) return fail(typeof apiError === "string" ? classifyErrorText(apiError) : "failed");
  if (result.is_error === true || result.subtype !== "success") {
    return fail(classifyErrorText(typeof result.result === "string" ? result.result : ""));
  }
  const parsed = parse(result.structured_output);
  return parsed.success ? { ok: true, result: parsed.data as T } : fail("malformed");
}

export function interpretCliOutput(stdout: string): AiRunOutcome {
  return interpretStructuredOutput(stdout, (v) => CaptureAiResultSchema.safeParse(v), true);
}

export function interpretReviewCliOutput(stdout: string): ReviewRunOutcome {
  return interpretStructuredOutput(
    stdout,
    (v) => {
      const envelope = ReviewAiTransportSchema.safeParse(v);
      return envelope.success ? { success: true, data: envelope.data.result } : { success: false };
    },
    false,
  );
}

type JobRunOutcome = { failure: AiFailure } | { stdout: string };

export function createClaudeCodeCliAiRunner(opts: {
  mcpServer: McpServerLaunch;
  /** An empty directory: no project CLAUDE.md / .claude settings are picked up from it. */
  workDir: string;
  resolveExecutable?: () => string | null;
  run?: typeof runProcess;
  now?: () => Date;
  timeZone?: () => string;
  timeoutMs?: number;
}): AiRunner {
  const resolveExecutable = opts.resolveExecutable ?? (() => resolveClaudeExecutable());
  const run = opts.run ?? runProcess;
  const timeZone = opts.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  /** Shared by both job kinds: spawn, refuse an API-key run before any model call, map the stopped code. */
  async function runJob(args: string[], stdin: string, signal: CancelSignal): Promise<JobRunOutcome> {
    const file = resolveExecutable();
    if (!file) return { failure: "not_installed" };
    mkdirSync(opts.workDir, { recursive: true });
    const env = childEnv(process.env);
    const isScript = /\.[cm]?js$/i.test(file);
    if (isScript) env.ELECTRON_RUN_AS_NODE = "1";
    let initChecked = false;
    const out = await run(isScript ? process.execPath : file, isScript ? [file, ...args] : args, {
      cwd: opts.workDir,
      env,
      stdin,
      signal,
      timeoutMs: opts.timeoutMs,
      // Refuse before the first model call if this run would bill an API key instead of the subscription.
      shouldStop: (sofar) => {
        if (initChecked) return false;
        const init = findInit(events(sofar));
        if (!init) return false;
        initChecked = true;
        return usesApiKey(init);
      },
    });
    switch (out.stopped) {
      case "not_found":
        return { failure: "not_installed" };
      case "timeout":
        return { failure: "timeout" };
      case "overflow":
        return { failure: "malformed" };
      case "refused":
        return { failure: "not_authenticated" };
      case "cancelled":
        return { failure: "failed" };
      default:
        return { stdout: out.stdout };
    }
  }

  return {
    async processCapture(input, signal) {
      // The capture id rides on the MCP child's environment (never the AI's say-so): every write of this
      // run is linked to this Capture, which makes a retry idempotent (ADR-0007).
      const args = buildClaudeArgs({
        ...opts.mcpServer,
        env: { ...opts.mcpServer.env, LIVING_MAP_CAPTURE_ID: input.captureId },
      });
      const stdin = buildUserMessage(input, opts.now?.() ?? new Date(), timeZone());
      const out = await runJob(args, stdin, signal);
      return "failure" in out ? { ok: false, failure: out.failure } : interpretCliOutput(out.stdout);
    },
    async processReview(evidence, signal) {
      const out = await runJob(
        buildReviewClaudeArgs(),
        buildReviewUserMessage(evidence, opts.now?.() ?? new Date(), timeZone()),
        signal,
      );
      return "failure" in out ? { ok: false, failure: out.failure } : interpretReviewCliOutput(out.stdout);
    },
  };
}
