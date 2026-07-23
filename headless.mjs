#!/usr/bin/env node

import {
  HEADLESS_HELP,
  HeadlessArgumentError,
  formatHeadlessText,
  parseHeadlessArgs,
  runHeadlessTournament,
} from "./src/headless.js";

const argv = process.argv.slice(2);

try {
  const options = parseHeadlessArgs(argv);
  if (options.help) {
    process.stdout.write(HEADLESS_HELP);
  } else {
    const summary = runHeadlessTournament(options);
    const output = options.format === "json"
      ? `${JSON.stringify(summary, null, 2)}\n`
      : formatHeadlessText(summary);
    process.stdout.write(output);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (requestedJson(argv)) {
    process.stderr.write(`${JSON.stringify({ error: { message, type: error?.name || "Error" } })}\n`);
  } else {
    const label = error instanceof HeadlessArgumentError
      ? "参数错误 / Argument error"
      : "运行失败 / Tournament failed";
    process.stderr.write(`${label}: ${message}\n使用 --help 查看帮助 / Run with --help for usage.\n`);
  }
  process.exitCode = 1;
}

function requestedJson(args) {
  return args.some((value, index) => {
    const text = String(value).toLowerCase();
    return text === "--format=json" || (text === "--format" && String(args[index + 1]).toLowerCase() === "json");
  });
}
