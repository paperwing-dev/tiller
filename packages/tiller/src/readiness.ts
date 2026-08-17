import { ansi } from "./ansi.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  label: string;
  level: CheckLevel;
  detail?: string;
  fixHint?: string;
}

function levelIcon(level: CheckLevel): string {
  switch (level) {
    case "ok":
      return `${ansi.green}✓${ansi.reset}`;
    case "warn":
      return `${ansi.yellow}!${ansi.reset}`;
    case "fail":
      return `${ansi.red}✕${ansi.reset}`;
  }
}

export function hasFailures(checks: CheckResult[]): boolean {
  return checks.some((check) => check.level === "fail");
}

export function hasWarnings(checks: CheckResult[]): boolean {
  return checks.some((check) => check.level === "warn");
}

export function printCheckReport(title: string, checks: CheckResult[]): void {
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${title}\n`);

  for (const check of checks) {
    const detail = check.detail ? ` ${ansi.dim}${check.detail}${ansi.reset}` : "";
    process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${levelIcon(check.level)} ${check.label}${detail}\n`);
    if (check.fixHint) {
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset}   ${check.fixHint}\n`);
    }
  }
}
