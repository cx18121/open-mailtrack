import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentPaths, readRows } from "./input.js";

describe("readRows", () => {
  it("reads csv with a bom and multiline bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-"));
    const file = join(dir, "c.csv");
    writeFileSync(file, '\uFEFFcontact_email,subject,body\na@x.com,Hi,"line1\nline2"\n');
    expect(await readRows(file)).toEqual([{ contact_email: "a@x.com", subject: "Hi", body: "line1\nline2" }]);
  });
});

describe("attachmentPaths", () => {
  it("lists visible files sorted, or nothing when the folder is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-"));
    writeFileSync(join(dir, "b.pdf"), "x");
    writeFileSync(join(dir, "a.pdf"), "x");
    writeFileSync(join(dir, ".DS_Store"), "x");
    expect(attachmentPaths(dir)).toEqual([join(dir, "a.pdf"), join(dir, "b.pdf")]);
    expect(attachmentPaths(join(dir, "missing"))).toEqual([]);
  });
});
