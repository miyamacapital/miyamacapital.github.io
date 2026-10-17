// Runs Code.gs under Node with in-memory stand-ins for the Apps Script services.
// Usage: node tools/apps-script/test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ---- Apps Script stand-ins ---------------------------------------------------
function makeSheet(name) {
  const rows = [];
  const sheet = {
    getName: () => name,
    appendRow: (r) => { rows.push(r.slice()); },
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getLastRow: () => rows.length,
    getMaxRows: () => 1000,
    deleteRow: (row) => { rows.splice(row - 1, 1); },
    getRange: (row, col, numRows = 1, numCols = 1) => ({
      setValues: (vals) => {
        for (let i = 0; i < numRows; i++) {
          while (rows.length < row + i) rows.push([]);
          for (let j = 0; j < numCols; j++) rows[row - 1 + i][col - 1 + j] = vals[i][j];
        }
      },
      setValue: (v) => { while (rows.length < row) rows.push([]); rows[row - 1][col - 1] = v; },
      getValues: () => Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => (rows[row - 1 + i] || [])[col - 1 + j] ?? "")),
      getValue: () => (rows[row - 1] || [])[col - 1] ?? "",
      setNumberFormat: () => {},
      getRow: () => row,
    }),
    setFrozenRows: () => {},
    _rows: rows,
  };
  return sheet;
}

