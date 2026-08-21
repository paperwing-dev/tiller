export interface EarlyAgentEventState {
  pendingOutput: string;
  pendingExitCode: number | null;
}

export function createEarlyAgentEventState(): EarlyAgentEventState {
  return {
    pendingOutput: "",
    pendingExitCode: null,
  };
}

export function bufferOrEmitOutput(
  state: EarlyAgentEventState,
  data: string,
  hasOutputListener: boolean,
  emit: (data: string) => void,
): void {
  if (!data) return;
  if (hasOutputListener) {
    emit(data);
    return;
  }
  state.pendingOutput += data;
}

export function bufferOrEmitExit(
  state: EarlyAgentEventState,
  exitCode: number,
  hasExitListener: boolean,
  emit: (code: number) => void,
): void {
  if (hasExitListener) {
    emit(exitCode);
    return;
  }
  state.pendingExitCode = exitCode;
}

export function flushBufferedOutput(
  state: EarlyAgentEventState,
  hasOutputListener: boolean,
  emit: (data: string) => void,
): void {
  if (!state.pendingOutput || !hasOutputListener) return;
  const data = state.pendingOutput;
  state.pendingOutput = "";
  emit(data);
}

export function flushBufferedExit(
  state: EarlyAgentEventState,
  hasExitListener: boolean,
  emit: (code: number) => void,
): void {
  if (state.pendingExitCode == null || !hasExitListener) return;
  const code = state.pendingExitCode;
  state.pendingExitCode = null;
  emit(code);
}
