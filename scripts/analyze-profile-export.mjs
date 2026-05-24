import { pathToFileURL } from "node:url";
import {
  analyzePerformanceProfileExport,
  formatProfileExportAnalysis,
  loadProfileExport
} from "./profile-export-analysis.mjs";

function parseArgs(argv) {
  const options = {
    json: false,
    filePath: undefined
  };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
    } else if (!options.filePath) {
      options.filePath = arg;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  if (!options.filePath) {
    throw new Error("Usage: node scripts/analyze-profile-export.mjs <profile.json> [--json]");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const analysis = analyzePerformanceProfileExport(loadProfileExport(options.filePath));
  if (options.json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    process.stdout.write(formatProfileExportAnalysis(analysis));
  }
  if (analysis.warnings.length > 0) {
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