function makeEnv() {
  const sheets = {};
  const mails = [];
  const props = { SPREADSHEET_ID: "test-spreadsheet", POSTAL_ADDRESS: "1 Test St, San Francisco, CA 94105", REPORTS_FOLDER_ID: "folder123", WEB_APP_URL: "https://script.google.com/macros/s/TEST/exec" };
  let quota = 1500;
  let activeSheet = null;
  let sendError = null;
  let lockDepth = 0;
  const ss = {
    getId: () => "test-spreadsheet",
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
    getActiveSheet: () => activeSheet,
  };
  const env = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: (id) => { assert.strictEqual(id, "test-spreadsheet"); return ss; },
      getUi: () => ({ alert: () => "OK", createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }), ButtonSet: { OK_CANCEL: 1 }, Button: { OK: "OK" } }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    ScriptApp: { getService: () => ({ getUrl: () => "https://script.google.com/macros/s/TEST/dev" }) },
    LockService: { getScriptLock: () => ({ waitLock() { lockDepth++; }, releaseLock() { lockDepth--; } }) },
    Utilities: { getUuid: () => { let s = ""; for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16); return s.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"); } },
    GmailApp: { sendEmail: (to, subject, body, options) => { if (sendError) throw sendError; mails.push({ to, subject, body, options }); }, getAliases: () => ["connect@miyamacap.com"] },
    MailApp: { getRemainingDailyQuota: () => quota },
    DriveApp: { getFolderById: () => ({ getFilesByName: (n) => { const list = n === "report.pdf" ? [{ getBlob: () => ({ name: n }) }] : []; let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@miyamacap.com" }) },
    ContentService: { createTextOutput: (s) => ({ _text: s, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
    HtmlService: { createHtmlOutput: (h) => ({ _html: h, setTitle() { return this; } }) },
    Logger: { log: () => {} },
    console, Date, JSON, Math, Object, String, Number, Array, Error, encodeURIComponent,
    _sheets: sheets, _mails: mails, _props: props,
    _setQuota: (q) => { quota = q; },
    _setSendError: (e) => { sendError = e; },
    _lockDepth: () => lockDepth,
    _select: (sheetName, row) => { activeSheet = Object.assign({}, sheets[sheetName], { getActiveRange: () => ({ getRow: () => row }) }); },
  };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8"), env, { filename: "Code.gs" });
  return env;
}

const jsonPost = (data) => ({ postData: { type: "text/plain", contents: JSON.stringify(data) }, parameter: {} });
const formPost = (data) => ({ postData: { type: "application/x-www-form-urlencoded", contents: "x" }, parameter: data });
const out = (o) => JSON.parse(o._text);
const subs = (env) => (env._sheets.Subscribers ? env._sheets.Subscribers._rows.slice(1) : []);
const logs = (env) => (env._sheets.Log ? env._sheets.Log._rows.slice(1) : []);
const good = () => ({ email: "Ann@Example.com", name: "Ann Lee", org: "ACME", lang: "zh", consent: "on", elapsed: "8000", source: "/zh/" });
const col = (name) => ["email", "name", "org", "lang", "status", "confirm_token", "confirm_expires", "unsub_token", "created_at", "confirmed_at", "unsubscribed_at", "last_sent_at", "source", "consent", "history"].indexOf(name);
const confirmOf = (env, i = 0) => env.doGet({ parameter: { action: "confirm", t: subs(env)[i][col("confirm_token")] } });

// ---- Scenarios ---------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("helpers: email whitelist, keys, text, link detection, formula guard, lang, js string", (env) => {
  assert.strictEqual(env.normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
  assert.strictEqual(env.normalizeEmail("foo@bar"), "");
  assert.strictEqual(env.normalizeEmail("a..b@x.io"), "");
  assert.strictEqual(env.normalizeEmail('=IMPORTXML("http://evil.tld")&"@x.io"'), "");
  assert.strictEqual(env.normalizeEmail("a'b@x.io"), "");
  assert.strictEqual(env.normalizeEmail("first.last+tag@sub.example.co.uk"), "first.last+tag@sub.example.co.uk");
  assert.strictEqual(env.normalizeEmail("x".repeat(260) + "@a.io"), "");
  assert.strictEqual(env.emailKey("A.B+news@Gmail.com"), "ab@gmail.com");
  assert.strictEqual(env.emailKey("a.b+news@example.com"), "a.b@example.com");
  assert.strictEqual(env.cleanText(" a\u0000b\n c ", 10), "a b c");
  assert.strictEqual(env.looksLikeLink("Dr. Smith"), false);
  assert.strictEqual(env.looksLikeLink("J.R. Smith"), false);
  assert.strictEqual(env.looksLikeLink("claim prize at example.com"), true);
  assert.strictEqual(env.looksLikeLink("https://x.y"), true);
  assert.strictEqual(env.looksLikeLink("www.evil"), true);
  assert.strictEqual(env.cellSafe("=HYPERLINK()"), "'=HYPERLINK()");
  assert.strictEqual(env.cellSafe("plain"), "plain");
  assert.strictEqual(env.displayName({ name: "'=x" }), "=x");
  assert.strictEqual(env.displayName({ name: "'O'Brien" }), "'O'Brien");
  assert.strictEqual(env.normalizeLang("jp"), "ja");
  assert.strictEqual(env.normalizeLang("zh-Hant"), "zh");
  assert.strictEqual(env.normalizeLang("fr"), "en");
  assert.strictEqual(env.jsString("</script><b>&"), '"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"');
  assert.strictEqual(env.getWebAppUrl(), "https://script.google.com/macros/s/TEST/exec");
});

test("subscribe: pending row + confirmation email with token link", (env) => {
  assert.deepStrictEqual(out(env.doPost(jsonPost(good()))), { ok: true, state: "check" });
  const rows = subs(env);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r[col("email")], "ann@example.com");
  assert.strictEqual(r[col("name")], "Ann Lee");
  assert.strictEqual(r[col("lang")], "zh");
  assert.strictEqual(r[col("status")], "pending");
  assert.strictEqual(r[col("confirm_token")].length, 64);
  assert.strictEqual(r[col("unsub_token")].length, 64);
  assert.ok(r[col("confirm_expires")] > Date.now());
  assert.strictEqual(env._mails.length, 1);
  const m = env._mails[0];
  assert.strictEqual(m.to, "ann@example.com");
  assert.ok(m.subject.indexOf("確認") >= 0);
  assert.ok(m.body.indexOf("/exec?action=confirm&t=" + r[col("confirm_token")]) >= 0);
  assert.ok(m.body.indexOf("/exec?action=unsubscribe&t=" + r[col("unsub_token")]) >= 0);
  assert.ok(m.options.htmlBody.indexOf("action=unsubscribe&amp;t=" + r[col("unsub_token")]) >= 0);
  assert.ok(m.options.htmlBody.indexOf("1 Test St") >= 0);
  assert.strictEqual(m.options.from, undefined);
});

test("subscribe: validation errors", (env) => {
  assert.strictEqual(out(env.doPost(jsonPost(Object.assign(good(), { email: "nope" })))).error, "invalid_email");
  assert.strictEqual(out(env.doPost(jsonPost(Object.assign(good(), { name: "  " })))).error, "name_required");
  assert.strictEqual(out(env.doPost(jsonPost(Object.assign(good(), { name: "Win now at evil.com" })))).error, "name_invalid");
  assert.strictEqual(out(env.doPost(jsonPost(Object.assign(good(), { consent: "" })))).error, "consent_required");
  assert.strictEqual(subs(env).length, 0);
  assert.strictEqual(env._mails.length, 0);
});

test("subscribe: honeypot and too-fast JS submissions are swallowed silently and logged without the email", (env) => {
  assert.deepStrictEqual(out(env.doPost(jsonPost(Object.assign(good(), { ref_code: "http://spam" })))), { ok: true, state: "check" });
  assert.deepStrictEqual(out(env.doPost(jsonPost(Object.assign(good(), { elapsed: "500" })))), { ok: true, state: "check" });
  assert.deepStrictEqual(out(env.doPost(jsonPost(Object.assign(good(), { elapsed: "" })))), { ok: true, state: "check" });
  assert.strictEqual(subs(env).length, 0);
  assert.strictEqual(env._mails.length, 0);
  assert.deepStrictEqual(logs(env).map((l) => [l[2], l[3], l[4]]), [["", "dropped", "honeypot"], ["", "dropped", "too_fast"], ["", "dropped", "too_fast"]]);
});

test("subscribe: plain form post without JS has no elapsed and is accepted", (env) => {
  const data = Object.assign(good(), { lang: "ja" }); delete data.elapsed;
  const page = env.doPost(formPost(data));
  assert.ok(page._html.indexOf("/jp/subscribed.html?s=check") >= 0);
  assert.ok(page._html.indexOf('target="_top"') >= 0 && page._html.indexOf("window.open(") >= 0);
  assert.strictEqual(subs(env).length, 1);
  assert.strictEqual(subs(env)[0][col("lang")], "ja");
  assert.strictEqual(env._mails.length, 1);
  const bad = env.doPost(formPost({ email: "x", name: "y", consent: "on", lang: "en" }));
  assert.ok(bad._html.indexOf("/en/subscribed.html?s=invalid_email") >= 0);
});

test("subscribe: formula-looking input is stored literally and HTML in name is escaped in mail", (env) => {
  env.doPost(jsonPost(Object.assign(good(), { name: "=cmd|' /C calc'!A0", org: "@acme" })));
  assert.strictEqual(subs(env)[0][col("name")], "'=cmd|' /C calc'!A0");
  assert.strictEqual(subs(env)[0][col("org")], "'@acme");
  env.doPost(jsonPost(Object.assign(good(), { email: "b@x.io", name: "<img src=x onerror=alert(1)>" })));
  const html = env._mails[1].options.htmlBody;
  assert.ok(html.indexOf("<img") < 0 && html.indexOf("&lt;img") >= 0);
});

test("subscribe: per-mailbox cooldown covers +tags and Gmail dots; expires after an hour", (env) => {
  env.doPost(jsonPost(Object.assign(good(), { email: "a.b@gmail.com" })));
  env.doPost(jsonPost(Object.assign(good(), { email: "ab+x@gmail.com" })));
  env.doPost(jsonPost(Object.assign(good(), { email: "A.B+y@googlemail.com" })));
  assert.strictEqual(subs(env).length, 1);
  assert.strictEqual(env._mails.length, 1);
  assert.strictEqual(logs(env).filter((l) => l[4] === "cooldown").length, 2);
  subs(env)[0][col("last_sent_at")] = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  env.doPost(jsonPost(Object.assign(good(), { email: "a.b@gmail.com" })));
  assert.strictEqual(subs(env).length, 1);
  assert.strictEqual(env._mails.length, 2);
});

test("subscribe: confirmed address gets at most one 'already' mail per cooldown, no new row", (env) => {
  env.doPost(jsonPost(good()));
  confirmOf(env);
  const before = env._mails.length;
  env.doPost(jsonPost(good()));
  assert.strictEqual(env._mails.length, before, "still inside the cooldown from the confirmation mail");
  subs(env)[0][col("last_sent_at")] = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  env.doPost(jsonPost(good()));
  env.doPost(jsonPost(good()));
  assert.strictEqual(subs(env).length, 1);
  assert.strictEqual(env._mails.length, before + 1);
  assert.ok(env._mails[before].subject.indexOf("已訂閱") >= 0);
  assert.strictEqual(subs(env)[0][col("status")], "confirmed");
});

test("subscribe: global throttle and mail quota stop confirmation mails", (env) => {
  env.CONFIG.THROTTLE.per10min = 2;
  env.doPost(jsonPost(Object.assign(good(), { email: "a@x.io" })));
  env.doPost(jsonPost(Object.assign(good(), { email: "b@x.io" })));
  assert.deepStrictEqual(out(env.doPost(jsonPost(Object.assign(good(), { email: "c@x.io" })))), { ok: true, state: "check" });
  assert.strictEqual(subs(env).length, 2);
  assert.strictEqual(env._mails.length, 2);
  assert.ok(logs(env).some((l) => l[4] === "throttle"));
  env.CONFIG.THROTTLE.per10min = 100;
  env._setQuota(5);
  env.doPost(jsonPost(Object.assign(good(), { email: "d@x.io" })));
  assert.strictEqual(subs(env).length, 2);
  assert.ok(logs(env).some((l) => l[4] === "quota"));
});

test("subscribe: a failed send reports server_error and releases the cooldown", (env) => {
  env._setSendError(new Error("Invalid argument: from"));
  assert.deepStrictEqual(out(env.doPost(jsonPost(good()))), { ok: false, error: "server_error" });
  assert.strictEqual(subs(env).length, 1);
  assert.strictEqual(subs(env)[0][col("last_sent_at")], "");
  assert.ok(logs(env).some((l) => l[3] === "error"));
  env._setSendError(null);
  assert.deepStrictEqual(out(env.doPost(jsonPost(good()))), { ok: true, state: "check" });
  assert.strictEqual(subs(env).length, 1);
  assert.strictEqual(env._mails.length, 1);
});

test("confirm: valid token → confirmed + welcome; reuse → invalid; bad token is sanitised", (env) => {
  env.doPost(jsonPost(good()));
  const token = subs(env)[0][col("confirm_token")];
  let page = env.doGet({ parameter: { action: "confirm", t: token } });
  assert.ok(page._html.indexOf("/zh/subscribed.html?s=confirmed") >= 0);
  assert.strictEqual(subs(env)[0][col("status")], "confirmed");
  assert.strictEqual(subs(env)[0][col("confirm_token")], "");
  assert.ok(subs(env)[0][col("confirmed_at")]);
  assert.strictEqual(env._mails.length, 2);
  assert.ok(env._mails[1].subject.indexOf("訂閱完成") >= 0);
  page = env.doGet({ parameter: { action: "confirm", t: token } });
  assert.ok(page._html.indexOf("s=invalid") >= 0);
  page = env.doGet({ parameter: { action: "confirm", t: "zz<script>" } });
  assert.ok(page._html.indexOf("s=invalid") >= 0 && page._html.indexOf("zz<script>") < 0);
});

test("confirm: expired token; welcome mail failure still confirms", (env) => {
  env.doPost(jsonPost(good()));
  subs(env)[0][col("confirm_expires")] = Date.now() - 1000;
  assert.ok(confirmOf(env)._html.indexOf("s=expired") >= 0);
  assert.strictEqual(subs(env)[0][col("status")], "pending");
  subs(env)[0][col("confirm_expires")] = Date.now() + 1000;
  env._setSendError(new Error("quota"));
  assert.ok(confirmOf(env)._html.indexOf("s=confirmed") >= 0);
  assert.strictEqual(subs(env)[0][col("status")], "confirmed");
});

test("unsubscribe: GET shows a confirmation page, POST unsubscribes, idempotent", (env) => {
  env.doPost(jsonPost(good()));
  confirmOf(env);
  const unsub = subs(env)[0][col("unsub_token")];
  let page = env.doGet({ parameter: { action: "unsubscribe", t: unsub } });
  assert.ok(page._html.indexOf("確認取消訂閱") >= 0 && page._html.indexOf('name="t" value="' + unsub + '"') >= 0 && page._html.indexOf('target="_top"') >= 0);
  assert.strictEqual(subs(env)[0][col("status")], "confirmed", "GET alone must not unsubscribe");
  page = env.doPost(formPost({ action: "unsubscribe", t: unsub }));
  assert.ok(page._html.indexOf("/zh/subscribed.html?s=unsubscribed") >= 0);
  assert.strictEqual(subs(env)[0][col("status")], "unsubscribed");
  page = env.doGet({ parameter: { action: "unsubscribe", t: unsub } });
  assert.ok(page._html.indexOf("s=unsubscribed") >= 0);
  assert.ok(env.doGet({ parameter: { action: "unsubscribe", t: "nope" } })._html.indexOf("s=invalid") >= 0);
});

test("unsubscribe → resubscribe: new unsub token, history kept, opt-in restarts", (env) => {
  env.doPost(jsonPost(good()));
  confirmOf(env);
  const unsub = subs(env)[0][col("unsub_token")];
  env.doPost(formPost({ action: "unsubscribe", t: unsub }));
  subs(env)[0][col("last_sent_at")] = "";
  env.doPost(jsonPost(good()));
  assert.strictEqual(subs(env).length, 1);
  assert.strictEqual(subs(env)[0][col("status")], "pending");
  assert.notStrictEqual(subs(env)[0][col("unsub_token")], unsub);
  assert.ok(String(subs(env)[0][col("history")]).indexOf("resubscribed") === 0);
  assert.ok(env.doGet({ parameter: { action: "unsubscribe", t: unsub } })._html.indexOf("s=invalid") >= 0, "old token is dead");
});

test("purge: pending rows with long-expired confirmations are removed", (env) => {
  env.doPost(jsonPost(Object.assign(good(), { email: "old@x.io" })));
  env.doPost(jsonPost(Object.assign(good(), { email: "fresh@x.io" })));
  subs(env)[0][col("confirm_expires")] = Date.now() - 40 * 86400000;
  assert.strictEqual(env.purgeExpiredPending(), 1);
  assert.deepStrictEqual(subs(env).map((r) => r[0]), ["fresh@x.io"]);
});

test("doGet: ping and unknown actions", (env) => {
  assert.deepStrictEqual(out(env.doGet({ parameter: { action: "ping" } })), { ok: true, service: "miyama-subscribe" });
  assert.ok(env.doGet({ parameter: {} })._html.indexOf("https://www.miyamacap.com/") >= 0);
  assert.ok(env.doGet(undefined)._html.indexOf("https://www.miyamacap.com/") >= 0);
});

test("campaign: confirmed + language only, logs, resumes, stops on quota, skips mid-run unsubscribes", (env) => {
  const people = [["a@x.io", "zh"], ["b@x.io", "zh"], ["c@x.io", "en"], ["d@x.io", "zh"], ["e@x.io", "zh"]];
  people.forEach(([email, lang]) => env.doPost(jsonPost(Object.assign(good(), { email, lang }))));
  [0, 1, 2, 4].forEach((i) => confirmOf(env, i)); // d stays pending
  env._mails.length = 0;
  env.setup();
  env._sheets.Campaigns.appendRow(["q4-2026", "Q4 Outlook", "Hi {{name}},\nAttached is the report.", "report.pdf", "zh", "", "", "", ""]);
  env._select("Campaigns", 2);
  subs(env)[4][col("status")] = "unsubscribed"; // e leaves before the run reaches them
  env._setQuota(21);
  let summary = env.sendCampaign(env.selectedCampaign());
  assert.strictEqual(env._mails.length, 2, "a and b only");
  assert.ok(env._mails[0].body.indexOf("Hi Ann Lee") >= 0);
  assert.strictEqual(env._mails[0].options.attachments[0].name, "report.pdf");
  assert.ok(env._mails[0].options.htmlBody.indexOf("/exec?action=unsubscribe&amp;t=") >= 0);
  assert.strictEqual(env._sheets.Campaigns._rows[1][5], "sent");
  assert.ok(summary.indexOf("寄出 2 封") >= 0);
  summary = env.sendCampaign(env.selectedCampaign());
  assert.strictEqual(env._mails.length, 2);
  assert.ok(summary.indexOf("略過已寄 2 封") >= 0);
  env._sheets.Log._rows.length = 1;
  env._setQuota(5);
  summary = env.sendCampaign(env.selectedCampaign());
  assert.strictEqual(env._mails.length, 2);
  assert.ok(summary.indexOf("額度") >= 0);
  assert.strictEqual(env._sheets.Campaigns._rows[1][5], "sending");
  env._sheets.Campaigns.appendRow(["x", "s", "b", "missing.pdf", "all", "", "", "", ""]);
  env._select("Campaigns", 3);
  assert.throws(() => env.sendCampaign(env.selectedCampaign()), /找不到檔案/);
});

test("setup: reports missing settings and unknown SENDER alias; alias is used when valid", (env) => {
  env._props.SENDER = "nobody@miyamacap.com";
  delete env._props.WEB_APP_URL;
  const msg = env.setup();
  assert.ok(msg.indexOf("WEB_APP_URL") >= 0 && msg.indexOf("nobody@miyamacap.com") >= 0);
  env._props.SENDER = "connect@miyamacap.com";
  env._props.WEB_APP_URL = "https://script.google.com/macros/s/TEST/exec";
  assert.ok(env.setup().indexOf("設定已齊全") >= 0);
  env.doPost(jsonPost(good()));
  assert.strictEqual(env._mails[0].options.from, "connect@miyamacap.com");
  assert.strictEqual(env._mails[0].options.replyTo, "connect@miyamacap.com");
});

test("web app: setup saves container ID; subscribe/confirm/unsubscribe work without active spreadsheet", (env) => {
  delete env._props.SPREADSHEET_ID;
  assert.deepStrictEqual(out(env.doPost(jsonPost(good()))), { ok: false, error: "unconfigured" });
  assert.strictEqual(subs(env).length, 0);
  assert.strictEqual(env._mails.length, 0);
  env.setup();
  assert.strictEqual(env._props.SPREADSHEET_ID, "test-spreadsheet");
  env.SpreadsheetApp.getActiveSpreadsheet = () => null;
  assert.deepStrictEqual(out(env.doPost(jsonPost(good()))), { ok: true, state: "check" });
  confirmOf(env);
  assert.strictEqual(subs(env)[0][col("status")], "confirmed");
  const token = subs(env)[0][col("unsub_token")];
  assert.ok(env.doGet({ parameter: { action: "unsubscribe", t: token } })._html.includes('name="action" value="unsubscribe"'));
  env.doPost(formPost({ action: "unsubscribe", t: token }));
  assert.strictEqual(subs(env)[0][col("status")], "unsubscribed");
  delete env._props.SPREADSHEET_ID;
  assert.ok(env.setup().includes("SPREADSHEET_ID"));
});

test("missing/invalid mail settings reject subscriptions before storage/send; unsubscribe remains available", (env) => {
  for (const [key, value] of [["WEB_APP_URL", ""], ["WEB_APP_URL", "https://script.google.com/macros/s/TEST/dev"], ["POSTAL_ADDRESS", "   "]]) {
    const isolated = makeEnv();
    isolated._props[key] = value;
    assert.deepStrictEqual(out(isolated.doPost(jsonPost(good()))), { ok: false, error: "unconfigured" });
    assert.strictEqual(subs(isolated).length, 0);
    assert.strictEqual(isolated._mails.length, 0);
  }
  env.doPost(jsonPost(good()));
  confirmOf(env);
  const token = subs(env)[0][col("unsub_token")];
  delete env._props.POSTAL_ADDRESS;
  delete env._props.WEB_APP_URL;
  assert.ok(env.doPost(formPost({ action: "unsubscribe", t: token }))._html.includes("s=unsubscribed"));
  assert.strictEqual(subs(env)[0][col("status")], "unsubscribed");
});

test("welcome respects global email ceiling/quota while confirmation stays successful", (env) => {
  env.CONFIG.THROTTLE.per10min = 1;
  env.CONFIG.THROTTLE.perDay = 1;
  env.doPost(jsonPost(good()));
  assert.ok(confirmOf(env)._html.includes("s=confirmed"));
  assert.strictEqual(env._mails.length, 1);
  assert.strictEqual(subs(env)[0][col("status")], "confirmed");
  assert.ok(logs(env).some((l) => l[3] === "dropped" && l[4] === "welcome: throttle"));
  const isolated = makeEnv();
  isolated.doPost(jsonPost(good()));
  isolated._setQuota(20);
  assert.ok(confirmOf(isolated)._html.includes("s=confirmed"));
  assert.strictEqual(isolated._mails.length, 1);
  assert.ok(logs(isolated).some((l) => l[4] === "welcome: quota"));
});

test("removed mail settings block welcome and campaigns without undoing confirmation or disabling unsubscribe", (env) => {
  env.doPost(jsonPost(good()));
  delete env._props.POSTAL_ADDRESS;
  delete env._props.WEB_APP_URL;
  assert.ok(confirmOf(env)._html.includes("s=confirmed"));
  assert.strictEqual(subs(env)[0][col("status")], "confirmed");
  assert.strictEqual(env._mails.length, 1, "No welcome with broken mail settings");
  env.setup();
  env._sheets.Campaigns.appendRow(["not-configured", "Report", "Hi", "report.pdf", "all"]);
  env._select("Campaigns", 2);
  const summary = env.sendCampaign(env.selectedCampaign());
  assert.ok(summary.includes("失敗 1 封"));
  assert.strictEqual(env._sheets.Campaigns._rows[1][5], "sending");
  assert.strictEqual(env._mails.length, 1, "No campaign with broken mail settings");
  const token = subs(env)[0][col("unsub_token")];
  assert.ok(env.doPost(formPost({ action: "unsubscribe", t: token }))._html.includes("s=unsubscribed"));
  env._props.POSTAL_ADDRESS = "1 Test St";
  env._props.WEB_APP_URL = "https://script.google.com/not-a-deployment/exec";
  assert.ok(env.setup().includes("WEB_APP_URL"));
  assert.throws(() => env.sendMail("test@example.com", { subject: "x", text: "x", html: "x" }), /settings are incomplete/);
});

test("campaign overlapping runs send once, without holding ScriptLock during email", (env) => {
  env.doPost(jsonPost(good()));
  confirmOf(env);
  env.setup();
  env._sheets.Campaigns.appendRow(["overlap", "Report", "Hi {{name}}", "report.pdf", "zh"]);
  env._select("Campaigns", 2);
  const campaign = env.selectedCampaign();
  const original = env.GmailApp.sendEmail;
  env._mails.length = 0;
  let overlap = false;
  env.GmailApp.sendEmail = (...args) => {
    assert.strictEqual(env._lockDepth(), 0, "Mail must be sent outside ScriptLock");
    if (!overlap) {
      overlap = true;
      assert.ok(env.sendCampaign(campaign).includes("正在寄送中"));
    }
    original(...args);
  };
  env.sendCampaign(campaign);
  assert.strictEqual(env._mails.length, 1);
  env.sendCampaign(campaign);
  assert.strictEqual(env._mails.length, 1, "sequential rerun skips the sent recipient");
  assert.deepStrictEqual(JSON.parse(env._props.CAMPAIGN_RUNS), {});
});

test("campaign mixed success/failure stays sending; retry sends only the failed recipient", (env) => {
  for (const email of ["a@x.io", "b@x.io"]) {
    env.doPost(jsonPost(Object.assign(good(), { email })));
    confirmOf(env, subs(env).length - 1);
  }
  env.setup();
  env._sheets.Campaigns.appendRow(["retry", "Report", "Hi {{name}}", "report.pdf", "zh"]);
  env._select("Campaigns", 2);
  const campaign = env.selectedCampaign();
  const original = env.GmailApp.sendEmail;
  env._mails.length = 0;
  env.GmailApp.sendEmail = (...args) => {
    if (args[0] === "b@x.io") throw new Error("simulated temporary error");
    original(...args);
  };
  let summary = env.sendCampaign(campaign);
  assert.ok(summary.includes("失敗 1 封") && summary.includes("還有 1 位未寄"));
  assert.strictEqual(env._sheets.Campaigns._rows[1][5], "sending");
  env.GmailApp.sendEmail = original;
  summary = env.sendCampaign(campaign);
  assert.deepStrictEqual(env._mails.map((m) => m.to), ["a@x.io", "b@x.io"]);
  assert.strictEqual(env._sheets.Campaigns._rows[1][5], "sent");
  assert.strictEqual(logs(env).filter((l) => l[1] === "retry" && l[3] === "sent").length, 2);
});

test("campaign lease releases on resource errors and expired execution leases can resume", (env) => {
  env.setup();
  env._sheets.Campaigns.appendRow(["lease", "Report", "Hi", "missing.pdf", "all"]);
  env._select("Campaigns", 2);
  const campaign = env.selectedCampaign();
  assert.throws(() => env.sendCampaign(campaign), /找不到檔案/);
  assert.deepStrictEqual(JSON.parse(env._props.CAMPAIGN_RUNS), {});
  env._props.CAMPAIGN_RUNS = JSON.stringify({ "$lease": { token: "expired", expires: Date.now() - 1 } });
  campaign.pdf_name = "report.pdf";
  assert.ok(env.sendCampaign(campaign).includes("本次寄出 0 封"));
  assert.deepStrictEqual(JSON.parse(env._props.CAMPAIGN_RUNS), {});
});

// ---- Runner ------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try { t.fn(makeEnv()); console.log("ok   " + t.name); }
  catch (err) { failed++; console.log("FAIL " + t.name + "\n     " + (err.stack || err).toString().split("\n").slice(0, 3).join("\n     ")); }
}
console.log(failed ? `\n${failed} failing` : `\nall ${tests.length} passing`);
process.exit(failed ? 1 : 0);
