import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  composeHandler: vi.fn(),
  messageHandler: vi.fn(),
  rowHandler: vi.fn(),
  accounts: vi.fn(),
  enqueueOutbox: vi.fn(),
  cancelOutbox: vi.fn(),
  recoverLink: vi.fn(),
  view: vi.fn(),
  messageStatus: vi.fn(),
  showMessage: vi.fn(),
  hideGmailMessage: vi.fn(),
  openDraftByMessageID: vi.fn(),
  showModalView: vi.fn(),
}));

vi.mock("@inboxsdk/core", () => ({
  load: async () => ({
    User: { getEmailAddress: () => "me@cornell.edu" },
    Compose: {
      registerComposeViewHandler: mocks.composeHandler,
      openDraftByMessageID: mocks.openDraftByMessageID,
    },
    Conversations: { registerMessageViewHandler: mocks.messageHandler },
    Lists: { registerThreadRowViewHandler: mocks.rowHandler },
    Router: { handleCustomRoute: vi.fn(), goto: vi.fn().mockResolvedValue(undefined) },
    Search: { registerSearchQueryRewriter: vi.fn() },
    NavMenu: { addNavItem: vi.fn() },
    ButterBar: { showMessage: mocks.showMessage, hideGmailMessage: mocks.hideGmailMessage },
    Widgets: { showModalView: mocks.showModalView },
  }),
}));
vi.mock("./settings.js", () => ({
  loadSettings: async () => ({ serverUrl: "https://t.example.com", apiKey: "k", undoDelaySec: 5 }),
}));
vi.mock("./api.js", () => ({
  createApi: () => ({
    accounts: mocks.accounts,
    enqueueOutbox: mocks.enqueueOutbox,
    cancelOutbox: mocks.cancelOutbox,
    recoverLink: mocks.recoverLink,
    view: mocks.view,
  }),
  createStatusBatcher: () => ({ message: mocks.messageStatus }),
}));

async function boot(connected = true) {
  vi.resetModules();
  mocks.accounts.mockResolvedValue({
    accounts: connected ? [{ email: "me@cornell.edu", authType: "oauth", displayName: "Me", connectedAt: 1, updatedAt: 1 }] : [],
    hasServerGoogleClient: false,
  });
  await import("./content.js");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.enqueueOutbox.mockResolvedValue({ outboxId: "ob1", messageId: "m1", sendAt: Date.now() + 5000, status: "queued" });
  mocks.cancelOutbox.mockResolvedValue({ canceled: true, draftId: "d1", draftMessageId: "dm1" });
  mocks.recoverLink.mockResolvedValue({});
  mocks.view.mockResolvedValue({});
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path, sendMessage: vi.fn() } });
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeCompose(opts: { to?: string[]; cc?: string[]; bcc?: string[]; isReply?: boolean; threadId?: string | null } = {}) {
  const events: Record<string, (...args: any[]) => any> = {};
  const body = document.createElement("div");
  body.innerHTML = "<p>Hello group</p>";
  const close = vi.fn();
  const to = (opts.to ?? ["ana@example.com"]).map((emailAddress) => ({ emailAddress }));
  const cc = (opts.cc ?? []).map((emailAddress) => ({ emailAddress }));
  const bcc = (opts.bcc ?? []).map((emailAddress) => ({ emailAddress }));
  const isReply = opts.isReply ?? true;
  const threadId = opts.threadId !== undefined ? opts.threadId : "gt1";

  mocks.composeHandler.mock.calls[0][0]({
    addButton: vi.fn(),
    addComposeNotice: vi.fn(() => ({ el: document.createElement("div") })),
    on: (name: string, fn: (...args: any[]) => any) => {
      events[name] = fn;
    },
    getToRecipients: () => to,
    getCcRecipients: () => cc,
    getBccRecipients: () => bcc,
    getFromContact: () => ({ name: "Charlie", emailAddress: "me@cornell.edu" }),
    getBodyElement: () => body,
    getHTMLContent: () => body.innerHTML,
    getSubject: () => "Hello",
    isReply: () => isReply,
    getThreadID: () => threadId,
    getCurrentDraftID: async () => "draft-123",
    getInitialMessageID: () => "dmsg-orig",
    getMessageID: () => {
      throw new Error("This method was discontinued after API version 1");
    },
    close,
  });
  return { events, body, close };
}

