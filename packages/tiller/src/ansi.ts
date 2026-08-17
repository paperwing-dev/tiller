/**
 * Shared ANSI escape-code helpers used by the picker and attach client.
 */

const ESC = "\x1b";
const CSI = `${ESC}[`;

export const ansi = {
  clearScreen: `${CSI}2J${CSI}H`,
  cursorUp: (n: number) => `${CSI}${n}A`,
  cursorDown: (n: number) => `${CSI}${n}B`,
  eraseLine: `${CSI}2K\r`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  blue: `${CSI}34m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  cyan: `${CSI}36m`,
  magenta: `${CSI}35m`,
  red: `${CSI}31m`,
  reset: `${CSI}0m`,
  inverse: `${CSI}7m`,
};

export { ESC, CSI };
