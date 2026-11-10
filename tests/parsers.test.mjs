#!/usr/bin/env node
/**
 * Parser snapshot tests — feed trimmed real markup (tests/snapshots/) to each
 * SERP parser. This exact assertion matrix also runs on the python twin
 * (tests/parsers_test.py) — keep the two files in lockstep (see parity note
 * in tests/parity.sh). Network-free.
 * Run: node tests/parsers.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseDdgHtml, parseDdgLite, parseBingResults, parseBingRss,
  parseBaiduResults, parseSo360Desktop, parseSo360Mobile, parseBingNewsRss,
} from "../scripts/search.mjs";

const SNAP = join(dirname(fileURLToPath(import.meta.url)), "snapshots");
const snap = (f) => readFileSync(join(SNAP, f), "utf8");
const ctx = { n: 10 };

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL: ${name}\n  got:  ${g}\n  want: ${w}`); }
}
function throws(name, fn, msgPart) {
  try { fn(); fail++; console.error(`FAIL: ${name} (did not throw)`); }
  catch (e) { e.message.includes(msgPart) ? pass++ : (fail++, console.error(`FAIL: ${name} (wrong error: ${e.message})`)); }
}

// ── ddg html UI ──
{
  const r = parseDdgHtml(ctx, snap("ddg-html.html"));
  eq("ddg-html: count", r.length, 2);
  eq("ddg-html: uddg decoded", r[0].url, "https://developer.mozilla.org/en-US/docs/WebGPU_API");
  eq("ddg-html: title", r[0].title, "WebGPU API - MDN");
  eq("ddg-html: snippet", r[0].snippet, "WebGPU API reference docs for the web platform.");
  eq("ddg-html: direct href kept", r[1].url, "https://direct.example.com/page");
}
// ── ddg lite UI ──
{
  const r = parseDdgLite(ctx, snap("ddg-lite.html"));
  eq("ddg-lite: count", r.length, 2);
  eq("ddg-lite: uddg decoded (single quotes, href-before-class)", r[0].url, "https://learn.microsoft.com/en-us/windows/wsl/install");
  eq("ddg-lite: title", r[0].title, "Install WSL | Microsoft Learn");
  eq("ddg-lite: snippet from <td>", r[0].snippet, "Install Windows Subsystem for Linux with the command, wsl --install.");
  eq("ddg-lite: direct href kept", r[1].url, "https://direct.example.com/page");
}
// ── bing b_algo ──
{
  const r = parseBingResults(ctx, snap("bing-balgo.html"));
  eq("bing: count", r.length, 2);
  eq("bing: /ck/a base64 decoded", r[0].url, "https://developer.mozilla.org/en-US/docs/WebGPU_API");
  eq("bing: title", r[0].title, "WebGPU API - MDN");
  eq("bing: snippet", r[0].snippet, "WebGPU API reference docs.");
  eq("bing: direct href kept", r[1].url, "https://direct.example.com/page");
}
// ── bing RSS ──
{
  const r = parseBingRss(ctx, snap("bing-rss.xml"));
  eq("bing-rss: count", r.length, 2);
  eq("bing-rss: link is direct", r[0].url, "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API");
  eq("bing-rss: CDATA title", r[0].title, "WebGPU API - MDN");
  eq("bing-rss: CDATA desc stripped", r[0].snippet, "WebGPU API reference docs.");
  eq("bing-rss: entity desc decoded", r[1].snippet, "WebGPU tutorial & samples");
}
// ── baidu desktop ──
{
  const r = parseBaiduResults(ctx, snap("baidu-desktop.html"));
  eq("baidu: count", r.length, 2);
  eq("baidu: /link wrapper kept (resolved later)", r[0].url, "http://www.baidu.com/link?url=abc123def");
  eq("baidu: title", r[0].title, "Example - Baidu wrapper result");
  eq("baidu: non-http href skipped", r[1].url, "https://docs.example.com/guide");
}
// ── so360 desktop ──
{
  const r = parseSo360Desktop(ctx, snap("so360-desktop.html"));
  eq("so360-desktop: count", r.length, 2);
  eq("so360-desktop: /link?m wrapper kept", r[0].url, "https://www.so.com/link?m=abc123");
  eq("so360-desktop: title", r[0].title, "First 360 Result");
  eq("so360-desktop: res-desc snippet", r[0].snippet, "First description here.");
}
// ── so360 mobile ──
{
  const r = parseSo360Mobile(ctx, snap("so360-mobile.html"));
  eq("so360-mobile: count", r.length, 2);
  eq("so360-mobile: jump?u decoded (card 1)", r[0].url, "https://study.example.com/course/1");
  eq("so360-mobile: <em> title stripped", r[0].title, "react hooks 全套教程");
  eq("so360-mobile: g-main summary snippet", r[0].snippet, "这个课程主要教大家掌握 react hooks");
  eq("so360-mobile: jump?u decoded (card 2)", r[1].url, "https://second.example.com/video/42");
}
// ── bing news RSS ──
{
  const r = parseBingNewsRss(ctx, snap("bing-news-rss.xml"));
  eq("bing-news: count", r.length, 2);
  eq("bing-news: url= param extracted + decoded", r[0].url, "https://www.msn.cn/zh-cn/技术/nvidia-rtx-5090");
  eq("bing-news: CDATA title", r[0].title, "Nvidia 否认 RTX 5090 显卡停产");
  eq("bing-news: News:Source + pubDate snippet", r[0].snippet, "快科技 on MSN · Tue, 09 Nov 2026 08:00:00 GMT");
  eq("bing-news: plain item url", r[1].url, "https://www.investors.com/news/technology/nvidia-stock/");
}
// ── empty pages fail with the canonical error ──
throws("ddg-html: empty body", () => parseDdgHtml(ctx, "<div></div>"), "no results parsed");
throws("bing: empty body", () => parseBingResults(ctx, "<ol></ol>"), "no results parsed");
throws("so360-mobile: empty body", () => parseSo360Mobile(ctx, "<div></div>"), "no results parsed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