describe("unified outbox send", () => {
  it("intercepts presending on connected accounts, enqueues with Undo Send, and restores draft on Undo", async () => {
    await boot(true);
    const { events, close } = makeCompose({ to: ["ana@example.com"], cc: ["bob@example.com"] });
    const cancel = vi.fn();
    events.presending({ cancel });
    expect(cancel).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.enqueueOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: "me@cornell.edu",
        to: ["ana@example.com"],
        cc: ["bob@example.com"],
        subject: "Hello",
        html: "<p>Hello group</p>",
        threadId: "gt1",
        draftId: "draft-123",
        undoDelayMs: 5000,
      }),
    );
    expect(close).toHaveBeenCalledOnce();

    // Trigger Undo button from ButterBar
    const butterCall = mocks.showMessage.mock.calls[0][0];
    expect(butterCall.buttons[0].title).toBe("Undo");
    butterCall.buttons[0].onClick();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.cancelOutbox).toHaveBeenCalledWith("ob1", true);
    expect(mocks.openDraftByMessageID).toHaveBeenCalledWith("dm1");
  });

  it("fails closed and keeps compose open when server enqueue fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await boot(true);
    mocks.enqueueOutbox.mockRejectedValueOnce(new Error("Tunnel offline"));
    const { events, close } = makeCompose();
    const cancel = vi.fn();
    events.presending({ cancel });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(mocks.showMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("still open") }));
    log.mockRestore();
  });

  it("enforces the 25-recipient cap and keeps compose open", async () => {
    await boot(true);
    const many = Array.from({ length: 26 }, (_, i) => `u${i}@example.com`);
    const { events, close } = makeCompose({ to: many });
    const cancel = vi.fn();
    events.presending({ cancel });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(mocks.showMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("25") }));
  });

  it("sends natively and untracked on confirmed unconnected accounts", async () => {
    await boot(false);
    const { events } = makeCompose();
    const cancel = vi.fn();
    events.presending({ cancel });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).not.toHaveBeenCalled();
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("fails closed when initial account lookup fails on cold start", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.resetModules();
    mocks.accounts.mockRejectedValue(new Error("Server unreachable"));
    await import("./content.js");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const { events, close } = makeCompose();
    const cancel = vi.fn();
    events.presending({ cancel });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(mocks.enqueueOutbox).not.toHaveBeenCalled();
    expect(mocks.showMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("still open") }));
    log.mockRestore();
  });
});

