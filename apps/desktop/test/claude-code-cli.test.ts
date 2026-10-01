import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ReviewEvidencePack } from "@living-map/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildReviewClaudeArgs,
  childEnv,
  createClaudeCodeCliAiRunner,
  interpretCliOutput,
  interpretReviewCliOutput,
  resolveClaudeExecutable,
  runProcess,
} from "../src/main/ai/claude-code-cli";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "living-map-claude-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MCP = { command: "C:/app/electron.exe", args: ["C:/app/out/main/mcp.js"], env: { ELECTRON_RUN_AS_NODE: "1" } };
const never = new AbortController().signal;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const init = (over: Record<string, unknown> = {}) =>
  line({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    mcp_servers: [{ name: "living-map", status: "connected" }],
    ...over,
  });
const result = (over: Record<string, unknown>) =>
  line({ type: "result", subtype: "success", is_error: false, ...over });
const ANSWER = { kind: "answer", reply: "Сейчас — Исполнятор.", proposalId: null };

describe("fixed invocation (ADR-0007)", () => {
  it("no built-in tools, only LivingMap's MCP, no prompts, no user/project settings, no persistence", () => {
    const args = buildClaudeArgs(MCP);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args[0]).toBe("-p");
    expect(flag("--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(flag("--mcp-config") as string)).toEqual({
      mcpServers: { "living-map": { type: "stdio", ...MCP } },
    });
    expect(flag("--allowedTools")).toBe("mcp__living-map");
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(flag("--setting-sources")).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    expect(JSON.parse(flag("--json-schema") as string)).toMatchObject({
      type: "object",
      required: ["kind", "reply", "proposalId"],
    });
    expect(flag("--json-schema")).not.toMatch(/"format"|"\$schema"/); // the CLI would silently drop the whole schema
    for (const dangerous of ["--dangerously-skip-permissions", "--add-dir", "--resume", "--continue", "--chrome"]) {
      expect(args).not.toContain(dangerous);
    }
  });

  it("strips API keys and alternative providers from the child environment", () => {
    const env = childEnv({
      PATH: "p",
      ANTHROPIC_API_KEY: "sk-secret",
      ANTHROPIC_BASE_URL: "x",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ELECTRON_RUN_AS_NODE: "1",
      APPDATA: "a",
    });
    expect(env).toEqual({ PATH: "p", APPDATA: "a" });
  });

  it("resolves the executable: explicit override only, else PATH, else the npm global install", () => {
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    const has =
      (...found: string[]) =>
      (p: string) =>
        found.includes(p);
    expect(resolveClaudeExecutable({ LIVING_MAP_CLAUDE_PATH: "C:/x/claude.exe" }, has("C:/x/claude.exe"))).toBe(
      "C:/x/claude.exe",
    );
    expect(
      resolveClaudeExecutable({ LIVING_MAP_CLAUDE_PATH: "C:/missing.exe", PATH: "C:/bin" }, has(join("C:/bin", exe))),
    ).toBeNull();
    expect(resolveClaudeExecutable({ PATH: ["C:/a", "C:/bin"].join(delimiter) }, has(join("C:/bin", exe)))).toBe(
      join("C:/bin", exe),
    );
    const npm = join("C:/Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", exe);
    expect(resolveClaudeExecutable({ PATH: "C:/a", APPDATA: "C:/Roaming" }, has(npm))).toBe(npm);
    expect(resolveClaudeExecutable({ PATH: "C:/a" }, has())).toBeNull();
  });
});

describe("output interpretation — only structured_output is trusted", () => {
  it("success", () => {
    expect(interpretCliOutput(init() + result({ structured_output: ANSWER }))).toEqual({ ok: true, result: ANSWER });
  });

  it("Gate B: MCP still starting at init («pending») and then working is a success, not mcp_failed", () => {
    const pending = init({ mcp_servers: [{ name: "living-map", status: "pending" }] });
    expect(interpretCliOutput(pending + result({ structured_output: ANSWER }))).toEqual({ ok: true, result: ANSWER });
  });

  it.each([
    [
      "not logged in",
      init() + line({ type: "assistant", error: "authentication_failed" }) + result({ is_error: true }),
      "not_authenticated",
    ],
    [
      "rate limit",
      init() + line({ type: "assistant", error: "rate_limit" }) + result({ is_error: true }),
      "rate_limited",
    ],
    ["usage limit text", init() + result({ is_error: true, result: "Claude AI usage limit reached" }), "rate_limited"],
    ["network", init() + result({ is_error: true, result: "API Error: Connection error." }), "offline"],
    [
      "MCP did not start",
      init({ mcp_servers: [{ name: "living-map", status: "failed" }] }) + result({ structured_output: ANSWER }),
      "mcp_failed",
    ],
    [
      "API key instead of subscription",
      init({ apiKeySource: "ANTHROPIC_API_KEY" }) + result({ structured_output: ANSWER }),
      "not_authenticated",
    ],
    [
      "prose instead of the schema",
      init() + result({ result: "Сделай Исполнятор", structured_output: undefined }),
      "malformed",
    ],
    [
      "schema bypass attempt",
      init() + result({ structured_output: { ...ANSWER, kind: "accept_proposal" } }),
      "malformed",
    ],
    ["LivingMap MCP missing", init({ mcp_servers: [] }) + result({ structured_output: ANSWER }), "mcp_failed"],
    ["nothing at all", "", "failed"],
  ])("%s → %s", (_name, stdout, failure) => {
    expect(interpretCliOutput(stdout)).toEqual({ ok: false, failure });
  });
});

