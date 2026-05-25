export const PROFILE_EVENT_NAMES = [
  "tabs.onCreated",
  "tabs.onUpdated",
  "tabs.onActivated",
  "tabs.onRemoved",
  "windows.onFocusChanged",
  "windows.onRemoved",
  "sessions.onChanged"
];

export class FakeEvent {
  listeners = [];
  pending = [];

  constructor(name, eventCounts) {
    this.name = name;
    this.eventCounts = eventCounts;
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  dispatch(...args) {
    if (this.name) {
      this.eventCounts[this.name] = (this.eventCounts[this.name] ?? 0) + 1;
    }
    for (const listener of this.listeners) {
      try {
        const result = listener(...args);
        if (result && typeof result.then === "function") {
          this.pending.push(result);
        }
      } catch (error) {
        this.pending.push(Promise.reject(error));
      }
    }
  }

  async emit(...args) {
    this.dispatch(...args);
    await this.flush();
  }

  async flush() {
    while (this.pending.length > 0) {
      const pending = this.pending;
      this.pending = [];
      const results = await Promise.allSettled(pending);
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) {
        throw rejected.reason;
      }
    }
  }
}

export function createProfileEvents() {
  const eventCounts = Object.fromEntries(PROFILE_EVENT_NAMES.map((name) => [name, 0]));
  return {
    eventCounts,
    events: {
      tabCreated: new FakeEvent("tabs.onCreated", eventCounts),
      tabUpdated: new FakeEvent("tabs.onUpdated", eventCounts),
      tabActivated: new FakeEvent("tabs.onActivated", eventCounts),
      tabRemoved: new FakeEvent("tabs.onRemoved", eventCounts),
      windowFocusChanged: new FakeEvent("windows.onFocusChanged", eventCounts),
      windowRemoved: new FakeEvent("windows.onRemoved", eventCounts),
      sessionChanged: new FakeEvent("sessions.onChanged", eventCounts)
    }
  };
}

export function createPassiveEvent() {
  return new FakeEvent(undefined, {});
}

export function createAlarmApi() {
  return {
    create: async () => undefined,
    clear: async () => true,
    get: async () => undefined,
    onAlarm: createPassiveEvent()
  };
}

export async function flushProfileEvents(events) {
  await Promise.all([
    events.tabCreated.flush(),
    events.tabUpdated.flush(),
    events.tabActivated.flush(),
    events.tabRemoved.flush(),
    events.windowFocusChanged.flush(),
    events.windowRemoved.flush(),
    events.sessionChanged.flush()
  ]);
}

export function resetEventCounts(eventCounts) {
  for (const name of PROFILE_EVENT_NAMES) {
    eventCounts[name] = 0;
  }
}

export function settleProfileBackgroundWork() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function eventCountsSnapshot(eventCounts) {
  return Object.fromEntries(PROFILE_EVENT_NAMES.map((name) => [name, eventCounts[name] ?? 0]));
}

export function eventCountsTotal(eventCounts) {
  return PROFILE_EVENT_NAMES.reduce((total, name) => total + (eventCounts[name] ?? 0), 0);
}
