#!/usr/bin/env node

import { startRemote } from "./index.js";

interface ParsedArgs {
  piPath?: string;
  session?: string;
  funnel: boolean;
  lan: boolean;
  piArgs: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    funnel: false,
    lan: false,
    piArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      parsed.piArgs = argv.slice(index + 1);
      break;
    }
    if (arg === "--pi-path") {
      parsed.piPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--session") {
      parsed.session = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--funnel") {
      parsed.funnel = true;
      continue;
    }
    if (arg === "--lan") {
      parsed.lan = true;
      continue;
    }
  }

  return parsed;
}

const parsed = parseArgs(process.argv.slice(2));
const forwardedArgs = [...parsed.piArgs];

if (parsed.session && !forwardedArgs.includes("--session")) {
  forwardedArgs.push("--session", parsed.session);
}

startRemote({
  piPath: parsed.piPath,
  args: forwardedArgs,
  funnel: parsed.funnel,
  forceLan: parsed.lan,
  sessionFile: parsed.session,
}).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`pi-remote: ${message}\n`);
  process.exit(1);
});