const EVIDENCE: ReviewEvidencePack = {
  reviewId: "00000000-0000-4000-8000-000000000009",
  type: "daily",
  periodStart: "2026-09-24T21:00:00.000Z",
  periodEnd: "2026-09-25T21:00:00.000Z",
  timeZone: "Europe/Moscow",
  items: [
    { id: "action:1", text: "Завершено действие «Написать код» (готово, когда: PR merged)", factIds: ["action:1"] },
  ],
  truncated: false,
  knownPatternThemes: [],
};
const NO_USEFUL_CHANGE = { kind: "no_useful_change" };
const NO_USEFUL_CHANGE_ENVELOPE = { result: NO_USEFUL_CHANGE };

describe("Review job (Stage 7): every MCP server blocked, evidence travels only on stdin", () => {
  it("no built-in tools and no MCP server at all — a Review job has nothing to call", () => {
    const args = buildReviewClaudeArgs();
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args[0]).toBe("-p");
    expect(flag("--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config"); // also blocks the user's own ~/.claude.json / project .mcp.json servers
    expect(JSON.parse(flag("--mcp-config") as string)).toEqual({ mcpServers: {} });
    expect(args).not.toContain("--allowedTools");
    expect(flag("--permission-mode")).toBe("dontAsk");
    // Regression (Gate B live 400): Claude's custom-tool input_schema requires a top-level
    // `type: "object"` — a discriminated union's raw JSON Schema is a root `oneOf` with none, which
    // Claude Code silently passed through to a real API call that then failed with
    // `tools.0.custom.input_schema.type: Field required`. This must stay `object` at the root, with
    // the discriminated union preserved one level down, inside `result`.
    const schema = JSON.parse(flag("--json-schema") as string);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["result"]);
    expect(schema.properties.result.oneOf).toEqual([
      expect.objectContaining({ type: "object" }),
      expect.objectContaining({ type: "object" }),
    ]);
    expect(flag("--json-schema")).not.toMatch(/"format"|"\$schema"/);
  });

  it("interprets output without ever checking for an MCP server", () => {
    expect(
      interpretReviewCliOutput(init({ mcp_servers: [] }) + result({ structured_output: NO_USEFUL_CHANGE_ENVELOPE })),
    ).toEqual({
      ok: true,
      result: NO_USEFUL_CHANGE,
    });
  });

  it("rejects a well-formed result missing the transport envelope (root must stay an object)", () => {
    expect(interpretReviewCliOutput(init() + result({ structured_output: NO_USEFUL_CHANGE }))).toEqual({
      ok: false,
      failure: "malformed",
    });
  });

  it("rejects a malformed variant even once unwrapped (kind says one thing, fields belong to another)", () => {
    expect(
      interpretReviewCliOutput(init() + result({ structured_output: { result: { kind: "findings", findings: [] } } })),
    ).toEqual({ ok: false, failure: "malformed" });
    expect(
      interpretReviewCliOutput(
        init() + result({ structured_output: { result: { kind: "no_useful_change", findings: [] } } }),
      ),
    ).toEqual({ ok: false, failure: "malformed" });
  });

  it("still classifies auth/rate-limit/malformed failures the same way as a Capture job", () => {
    expect(
      interpretReviewCliOutput(
        init({ apiKeySource: "ANTHROPIC_API_KEY" }) + result({ structured_output: NO_USEFUL_CHANGE_ENVELOPE }),
      ),
    ).toEqual({ ok: false, failure: "not_authenticated" });
    expect(interpretReviewCliOutput(init() + result({ result: "prose", structured_output: undefined }))).toEqual({
      ok: false,
      failure: "malformed",
    });
  });
});

