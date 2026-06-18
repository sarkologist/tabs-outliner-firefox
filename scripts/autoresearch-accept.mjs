import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultResultsPath = join(rootDir, "autoresearch/acceptance/results.tsv");

const LANE_COMMANDS = {
  runtime: [
    {
      label: "runtime oracle build",
      command: "pnpm",
      args: ["run", "oracle:build"]
    },
    {
      label: "runtime vitest corpus",
      command: "pnpm",
      args: ["test"]
    },
    {
      label: "runtime build",
      command: "pnpm",
      args: ["run", "build"]
    },
    {
      label: "runtime regression trace hunt",
      command: "pnpm",
      args: ["trace-hunt:runtime"],
      env: {
        RUNTIME_TRACE_HUNT_PROFILE: "regression",
        RUNTIME_TRACE_HUNT_BATCH_SIZE: "50"
      }
    }
  ],
  projection: [
    {
      label: "projection build",
      command: "pnpm",
      args: ["run", "build"]
    },
    {
      label: "projection hunt",
      command: "pnpm",
      args: [
        "exec",
        "playwright",
        "test",
        "tests/playwright/sidebar-projection-hunt.spec.ts",
        "--reporter=list",
        "--workers=1"
      ]
    },
    {
      label: "projection perf guard",
      command: "pnpm",
      args: ["perf:sidebar-projection-guard"]
    }
  ],
  storage: [
    {
      label: "storage vitest corpus",
      command: "pnpm",
      args: [
        "test",
        "--",
        "src/background/storage-v2.test.ts",
        "src/background/storage-v4.test.ts",
        "src/background/outline-journal.test.ts"
      ]
    },
    {
      label: "storage build",
      command: "pnpm",
      args: ["run", "build"]
    },
    {
      label: "storage first paint",
      command: "pnpm",
      args: [
        "exec",
        "playwright",
        "test",
        "tests/playwright/sidebar-first-paint.spec.ts",
        "--reporter=list"
      ]
    }
  ],
  // Storage fault lane (docs/storage-rearchitecture 03-WORKFLOW-FIXES W-4): torn writes,
  // failed sets, and crash/restart sequences against the fault-injecting storage mock.
  // Required for any experiment that changes save timing or save shape (W-8).
  "storage-faults": [
    {
      label: "storage fault corpus",
      command: "pnpm",
      args: [
        "exec",
        "vitest",
        "run",
        "src/background/storage-v4.test.ts",
        "src/background/outline-journal.test.ts",
        "src/test/faulty-storage.test.ts",
        "-t",
        "fault|torn|corrupt|crash|restart|fail|reject"
      ]
    },
    {
      label: "storage fault soak",
      command: "pnpm",
      args: ["exec", "vitest", "run", "src/background/storage-v4.test.ts", "-t", "crashes"],
      env: {
        GENERATED_TRACE_SOAK: "1"
      }
    }
  ]
};

export const AUTORESEARCH_ACCEPTANCE_TSV_HEADER = [
  "timestamp",
  "tag",
  "commit",
  "profile_command",
  "perf_status",
  "correctness_status",
  "correctness_lanes",
  "correctness_commands",
  "final_status",
  "description"
].join("\t");

export function parseAcceptanceArgs(argv, env = process.env) {
  const options = {
    lanes: csvList(env.AUTORESEARCH_ACCEPTANCE_LANES),
    tag: env.AUTORESEARCH_ACCEPTANCE_TAG ?? localDateTag(new Date()),
    description: env.AUTORESEARCH_ACCEPTANCE_DESCRIPTION ?? "autoresearch candidate",
    appendResults: env.AUTORESEARCH_ACCEPTANCE_APPEND_RESULTS === "1",
    resultsPath: env.AUTORESEARCH_ACCEPTANCE_RESULTS ?? defaultResultsPath,
    json: false,
    profileCommand: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      options.profileCommand = argv.slice(index + 1);
      break;
    } else if (arg === "--lanes" && next) {
      options.lanes = csvList(next);
      index += 1;
    } else if (arg === "--tag" && next) {
      options.tag = next;
      index += 1;
    } else if (arg === "--description" && next) {
      options.description = next;
      index += 1;
    } else if (arg === "--results" && next) {
      options.resultsPath = next;
      index += 1;
    } else if (arg === "--append-results") {
      options.appendResults = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }

  if (options.lanes.length === 0) {
    throw new Error("--lanes must include at least one correctness lane");
  }
  for (const lane of options.lanes) {
    if (!LANE_COMMANDS[lane]) {
      throw new Error(`Unknown correctness lane ${lane}`);
    }
  }
  if (options.profileCommand.length === 0) {
    throw new Error("Provide the profiler command after --");
  }

  return options;
}

export function correctnessCommandsForLanes(lanes) {
  const seen = new Set();
  const commands = [];
  for (const lane of lanes) {
    for (const command of LANE_COMMANDS[lane] ?? []) {
      const key = `${command.command}\0${command.args.join("\0")}\0${JSON.stringify(command.env ?? {})}`;
      if (!seen.has(key)) {
        seen.add(key);
        commands.push(command);
      }
    }
  }
  return commands;
}

