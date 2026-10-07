import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@inboxsdk/core/background.js", () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function background(settings: Record<string, string>) {
  const onInstalled = vi.fn();
  const updateDynamicRules = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", {
    runtime: { onInstalled: { addListener: onInstalled } },
    storage: { sync: { get: vi.fn().mockResolvedValue(settings) } },
    declarativeNetRequest: { updateDynamicRules },
  });
  await import("./background.js");
  return { installed: onInstalled.mock.calls[0][0] as () => Promise<void>, updateDynamicRules };
}

describe("pixel blocking on extension installation or update", () => {
  it("replaces the persisted rule using existing settings without saving options again", async () => {
    const { installed, updateDynamicRules } = await background({ serverUrl: "https://t.example.com", apiKey: "test" });
    await installed();
    expect(updateDynamicRules).toHaveBeenCalledExactlyOnceWith({
      removeRuleIds: [1],
      addRules: [expect.objectContaining({ id: 1, action: { type: "block" }, condition: expect.objectContaining({ regexFilter: expect.any(String) }) })],
    });
  });

  it("does not install a rule before configuration", async () => {
    const { installed, updateDynamicRules } = await background({});
    await installed();
    expect(updateDynamicRules).not.toHaveBeenCalled();
  });
});
