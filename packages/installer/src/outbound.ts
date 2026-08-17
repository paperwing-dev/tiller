export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000;

export async function withAbortDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      throw new Error("Outbound response exceeded its size limit");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Outbound response exceeded its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readBoundedResponseJson<T>(
  response: Response,
  maxBytes: number,
): Promise<T | null> {
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, maxBytes));
}