describe("runProcess: no shell, bounded, killable", () => {
  const node = process.execPath;
  const opts = { cwd: dir, env: { ...(process.env as Record<string, string>) }, stdin: "", signal: never };

  it("passes arguments literally (no shell interpretation) and delivers stdin", async () => {
    const out = await runProcess(
      node,
      [
        "-e",
        "process.stdin.on('data',d=>process.stdout.write(JSON.stringify([process.argv.slice(1),String(d)])))",
        "a & echo INJECTED",
        "$(whoami)",
        "|x",
      ],
      { ...opts, stdin: "Перестрой порядок; rm -rf /" },
    );
    expect(out.stopped).toBeNull();
    expect(JSON.parse(out.stdout)).toEqual([["a & echo INJECTED", "$(whoami)", "|x"], "Перестрой порядок; rm -rf /"]);
  });

  it("times out and kills", async () => {
    const started = Date.now();
    const out = await runProcess(node, ["-e", "setInterval(()=>{},1000)"], { ...opts, timeoutMs: 300 });
    expect(out.stopped).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills on unbounded output", async () => {
    const out = await runProcess(node, ["-e", "setInterval(()=>process.stdout.write('x'.repeat(65536)),1)"], {
      ...opts,
      maxStdoutChars: 100_000,
    });
    expect(out.stopped).toBe("overflow");
    expect(out.stdout.length).toBeLessThan(1_000_000);
  });

  it("is cancelled when the app quits", async () => {
    const quit = new AbortController();
    setTimeout(() => quit.abort(), 100);
    const out = await runProcess(node, ["-e", "setInterval(()=>{},1000)"], { ...opts, signal: quit.signal });
    expect(out.stopped).toBe("cancelled");
  });

  it("reports a missing executable instead of throwing", async () => {
    expect((await runProcess(join(dir, "nope.exe"), [], opts)).stopped).toBe("not_found");
  });
});

describe("ClaudeCodeCliAiRunner end to end (fake CLI script)", () => {
  function fakeCli(body: string): string {
    const file = join(dir, "fake-claude.mjs");
    writeFileSync(
      file,
      `import { writeFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), key: process.env.ANTHROPIC_API_KEY ?? null }));
  ${body}
});`,
    );
    return file;
  }
  const runner = (file: string) =>
    createClaudeCodeCliAiRunner({
      mcpServer: MCP,
      workDir: join(dir, "ai-workdir"),
      resolveExecutable: () => file,
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      timeZone: () => "Asia/Jakarta",
      timeoutMs: 20_000,
    });
  const input = {
    captureId: "00000000-0000-4000-8000-000000000001",
    rawText: "Что мне сейчас делать? $(rm -rf ~)",
    createdAt: "t",
  };

  it("returns the validated result; user text went only through stdin; API keys never reach the child", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const file = fakeCli(`process.stdout.write(${JSON.stringify(init() + result({ structured_output: ANSWER }))});`);
      expect(await runner(file).processCapture(input, never)).toEqual({ ok: true, result: ANSWER });
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
    // The run's Capture id reaches only the MCP child's environment (the linkage behind idempotent retry).
    expect(seen.args).toEqual(buildClaudeArgs({ ...MCP, env: { ...MCP.env, LIVING_MAP_CAPTURE_ID: input.captureId } }));
    expect(seen.args.join(" ")).not.toContain("rm -rf");
    expect(seen.input).toContain("Что мне сейчас делать? $(rm -rf ~)");
    expect(seen.input).toContain(input.captureId);
    expect(seen.input).toContain("2026");
    expect(seen.key).toBeNull();
    expect(seen.cwd).toBe(join(dir, "ai-workdir"));
  });

  it("processReview: evidence travels on stdin, every MCP server (incl. the user's own) is blocked", async () => {
    const file = fakeCli(
      `process.stdout.write(${JSON.stringify(init() + result({ structured_output: NO_USEFUL_CHANGE_ENVELOPE }))});`,
    );
    expect(await runner(file).processReview(EVIDENCE, never)).toEqual({ ok: true, result: NO_USEFUL_CHANGE });
    const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
    expect(seen.args).toEqual(buildReviewClaudeArgs());
    expect(seen.args).toContain("--strict-mcp-config");
    expect(seen.input).toContain("action:1");
    expect(seen.input).toContain(EVIDENCE.periodStart);
  });

  it("refuses (kills before any model call) when the CLI would use an API key", async () => {
    const file = fakeCli(
      `process.stdout.write(${JSON.stringify(init({ apiKeySource: "ANTHROPIC_API_KEY" }))}); setInterval(() => {}, 1000);`,
    );
    expect(await runner(file).processCapture(input, never)).toEqual({ ok: false, failure: "not_authenticated" });
  });

  it("missing CLI → not_installed", async () => {
    const r = createClaudeCodeCliAiRunner({ mcpServer: MCP, workDir: dir, resolveExecutable: () => null });
    expect(await r.processCapture(input, never)).toEqual({ ok: false, failure: "not_installed" });
  });

  it("hung CLI → timeout", async () => {
    const file = fakeCli("setInterval(() => {}, 1000);");
    const r = createClaudeCodeCliAiRunner({
      mcpServer: MCP,
      workDir: dir,
      resolveExecutable: () => file,
      timeoutMs: 500,
    });
    expect(await r.processCapture(input, never)).toEqual({ ok: false, failure: "timeout" });
  });
});
