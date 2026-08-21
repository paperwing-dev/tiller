const ESC = "\x1b";
const BEL = "\x07";
const CAN = "\x18";
const SUB = "\x1a";

export const MAX_PALETTE_QUERY_CHARS = 32;

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  selectionForeground: string;
  ansi: readonly string[];
}

export type TerminalPaletteFilterEvent =
  { type: "output"; data: string } | { type: "reply"; data: string };

type ParserState =
  | "ground"
  | "escape"
  | "osc"
  | "osc-escape"
  | "osc-passthrough"
  | "osc-passthrough-escape";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function normalizeColor(value: string, label: string): string {
  if (!HEX_COLOR.test(value)) {
    throw new Error(`${label} must be a six-digit hex color.`);
  }
  return value.toLowerCase();
}

function extendedAnsiColor(index: number): string {
  if (index >= 16 && index <= 231) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(offset / 36)]!;
    const green = levels[Math.floor((offset % 36) / 6)]!;
    const blue = levels[offset % 6]!;
    return `#${red.toString(16).padStart(2, "0")}${green
      .toString(16)
      .padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
  }

  const level = 8 + (index - 232) * 10;
  const component = level.toString(16).padStart(2, "0");
  return `#${component}${component}${component}`;
}

function terminalColor(palette: TerminalPalette, index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return palette.ansi[index] ?? null;
  return extendedAnsiColor(index);
}

function specialColor(palette: TerminalPalette, index: number): string | null {
  switch (index) {
    case 10:
      return palette.foreground;
    case 11:
      return palette.background;
    case 12:
      return palette.cursor;
    case 13:
    case 15:
      return palette.foreground;
    case 14:
    case 16:
      return palette.background;
    case 17:
      return palette.selectionBackground;
    case 19:
      return palette.selectionForeground;
    default:
      return null;
  }
}

function paletteReply(palette: TerminalPalette, query: string): string | null {
  const terminator = query.endsWith(BEL) ? BEL : `${ESC}\\`;
  const indexed = /^\x1b\]4;(\d{1,3});\?(?:\x07|\x1b\\)$/.exec(query);
  if (indexed) {
    const index = Number(indexed[1]);
    const color = terminalColor(palette, index);
    return color ? `${ESC}]4;${index};${color}${terminator}` : null;
  }

  const special = /^\x1b\](\d{2});\?(?:\x07|\x1b\\)$/.exec(query);
  if (!special) return null;
  const index = Number(special[1]);
  const color = specialColor(palette, index);
  return color ? `${ESC}]${index};${color}${terminator}` : null;
}

/**
 * Removes terminal palette queries from PTY output and emits fixed replies.
 * Other OSC strings are preserved byte-for-code-unit, including split,
 * malformed, cancelled, and overlong candidates.
 */
export class TerminalPaletteQueryFilter {
  private readonly palette: TerminalPalette;
  private state: ParserState = "ground";
  private candidate = "";

  constructor(palette: TerminalPalette) {
    if (palette.ansi.length !== 16) {
      throw new Error("Terminal palette must define exactly 16 ANSI colors.");
    }
    this.palette = {
      background: normalizeColor(palette.background, "Terminal background"),
      foreground: normalizeColor(palette.foreground, "Terminal foreground"),
      cursor: normalizeColor(palette.cursor, "Terminal cursor"),
      selectionBackground: normalizeColor(
        palette.selectionBackground,
        "Terminal selection background",
      ),
      selectionForeground: normalizeColor(
        palette.selectionForeground,
        "Terminal selection foreground",
      ),
      ansi: palette.ansi.map((color, index) =>
        normalizeColor(color, `Terminal ANSI color ${index}`),
      ),
    };
  }

  push(chunk: string): TerminalPaletteFilterEvent[] {
    const events: TerminalPaletteFilterEvent[] = [];
    let output = "";

    const flushOutput = () => {
      if (!output) return;
      events.push({ type: "output", data: output });
      output = "";
    };
    const emitReply = (data: string) => {
      const previous = events[events.length - 1];
      if (previous?.type === "reply") {
        previous.data += data;
      } else {
        events.push({ type: "reply", data });
      }
    };
    const emitCandidate = () => {
      output += this.candidate;
      this.candidate = "";
    };
    const finishCandidate = () => {
      const reply = paletteReply(this.palette, this.candidate);
      if (reply) {
        flushOutput();
        emitReply(reply);
        this.candidate = "";
      } else {
        emitCandidate();
      }
      this.state = "ground";
    };
    const processGround = (char: string) => {
      if (char === ESC) {
        this.candidate = ESC;
        this.state = "escape";
      } else {
        output += char;
      }
    };

    for (const char of chunk) {
      switch (this.state) {
        case "ground":
          processGround(char);
          break;

        case "escape":
          if (char === "]") {
            this.candidate += char;
            this.state = "osc";
            break;
          }
          emitCandidate();
          this.state = "ground";
          processGround(char);
          break;

        case "osc":
          this.candidate += char;
          if (char === BEL || char === CAN || char === SUB) {
            finishCandidate();
          } else if (char === ESC) {
            this.state = "osc-escape";
          } else if (this.candidate.length > MAX_PALETTE_QUERY_CHARS) {
            emitCandidate();
            this.state = "osc-passthrough";
          }
          break;

        case "osc-escape":
          this.candidate += char;
          if (char === "\\" || char === BEL || char === CAN || char === SUB) {
            finishCandidate();
          } else if (char !== ESC) {
            this.state = "osc";
          }
          break;

        case "osc-passthrough":
          output += char;
          if (char === BEL || char === CAN || char === SUB) {
            this.state = "ground";
          } else if (char === ESC) {
            this.state = "osc-passthrough-escape";
          }
          break;

        case "osc-passthrough-escape":
          output += char;
          if (char === "\\" || char === BEL || char === CAN || char === SUB) {
            this.state = "ground";
          } else if (char !== ESC) {
            this.state = "osc-passthrough";
          }
          break;
      }
    }

    flushOutput();
    return events;
  }

  end(): TerminalPaletteFilterEvent[] {
    const trailing = this.candidate;
    this.candidate = "";
    this.state = "ground";
    return trailing ? [{ type: "output", data: trailing }] : [];
  }
}
