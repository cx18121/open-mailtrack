import { randomBytes } from "node:crypto";

export type Mail = {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  pixelUrl: string;
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

export function buildRaw(mail: Mail): string {
  const boundary = `alt_${randomBytes(12).toString("hex")}`;
  const html = `<div>${textToHtml(mail.text)}</div>${pixelTag(mail.pixelUrl)}`;
  const lines = [
    "MIME-Version: 1.0",
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    ...(mail.cc ? [`Cc: ${mail.cc}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.text).toString("base64"),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
    `--${boundary}--`,
    "",
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}
