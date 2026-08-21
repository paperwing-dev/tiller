const parentSessions = new Map();
let foregroundSessionID = null;
let foregroundTurnActive = false;
let foregroundTurnFailed = false;
let reportQueue = Promise.resolve();

function report(state) {
  const pending = reportQueue.then(() => sendReport(state), () => sendReport(state));
  reportQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function sendReport(state) {
  const hookPath = process.env.TILLER_ACTIVITY_HOOK_PATH;
  if (!hookPath) return;
  const child = Bun.spawn(["node", hookPath, state], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
}

export const TillerActivityPlugin = async () => ({
  event: async ({ event }) => {
    const sessionInfo = event?.properties?.info;
    if (
      (event?.type === "session.created" || event?.type === "session.updated")
      && typeof sessionInfo?.id === "string"
    ) {
      parentSessions.set(
        sessionInfo.id,
        typeof sessionInfo.parentID === "string" ? sessionInfo.parentID : null,
      );
      return;
    }

    const errorSessionID = event?.properties?.sessionID;
    if (
      event?.type === "session.error"
      && typeof errorSessionID === "string"
      && errorSessionID === foregroundSessionID
      && foregroundTurnActive
    ) {
      foregroundTurnFailed = true;
      return;
    }

    if (
      event?.type === "message.updated"
      && sessionInfo?.role === "assistant"
      && sessionInfo?.error
      && sessionInfo?.sessionID === foregroundSessionID
      && foregroundTurnActive
    ) {
      foregroundTurnFailed = true;
      return;
    }

    if (event?.type !== "session.status") return;
    const sessionID = event.properties?.sessionID;
    const status = event.properties?.status?.type;
    if (typeof sessionID !== "string") return;

    if (status === "busy" || status === "retry") {
      if (parentSessions.get(sessionID)) return;
      if (foregroundSessionID === null) foregroundSessionID = sessionID;
      if (sessionID !== foregroundSessionID) return;
      if (!foregroundTurnActive) foregroundTurnFailed = false;
      foregroundTurnActive = true;
      await report("working");
      return;
    }

    // Ignore startup idle, child-session idle, and duplicate idle events.
    if (status === "idle" && sessionID === foregroundSessionID && foregroundTurnActive) {
      const signal = foregroundTurnFailed ? "idle" : "completed";
      foregroundTurnActive = false;
      foregroundTurnFailed = false;
      foregroundSessionID = null;
      await report(signal);
    }
  },
});
