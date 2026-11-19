import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  composeHandler: vi.fn(), messageHandler: vi.fn(), rowHandler: vi.fn(),
  register: vi.fn(), markSent: vi.fn(), recoverLink: vi.fn(), view: vi.fn(),
  messageStatus: vi.fn(),
}));
vi.mock("@inboxsdk/core", () => ({ load: async () => ({
  User: { getEmailAddress: () => "me@example.com" },
  Compose: { registerComposeViewHandler: mocks.composeHandler },
  Conversations: { registerMessageViewHandler: mocks.messageHandler },
  Lists: { registerThreadRowViewHandler: mocks.rowHandler },
  Router: { handleCustomRoute: vi.fn() },
  Search: { registerSearchQueryRewriter: vi.fn() },
  NavMenu: { addNavItem: vi.fn() },
}) }));
vi.mock("./settings.js", () => ({ loadSettings: async () => ({ serverUrl: "https://t.example.com", apiKey: "k" }) }));
vi.mock("./api.js", () => ({
  createApi: () => ({ register: mocks.register, markSent: mocks.markSent, recoverLink: mocks.recoverLink, view: mocks.view }),
  createStatusBatcher: () => ({ message: mocks.messageStatus }),
}));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.resetModules();
  mocks.register.mockResolvedValue({});
  mocks.markSent.mockResolvedValue({});
  mocks.recoverLink.mockResolvedValue({});
  mocks.view.mockResolvedValue({});
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
  document.body.innerHTML = "";
  await import("./content.js");
  await Promise.resolve();
  await Promise.resolve();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function compose() {
  const events: Record<string, (...args: any[]) => any> = {};
  const body = document.createElement("div");
  mocks.composeHandler.mock.calls[0][0]({
    addButton: vi.fn(), on: (name: string, fn: (...args: any[]) => any) => { events[name] = fn; },
    getToRecipients: () => [{ emailAddress: "ana@example.com" }],
    getCcRecipients: () => [], getBccRecipients: () => [],
    getBodyElement: () => body, getSubject: () => "Hello",
  });
  return { events, body };
}
const sent = () => ({ getMessageID: async () => "gm1", getThreadID: async () => "gt1" });

describe("compose linkage", () => {
  it("waits for registration before attaching Gmail IDs even when send completes first", async () => {
    let registered!: () => void;
    mocks.register.mockImplementation(() => new Promise<void>((resolve) => { registered = resolve; }));
    const { events } = compose();
    events.presending();
    const done = events.sent(sent());
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.markSent).not.toHaveBeenCalled();
    registered();
    await done;
    expect(mocks.markSent).toHaveBeenCalledWith(mocks.register.mock.calls[0][0].id, "gm1", "gt1");
  });

  it("keeps linkage independent of Gmail rewriting the pixel's DOM attributes", async () => {
    const { events, body } = compose();
    events.presending();
    body.querySelector("img")!.removeAttribute("data-omt");
    await events.sent(sent());
    expect(mocks.markSent).toHaveBeenCalledOnce();
  });

  it("handles rejected SDK ID lookups and retains the registered pixel for later recovery", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { events, body } = compose();
    events.presending();
    await expect(events.sent({ ...sent(), getThreadID: async () => { throw new Error("Gmail ID unavailable"); } })).resolves.toBeUndefined();
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.markSent).not.toHaveBeenCalled();
    expect(body.querySelector("img")).not.toBeNull();
    log.mockRestore();
  });

  it("does not attach IDs after a canceled send or failed registration", async () => {
    const { events, body } = compose();
    events.presending();
    events.sendCanceled();
    expect(body.querySelector("img")).toBeNull();
    await events.sent(sent());
    expect(mocks.markSent).not.toHaveBeenCalled();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.register.mockRejectedValueOnce(new Error("Offline"));
    events.presending();
    await events.sent(sent());
    expect(mocks.markSent).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("orphan recovery", () => {
  it("restores a missing link using the sent body's own pixel, then renders status", async () => {
    const summary = { opens: 1, firstOpenAt: 1_000_000, lastOpenAt: 1_000_000, openAts: [1_000_000], late: null };
    mocks.messageStatus.mockResolvedValueOnce(undefined).mockResolvedValue(summary);
    const wrapper = document.createElement("div");
    const body = document.createElement("div");
    body.innerHTML = '<img src="https://ci3.googleusercontent.com/meips/X#https://t.example.com/p/AAAAAAAAAAAAAAAAAAAAAA.gif">';
    wrapper.append(body);
    const listeners: Record<string, () => void> = {};
    await mocks.messageHandler.mock.calls[0][0]({
      getSender: () => ({ emailAddress: "me@example.com" }),
      getMessageIDAsync: async () => "gm1", getBodyElement: () => body, getElement: () => wrapper,
      isElementInQuotedArea: () => false,
      getThreadView: () => ({ getThreadIDAsync: async () => "gt1" }),
      on: (name: string, fn: () => void) => { listeners[name] = fn; }, off: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.recoverLink).toHaveBeenCalledWith("AAAAAAAAAAAAAAAAAAAAAA", "gm1", "gt1", "me@example.com");
    expect(wrapper.querySelector(".omt-status")?.textContent).toContain("Opened");
    listeners.destroy();
  });
});

describe("status line", () => {
  it("puts the line back when Gmail redraws the message, and keeps its open list showing", async () => {
    const summary = { opens: 2, firstOpenAt: 1_000_000, lastOpenAt: 2_000_000, openAts: [1_000_000, 2_000_000], late: null };
    mocks.messageStatus.mockResolvedValue(summary);
    const wrapper = document.createElement("div");
    let body = document.createElement("div");
    wrapper.append(body);
    const listeners: Record<string, () => void> = {};
    await mocks.messageHandler.mock.calls[0][0]({
      getSender: () => ({ emailAddress: "me@example.com" }),
      getMessageIDAsync: async () => "gm1", getBodyElement: () => body, getElement: () => wrapper,
      isElementInQuotedArea: () => false,
      on: (name: string, fn: () => void) => { listeners[name] = fn; }, off: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    wrapper.querySelector<HTMLButtonElement>(".omt-status-toggle")!.click();

    // Gmail replaces the markup around the body, dropping our line.
    body = document.createElement("div");
    wrapper.replaceChildren(body);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.previousElementSibling?.classList.contains("omt-status")).toBe(true);

    // The 30-second refresh redraws the line without collapsing the list.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wrapper.querySelectorAll(".omt-status")).toHaveLength(1);
    expect(wrapper.querySelector<HTMLUListElement>(".omt-status-list")!.hidden).toBe(false);
    listeners.destroy();
  });
});
