#!/usr/bin/env node
/**
 * Unit tests for pure functions in search.mjs — no network, no engine calls.
 * Run: node --input-type=module tests/unit.mjs  (or just: node tests/unit.mjs)
 * Exit 0 = all pass, 1 = any failure.
 */
import { routeAuto, looksLikeJunk, normalizeUrl, extractIntlQuery, searxngBaseAndAuth } from "../scripts/search.mjs";

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${name}`); }
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL: ${name}\n  got:  ${g}\n  want: ${w}`); }
}

// ── routeAuto ──
eq("routeAuto: github signal", routeAuto("github 教程").engines, ["github"]);
eq("routeAuto: 学术四件套", routeAuto("论文 写作").engines, ["arxiv", "openalex", "crossref", "pubmed"]);
eq("routeAuto: 什么是→wikipedia", routeAuto("什么是 webgpu").engines, ["wikipedia"]);
eq("routeAuto: 掘金+csdn", routeAuto("掘金 教程").engines, ["juejin", "csdn"]);
eq("routeAuto: huggingface", routeAuto("数据集 下载").engines, ["huggingface"]);
eq("routeAuto: 无匹配→空", routeAuto("今天天气").engines, []);
eq("routeAuto: 空查询→空", routeAuto("").engines, []);

// ── looksLikeJunk ──
const junk = [
  { title: "Google", url: "https://www.google.com/" },
  { title: "Google", url: "https://www.google.com.hk/" },
  { title: "Google", url: "https://google.cn/" },
];
const good = [
  { title: "WebGPU API - MDN", url: "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API", snippet: "WebGPU API reference" },
  { title: "Learn WebGPU", url: "https://webgpufundamentals.org/", snippet: "WebGPU tutorial" },
];
ok("junk: 单域 SERP", looksLikeJunk(junk, "webgpu") === true);
ok("junk: 零词重叠", looksLikeJunk([
  { title: "灌注", url: "https://baike.baidu.com/item/1" },
  { title: "首页", url: "https://example.com/" },
], "webgpu") === true);
ok("junk: 正常结果不误伤", looksLikeJunk(good, "webgpu") === false);
ok("junk: 少于2条不判", looksLikeJunk(good.slice(0, 1), "webgpu") === false);

// ── normalizeUrl ──
eq("normalize: 去 utm", normalizeUrl("https://example.com/page?utm_source=x&id=1"), "https://example.com/page?id=1");
eq("normalize: 去 fbclid", normalizeUrl("https://example.com/?fbclid=abc"), "https://example.com");
eq("normalize: 去 hash", normalizeUrl("https://example.com/a#section"), "https://example.com/a");
eq("normalize: 去尾斜杠", normalizeUrl("https://example.com/"), "https://example.com");
eq("normalize: 保留合法参数", normalizeUrl("https://example.com/search?q=test&page=2"), "https://example.com/search?q=test&page=2");

// ── extractIntlQuery ──
eq("intl: 英文优先", extractIntlQuery("webgpu 是什么"), "webgpu");
eq("intl: 长词优先", extractIntlQuery("use webgpu for game development"), "use webgpu for game development");
eq("intl: 纯中文回退原文", extractIntlQuery("机器学习 入门"), "机器学习 入门");

// ── searxngBaseAndAuth ──
const sa = searxngBaseAndAuth("https://user:pass@searx.example.com");
eq("searxng auth: base", sa.base, "https://searx.example.com");
eq("searxng auth: header", sa.authorization, "Basic dXNlcjpwYXNz");
const sa2 = searxngBaseAndAuth("http://1.2.3.4:8080");
eq("searxng noauth: base", sa2.base, "http://1.2.3.4:8080");
eq("searxng noauth: header空", sa2.authorization, "");

// ── summary ──
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
