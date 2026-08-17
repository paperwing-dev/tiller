import { ansi } from "./ansi.js";

//  Benford dory — two-masted junk-rigged schooner with portholes.
//
//        |    |
//       /|   /|
//      /_|  /_|
//   __/__|_/__|___
//    \__o__o__o__/
//      ~^~~^~

const BOAT = [
  "      |    |",
  "     /|   /|",
  "    /_|  /_|",
  "___/__|_/__|___",
  " \\__o__o__o___/",
];

const DECK_WIDTH = 15;

function waveFrame(tick: number): string {
  const p = "~^~~^~";
  let s = "";
  for (let i = 0; i < DECK_WIDTH; i++) s += p[(i + tick) % p.length];
  return `${ansi.cyan}${s}${ansi.reset}`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForSettlementOrWaveTick(settled: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function playSplash<T>(work: Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return work;

  let done = false;
  const settled = work.then(
    () => { done = true; },
    () => { done = true; },
  );

  // Draw boat line by line
  process.stderr.write("\n");
  for (let i = 0; i < 3; i++) {
    process.stderr.write(`${ansi.bold}${BOAT[i]}${ansi.reset}\n`);
    await sleep(60);
  }
  process.stderr.write(`${ansi.yellow}${BOAT[3]}${ansi.reset}\n`);
  await sleep(60);
  process.stderr.write(
    `${ansi.yellow}${BOAT[4].replace(/o/g, `${ansi.reset}${ansi.cyan}o${ansi.reset}${ansi.yellow}`)}${ansi.reset}\n`,
  );
  await sleep(120);

  // Then animate wave while work runs
  let tick = 0;
  while (!done) {
    process.stderr.write(`\r${ansi.eraseLine}${waveFrame(tick)}`);
    tick++;
    await waitForSettlementOrWaveTick(settled, 400);
  }

  process.stderr.write(`\r${ansi.eraseLine}\n`);
  return work;
}