export function parseProfileJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("profiler output did not contain JSON");
  }
  return JSON.parse(output.slice(start, end + 1));
}

export async function acceptAutoresearchCandidate(options, runner = runCommand) {
  const profileCommand = {
    label: "profile",
    command: options.profileCommand[0],
    args: options.profileCommand.slice(1)
  };
  const profileResult = await runner(profileCommand);
  const timestamp = new Date().toISOString();
  const commit = await currentCommit();

  let profile;
  let perfStatus = "profile-failed";
  const correctnessResults = [];
  const correctnessFailures = [];
  if (profileResult.exitCode === 0) {
    try {
      profile = parseProfileJson(`${profileResult.stdout}\n${profileResult.stderr}`);
      perfStatus = normalizedPerfStatus(profile);
    } catch (error) {
      correctnessFailures.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    correctnessFailures.push(`profile failed with exit code ${profileResult.exitCode}`);
  }

  const perfCandidate = perfStatus === "candidate-keep";
  let correctnessStatus = perfCandidate ? "pass" : "skipped";
  if (perfCandidate) {
    for (const command of correctnessCommandsForLanes(options.lanes)) {
      const result = await runner(command);
      correctnessResults.push({ command, exitCode: result.exitCode });
      if (result.exitCode !== 0) {
        correctnessStatus = "fail";
        correctnessFailures.push(`${command.label} failed with exit code ${result.exitCode}`);
        break;
      }
    }
  }

  const finalStatus = finalAcceptanceStatus(perfStatus, correctnessStatus);
  const correctnessCommands = correctnessCommandsForLanes(options.lanes).map(formatCommand);
  const summary = {
    perfStatus,
    correctnessStatus,
    correctnessLanes: options.lanes,
    correctnessCommands,
    correctnessFailures,
    finalStatus
  };
  const tsvRow = formatAcceptanceTsvRow({
    timestamp,
    tag: options.tag,
    commit,
    profileCommand: formatCommand(profileCommand),
    perfStatus,
    correctnessStatus,
    correctnessLanes: options.lanes,
    correctnessCommands,
    finalStatus,
    description: options.description
  });

  if (options.appendResults) {
    await appendResultsTsv(options.resultsPath, tsvRow);
  }

  return {
    summary,
    profile,
    profileExitCode: profileResult.exitCode,
    correctnessResults,
    tsvHeader: AUTORESEARCH_ACCEPTANCE_TSV_HEADER,
    tsvRow,
    ...(options.appendResults ? { resultsPath: options.resultsPath } : {})
  };
}

export function formatAcceptanceTsvRow(fields) {
  return [
    fields.timestamp,
    fields.tag,
    fields.commit,
    fields.profileCommand,
    fields.perfStatus,
    fields.correctnessStatus,
    fields.correctnessLanes.join(","),
    fields.correctnessCommands.join(" && "),
    fields.finalStatus,
    fields.description
  ]
    .map(tsvCell)
    .join("\t");
}

function normalizedPerfStatus(profile) {
  const rawStatus = profile?.summary?.status ?? profile?.status;
  if (rawStatus === "keep" || rawStatus === "candidate-keep") {
    return "candidate-keep";
  }
  return typeof rawStatus === "string" && rawStatus ? rawStatus : "discard-perf";
}

function finalAcceptanceStatus(perfStatus, correctnessStatus) {
  if (perfStatus !== "candidate-keep") {
    return "discard-perf";
  }
  return correctnessStatus === "pass" ? "keep" : "discard-correctness";
}

async function runCommand(command) {
  try {
    const { stdout, stderr } = await execFileAsync(command.command, command.args, {
      cwd: rootDir,
      env: {
        ...process.env,
        ...(command.env ?? {})
      },
      maxBuffer: 1024 * 1024 * 128
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? "",
      exitCode: typeof error?.code === "number" ? error.code : 1
    };
  }
}

async function currentCommit() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: rootDir
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function appendResultsTsv(resultsPath, row) {
  await mkdir(dirname(resultsPath), { recursive: true });
  if (
    !existsSync(resultsPath) ||
    (await readFile(resultsPath, "utf8").catch(() => "")).trim() === ""
  ) {
    await writeFile(resultsPath, `${AUTORESEARCH_ACCEPTANCE_TSV_HEADER}\n`);
  }
  await appendFile(resultsPath, `${row}\n`);
}

function csvList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function localDateTag(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function formatCommand(command) {
  return [command.command, ...command.args].join(" ");
}

function tsvCell(value) {
  return String(value)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

function formatSummary(result) {
  const lines = [
    `Autoresearch acceptance: ${result.summary.finalStatus}`,
    `perf=${result.summary.perfStatus}`,
    `correctness=${result.summary.correctnessStatus}`,
    `lanes=${result.summary.correctnessLanes.join(",")}`
  ];
  for (const failure of result.summary.correctnessFailures) {
    lines.push(`failure: ${failure}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseAcceptanceArgs(process.argv.slice(2));
  const result = await acceptAutoresearchCandidate(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(formatSummary(result));
  }
  if (result.summary.finalStatus !== "keep") {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
