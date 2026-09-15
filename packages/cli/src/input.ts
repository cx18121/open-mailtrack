import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse } from "csv-parse/sync";
import { readSheet } from "read-excel-file/node";

export type Row = Record<string, string>;

export async function readRows(file: string): Promise<Row[]> {
  if ([".xlsx", ".xls"].includes(extname(file).toLowerCase())) {
    const [header, ...rows] = await readSheet(file);
    const keys = header.map((h) => String(h ?? "").trim());
    return rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] == null ? "" : String(r[i])])));
  }
  return parse(readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, bom: true }) as Row[];
}

/** Every file in ./files is attached to every email, matching mass-sender. */
export function attachmentPaths(dir = "files"): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .sort()
    .map((f) => join(dir, f));
}