describe("orphan recovery", () => {
  it("restores a missing link for legacy messages using the sent body's own pixel, then renders status", async () => {
    await boot(true);
    const summary = { opens: 1, firstOpenAt: 1_000_000, lastOpenAt: 1_000_000, openAts: [1_000_000], late: null };
    mocks.messageStatus.mockResolvedValueOnce(undefined).mockResolvedValue(summary);
    const wrapper = document.createElement("div");
    const body = document.createElement("div");
    body.innerHTML = '<img src="https://ci3.googleusercontent.com/meips/X#https://t.example.com/p/AAAAAAAAAAAAAAAAAAAAAA.gif">';
    wrapper.append(body);
    const listeners: Record<string, () => void> = {};
    await mocks.messageHandler.mock.calls[0][0]({
      getSender: () => ({ emailAddress: "me@cornell.edu" }),
      getMessageIDAsync: async () => "gm1",
      getBodyElement: () => body,
      getElement: () => wrapper,
      isElementInQuotedArea: () => false,
      getThreadView: () => ({ getThreadIDAsync: async () => "gt1" }),
      on: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      off: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.recoverLink).toHaveBeenCalledWith("AAAAAAAAAAAAAAAAAAAAAA", "gm1", "gt1", "me@cornell.edu");
    expect(wrapper.querySelector(".omt-status")?.textContent).toContain("Opened");
    listeners.destroy();
  });
});

describe("status line", () => {
  it("puts the line back when Gmail redraws the message, and keeps its open list showing", async () => {
    await boot(true);
    const summary = { opens: 2, firstOpenAt: 1_000_000, lastOpenAt: 2_000_000, openAts: [1_000_000, 2_000_000], late: null };
    mocks.messageStatus.mockResolvedValue(summary);
    const wrapper = document.createElement("div");
    let body = document.createElement("div");
    wrapper.append(body);
    const listeners: Record<string, () => void> = {};
    await mocks.messageHandler.mock.calls[0][0]({
      getSender: () => ({ emailAddress: "me@cornell.edu" }),
      getMessageIDAsync: async () => "gm1",
      getBodyElement: () => body,
      getElement: () => wrapper,
      isElementInQuotedArea: () => false,
      on: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      off: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    wrapper.querySelector<HTMLButtonElement>(".omt-status-toggle")!.click();

    body = document.createElement("div");
    wrapper.replaceChildren(body);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.previousElementSibling?.classList.contains("omt-status")).toBe(true);
    expect(wrapper.querySelector<HTMLUListElement>(".omt-status-list")!.hidden).toBe(false);
    listeners.destroy();
  });
});

describe("conditional schedule send", () => {
  it("shows Cancel automatically if they reply on reply compose windows and hides it on new emails", async () => {
    await boot(true);
    let capturedModal: { el: HTMLElement; buttons: { text: string; onClick: () => void }[] } | null = null;
    mocks.showModalView.mockImplementation((opts) => {
      capturedModal = opts;
      return { close: vi.fn() };
    });

    // Reply compose -> shows checkbox and passes cancelOnReply: true when checked
    const reply = makeCompose({ isReply: true, threadId: "gt1" });
    reply.events.scheduleSendMenuOpening({ cancel: vi.fn() });
    const check = capturedModal!.el.querySelector<HTMLInputElement>('.omt-schedule-check input[type="checkbox"]');
    expect(check).not.toBeNull();
    expect(check!.checked).toBe(false);
    check!.checked = true;
    capturedModal!.el.querySelector<HTMLButtonElement>(".omt-schedule-preset")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.enqueueOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ isScheduled: true, cancelOnReply: true, threadId: "gt1" }),
    );

    // Brand-new compose -> no checkbox
    capturedModal = null;
    const fresh = makeCompose({ isReply: false, threadId: "ephemeral-draft-thread" });
    fresh.events.scheduleSendMenuOpening({ cancel: vi.fn() });
    expect(capturedModal!.el.querySelector(".omt-schedule-check")).toBeNull();
  });

  it("suppresses Gmail's Draft discarded toast after sending an inline reply and re-shows Sending message", async () => {
    await boot(true);
    const discard = vi.fn();
    const events: Record<string, (...args: any[]) => any> = {};
    const body = document.createElement("div");
    body.innerHTML = "<p>Reply text</p>";
    mocks.composeHandler.mock.calls[0][0]({
      addButton: vi.fn(),
      addComposeNotice: vi.fn(() => ({ el: document.createElement("div") })),
      on: (name: string, fn: (...args: any[]) => any) => {
        events[name] = fn;
      },
      getToRecipients: () => [{ emailAddress: "ana@example.com" }],
      getCcRecipients: () => [],
      getBccRecipients: () => [],
      getFromContact: () => ({ name: "Charlie", emailAddress: "me@cornell.edu" }),
      getBodyElement: () => body,
      getHTMLContent: () => body.innerHTML,
      getSubject: () => "Re: Offer",
      isReply: () => true,
      isInlineReplyForm: () => true,
      getThreadID: () => "gt1",
      getCurrentDraftID: async () => "draft-123",
      getInitialMessageID: () => "dmsg-orig",
      discard,
      close: vi.fn(),
    });

    events.presending({ cancel: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(discard).toHaveBeenCalledOnce();
    const initialCalls = mocks.showMessage.mock.calls.length;

    // Simulate Gmail popping up its native "Draft discarded. Undo" toast 200ms later
    const alert = document.createElement("div");
    alert.setAttribute("role", "alert");
    alert.textContent = "Draft discarded. Undo";
    document.body.append(alert);
    await vi.advanceTimersByTimeAsync(60);

    expect(mocks.hideGmailMessage).toHaveBeenCalled();
    expect(mocks.showMessage.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(mocks.showMessage.mock.calls.at(-1)?.[0]).toMatchObject({ text: "Sending message…" });
  });
});
