export interface TerminalResizeTarget {
  resize(cols: number, rows: number): Promise<void>;
}

interface TerminalDimensions {
  cols: number;
  rows: number;
}

/**
 * Accepts advisory remote resizes while the agent PTY is between generations.
 * Only the latest deferred size matters; Agent serializes it with later input
 * once a target is attached.
 */
export class TerminalResizeHandoff<T extends TerminalResizeTarget> {
  private target: T | null = null;
  private pending: TerminalDimensions | null = null;

  async resize(cols: number, rows: number): Promise<void> {
    const target = this.target;
    if (!target) {
      this.pending = { cols, rows };
      return;
    }
    await target.resize(cols, rows);
  }

  async attach(target: T): Promise<void> {
    this.target = target;
    const pending = this.pending;
    this.pending = null;
    if (pending) await target.resize(pending.cols, pending.rows);
  }

  detach(target: T): void {
    if (this.target === target) this.target = null;
  }
}
