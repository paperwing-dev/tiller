const ESC = "\x1b";
const BEL = "\x07";
const CAN = "\x18";
const SUB = "\x1a";

export const MAX_DSR_CANDIDATE_CHARS = 64;

export interface CursorPositionDsrFilterResult {
  output: string;
  removedCount: number;
}

function isCursorPositionDsr(candidate: string): boolean {
  const match = /^\x1b\[(?:\?)?([0-9]+)n$/.exec(candidate);
  return match !== null && Number(match[1]) === 6;
}

type ParserState = "ground" | "escape" | "csi" | "string" | "string-escape";

/**
 * Streaming, 7-bit VT filter that removes only cursor-position DSR requests
 * from ground-state CSI. Everything else is emitted byte-for-code-unit
 * unchanged, including malformed/cancelled candidates and control strings.
 */
export class CursorPositionDsrFilter {
  private state: ParserState = "ground";
  private candidate = "";
  private stringKind: "]" | "P" | "_" | "^" | "X" | null = null;

  push(chunk: string): string {
    return this.pushWithReport(chunk).output;
  }

  pushWithReport(chunk: string): CursorPositionDsrFilterResult {
    let output = "";
    let removedCount = 0;

    const emitCandidate = () => {
      output += this.candidate;
      this.candidate = "";
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
          if (char === "[") {
            this.candidate += char;
            this.state = "csi";
            break;
          }
          if (char === "]" || char === "P" || char === "_" || char === "^" || char === "X") {
            output += this.candidate + char;
            this.candidate = "";
            this.stringKind = char;
            this.state = "string";
            break;
          }
          emitCandidate();
          this.state = "ground";
          processGround(char);
          break;

        case "csi": {
          if (char === CAN || char === SUB) {
            this.candidate += char;
            emitCandidate();
            this.state = "ground";
            break;
          }
          if (char === ESC) {
            emitCandidate();
            this.candidate = ESC;
            this.state = "escape";
            break;
          }
          if (this.candidate.length >= MAX_DSR_CANDIDATE_CHARS) {
            emitCandidate();
            this.state = "ground";
            processGround(char);
            break;
          }

          this.candidate += char;
          const code = char.charCodeAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            if (isCursorPositionDsr(this.candidate)) {
              this.candidate = "";
              removedCount += 1;
            } else {
              emitCandidate();
            }
            this.state = "ground";
          }
          break;
        }

        case "string":
          output += char;
          if (char === CAN || char === SUB || (this.stringKind === "]" && char === BEL)) {
            this.state = "ground";
            this.stringKind = null;
          } else if (char === ESC) {
            this.state = "string-escape";
          }
          break;

        case "string-escape":
          output += char;
          if (char === "\\") {
            this.state = "ground";
            this.stringKind = null;
          } else if (char === CAN || char === SUB || (this.stringKind === "]" && char === BEL)) {
            this.state = "ground";
            this.stringKind = null;
          } else if (char !== ESC) {
            this.state = "string";
          }
          break;
      }
    }

    return { output, removedCount };
  }

  /** Emit a split/incomplete CSI candidate unchanged when the PTY exits. */
  end(): string {
    const trailing = this.candidate;
    this.candidate = "";
    this.state = "ground";
    this.stringKind = null;
    return trailing;
  }
}
