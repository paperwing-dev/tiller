import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playSplash } from "./splash.js";

describe("playSplash", () => {
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let originalIsTTYDescriptor: PropertyDescriptor | undefined;

  function setStderrIsTTY(value: boolean): void {
    Object.defineProperty(process.stderr, "isTTY", {
      configurable: true,
      value,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setStderrIsTTY(true);
  });

  afterEach(() => {
    stderrWrite.mockRestore();
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stderr, "isTTY", originalIsTTYDescriptor);
    } else {
      delete (process.stderr as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    }
    vi.useRealTimers();
  });

  it("keeps the full boat draw but does not add a wave tick after completed work", async () => {
    const result = playSplash(Promise.resolve("ready"));
    let completed = false;
    void result.then(() => { completed = true; });

    await vi.advanceTimersByTimeAsync(359);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ready");
    expect(completed).toBe(true);
  });

  it("stops the wave wait as soon as work settles", async () => {
    const work = new Promise<string>((resolve) => {
      setTimeout(() => resolve("ready"), 500);
    });
    const result = playSplash(work);
    let completed = false;
    void result.then(() => { completed = true; });

    await vi.advanceTimersByTimeAsync(499);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ready");
    expect(completed).toBe(true);
  });

  it("preserves work rejection after rendering the boat", async () => {
    const error = new Error("setup failed");
    const result = playSplash(Promise.reject(error));
    const rejection = expect(result).rejects.toBe(error);

    await vi.advanceTimersByTimeAsync(360);
    await rejection;
  });

  it("does not render or delay work outside a TTY", async () => {
    setStderrIsTTY(false);

    await expect(playSplash(Promise.resolve("ready"))).resolves.toBe("ready");
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
