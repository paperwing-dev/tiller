#!/usr/bin/env node
import { renderOpenCodeConfig } from "./opencode-config.js";

try {
  process.stdout.write(renderOpenCodeConfig());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
