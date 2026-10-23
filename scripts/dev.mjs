#!/usr/bin/env node
/**
 * Start the dev stack, with or without the Node backend.
 *
 *   pnpm dev                 Next.js alone, talking to Supabase
 *   pnpm dev --nodejs        Next.js + backend-node, talking to MongoDB
 *   pnpm dev:node            the same, spelled unambiguously
 *
 * Why a script rather than `concurrently`: it needs to do three things a generic runner
 * can't. It sets `KEEPSTACK_BACKEND` for the Next.js process so you don't have to edit
 * `.env` to switch, it waits for the backend's `/health` before starting Next so the first
 * page render doesn't race the API, and it refuses to start if `backend-node` hasn't been
 * installed. That's worth ~150 lines and one fewer dependency.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const backendDir = path.join(root, "backend-node");

/**
 * Did the caller ask for the Node backend?
 *
 * Three spellings, because the three package managers disagree about what happens to a flag
 * after the script name. `npm run dev --nodejs` never reaches argv at all — npm swallows it
 * and exports `npm_config_nodejs=true` instead. pnpm and yarn forward it to argv. Checking
 * both means the command in the README works whichever one you use.
 */
const wantsNode =
  process.argv.slice(2).some((a) => a === "--nodejs" || a === "--node" || a === "--mongo") ||
  process.env.npm_config_nodejs === "true" ||
  process.env.npm_config_node === "true" ||
  process.env.KEEPSTACK_DEV_BACKEND === "node";

const PALETTE = { next: "\x1b[36m", api: "\x1b[35m", dev: "\x1b[90m" };
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

const say = (msg) => console.log(`${PALETTE.dev}[dev]${RESET} ${msg}`);

/** Prefix every line of a child's output so interleaved logs stay readable. */
function pipe(stream, name) {
  let partial = "";
  stream.on("data", (chunk) => {
    const lines = (partial + chunk.toString()).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      process.stdout.write(`${PALETTE[name]}[${name}]${RESET} ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (partial.trim()) process.stdout.write(`${PALETTE[name]}[${name}]${RESET} ${partial}\n`);
  });
}

const children = [];
let shuttingDown = false;

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ["inherit", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  pipe(child.stdout, name);
  pipe(child.stderr, name);
  children.push({ name, child });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    // One process dying takes the whole stack down. A half-running stack is worse than a
    // stopped one: you get a dashboard that renders and then 500s on every data call.
    say(`${BOLD}${name}${RESET} exited (${signal ?? `code ${code}`}) — stopping the rest`);
    shutdown(code ?? 1);
  });

  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  // Don't let a child that ignores SIGTERM hang the terminal.
  setTimeout(() => {
    for (const { child } of children) child.kill("SIGKILL");
    process.exit(code);
  }, 4000).unref();
  // Exit as soon as they're all actually gone.
  const check = setInterval(() => {
    if (children.every(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
      clearInterval(check);
      process.exit(code);
    }
  }, 100);
  check.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    say("shutting down");
    shutdown(0);
  });
}

/** Read the backend's port out of its .env, so the health check and the API URL agree with it. */
function backendPort() {
  const envFile = path.join(backendDir, ".env");
  if (existsSync(envFile)) {
    try {
      const match = /^PORT\s*=\s*(\d+)/m.exec(readFileSync(envFile, "utf8"));
      if (match) return Number(match[1]);
    } catch {
      // Unreadable .env — fall through to the default port.
    }
  }
  return 4000;
}


/** Poll /health until the backend answers, so Next.js doesn't render against a dead API. */
async function waitForBackend(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return JSON.parse(await res.text());
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function main() {
  if (!wantsNode) {
    say(`backend: ${BOLD}Supabase${RESET} (Next.js server actions, Postgres registry)`);
    say(`pass ${BOLD}--nodejs${RESET} to run against the Node + MongoDB backend instead`);
    run("next", "next", ["dev"]);
    return;
  }

  if (!existsSync(path.join(backendDir, "node_modules"))) {
    console.error(
      `\n${PALETTE.dev}[dev]${RESET} backend-node isn't installed yet. Run:\n\n` +
        `    cd backend-node && pnpm install\n`,
    );
    process.exit(1);
  }
  if (!existsSync(path.join(backendDir, ".env"))) {
    console.error(
      `\n${PALETTE.dev}[dev]${RESET} backend-node has no .env. Run:\n\n` +
        `    cd backend-node && cp .env.example .env\n\n` +
        `  then set MONGODB_URI, KEEPSTACK_MASTER_KEY and KEEPSTACK_PIN_PEPPER.\n`,
    );
    process.exit(1);
  }

  const port = backendPort();
  const apiUrl = `http://127.0.0.1:${port}`;

  say(`backend: ${BOLD}Node + MongoDB${RESET} on ${apiUrl}`);
  run("api", "pnpm", ["start"], { cwd: backendDir });

  const health = await waitForBackend(port);
  if (!health) {
    say(`${BOLD}backend didn't answer /health in 30s${RESET} — starting Next.js anyway`);
  } else {
    say(`backend ready — mongo: ${health.mongo}, vault: ${health.vault}`);
    if (health.vault !== "configured") {
      say(`${BOLD}note${RESET} the backend's vault keys are missing; secrets will fail to save`);
    }
  }

  /*
   * `KEEPSTACK_BACKEND` is set here rather than left to `.env`, which is the whole point of
   * the flag: switching backend is a different command, not a file edit you have to remember
   * to undo. Next.js doesn't overwrite variables that are already in `process.env`, so this
   * wins over `.env` for this run only.
   */
  run("next", "next", ["dev"], {
    env: { KEEPSTACK_BACKEND: "node", KEEPSTACK_API_URL: apiUrl },
  });
}

main().catch((e) => {
  console.error(e);
  shutdown(1);
});
