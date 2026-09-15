import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

export type Mail = {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  pixelUrl: string;
  attachments?: string[];
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function pixelTag(url: string) {
  return `<img src="${url}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`;
}

export function textToHtml(text: string) {
  const linked = escapeHtml(text).replace(
    /https?:\/\/[^\s<]+[^\s<.,;:!?)]/g,
    (u) => `<a href="${u}">${u}</a>`,
  );
  return linked.replace(/\r?\n/g, "<br>\n");
}

const encodeHeader = (v: string) =>
  /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`;

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64").replace(/(.{76})/g, "$1\r\n");

function alternative(mail: Mail): string[] {
  const boundary = `alt_${randomBytes(12).toString("hex")}`;
  const html = `<div>${textToHtml(mail.text)}</div>${pixelTag(mail.pixelUrl)}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(mail.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(html),
    `--${boundary}--`,
  ];
}

function mixed(mail: Mail, attachments: string[]): string[] {
  const boundary = `mix_${randomBytes(12).toString("hex")}`;
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...alternative(mail),
    ...attachments.flatMap((path) => [
      `--${boundary}`,
      `Content-Type: application/octet-stream; name="${basename(path)}"`,
      `Content-Disposition: attachment; filename="${basename(path)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64(readFileSync(path)),
    ]),
    `--${boundary}--`,
  ];
}

export function buildRaw(mail: Mail): string {
  const headers = [
    "MIME-Version: 1.0",
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
  ];
  const body = mail.attachments?.length ? mixed(mail, mail.attachments) : alternative(mail);
  return Buffer.from([...headers, ...body, ""].join("\r\n")).toString("base64url");
}
