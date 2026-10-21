/**
 * Miyama Capital research subscription backend.
 *
 * Runs as a Google Apps Script bound to a Google Sheet and deployed as a
 * web app (Execute as: Me / Who has access: Anyone). The website form
 * POSTs here; confirmation and unsubscribe links GET here; reports are
 * sent from the Sheet's "Miyama 訂閱" menu.
 *
 * Sheets: Subscribers, Campaigns, Log (created by setup()).
 * Script properties (Project Settings → Script properties):
 *   SPREADSHEET_ID    saved automatically by setup() from the bound Sheet.
 *   POSTAL_ADDRESS    required. Physical mailing address printed in every email.
 *   WEB_APP_URL       required. The deployed /exec URL (links in emails are built from it).
 *   REPORTS_FOLDER_ID required for sending. Drive folder that holds the PDFs.
 *   SENDER            optional. A "Send mail as" alias of the deploying account,
 *                     e.g. connect@miyamacap.com. Omit to send as the account.
 *   FROM_NAME         optional. Defaults to "Miyama Capital".
 *   REPLY_TO          optional. Defaults to connect@miyamacap.com.
 *   SITE_ORIGIN       optional. Defaults to https://www.miyamacap.com.
 *   ALERT_EMAIL       optional. Where backend error alerts are mailed (at most one per hour).
 *                     Defaults to the account that deployed the script.
 */

var CONFIG = {
  SHEET_SUBSCRIBERS: "Subscribers",
  SHEET_CAMPAIGNS: "Campaigns",
  SHEET_LOG: "Log",
  LANGS: ["zh", "en", "ja"],
  DEFAULT_LANG: "en",
  CONFIRM_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  RESEND_COOLDOWN_MS: 60 * 60 * 1000,
  // An address that opted out is only re-mailed a confirmation once a day, so nobody can keep poking it.
  UNSUB_COOLDOWN_MS: 24 * 60 * 60 * 1000,
  MIN_FORM_MS: 2000,
  MAX_LEN: { email: 254, name: 80, org: 120 },
  // Site-wide ceiling on subscription emails, so an open endpoint cannot be used for backscatter.
  THROTTLE: { per10min: 30, perDay: 300 },
  QUOTA_RESERVE: 20,
  RUN_BUDGET_MS: 4 * 60 * 1000,
  PURGE_PENDING_AFTER_MS: 30 * 24 * 60 * 60 * 1000,
  SEND_WELCOME: true,
  // Error alerts to the owner are collapsed to one email per hour; the rest only reach the Log sheet.
  ALERT_COOLDOWN_MS: 60 * 60 * 1000,
  // Log results that trigger an alert email.
  ALERT_RESULTS: { error: true, failed: true },
  CONSENT_VERSION: "2026-10",
};

var SUBSCRIBER_COLUMNS = [
  "email", "name", "org", "lang", "status",
  "confirm_token", "confirm_expires", "unsub_token",
  "created_at", "confirmed_at", "unsubscribed_at", "last_sent_at",
  "source", "consent", "history",
];

var CAMPAIGN_COLUMNS = ["id", "subject", "body", "pdf_name", "lang", "status", "sent_at", "sent_count", "notes"];

var LOG_COLUMNS = ["at", "campaign_id", "email", "result", "detail"];

// Free-text columns: cellSafe() is re-applied on every write, since Sheets may consume a leading apostrophe.
var TEXT_COLUMNS = { name: true, org: true, source: true, history: true, detail: true };

function columnLetter(n) {
  var s = "";
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
  var props = PropertiesService.getScriptProperties();
  return {
    postalAddress: props.getProperty("POSTAL_ADDRESS") || "",
    webAppUrl: props.getProperty("WEB_APP_URL") || "",
    reportsFolderId: props.getProperty("REPORTS_FOLDER_ID") || "",
    sender: props.getProperty("SENDER") || "",
    fromName: props.getProperty("FROM_NAME") || "Miyama Capital",
    replyTo: props.getProperty("REPLY_TO") || "connect@miyamacap.com",
    siteOrigin: (props.getProperty("SITE_ORIGIN") || "https://www.miyamacap.com").replace(/\/+$/, ""),
    alertEmail: props.getProperty("ALERT_EMAIL") || "",
  };
}

// Google shows either .../macros/s/<id>/exec or, for Workspace accounts, .../a/macros/<domain>/s/<id>/exec.
function isWebAppUrl(value) {
  return /^https:\/\/script\.google\.com\/(macros|a\/macros\/[A-Za-z0-9.-]+)\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(value || ""));
}

function requireMailSettings() {
  var settings = getSettings();
  if (!String(settings.postalAddress).trim() || !isWebAppUrl(settings.webAppUrl)) {
    var error = new Error("Subscription email settings are incomplete. Set POSTAL_ADDRESS and the deployed WEB_APP_URL.");
    error.code = "not_configured";
    throw error;
  }
  return settings;
}

// ScriptApp.getService().getUrl() returns the /dev URL outside a web request, so the /exec URL is configured.
function getWebAppUrl() {
  return getSettings().webAppUrl || ScriptApp.getService().getUrl();
}

// ---------------------------------------------------------------------------
// Pure helpers (also exercised by tools/apps-script/test.js)
// ---------------------------------------------------------------------------

// Whitelisted charset: nothing that Sheets, HTML or a mailto could interpret.
function normalizeEmail(value) {
  var email = String(value || "").trim().toLowerCase();
  if (email.length > CONFIG.MAX_LEN.email) return "";
  if (!/^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/.test(email)) return "";
  if (/\.\./.test(email) || /^\./.test(email) || /\.@/.test(email)) return "";
  return email;
}

// Addresses that reach the same mailbox share one cooldown key (+tags, Gmail dots).
function emailKey(email) {
  var parts = String(email || "").toLowerCase().split("@");
  if (parts.length !== 2) return String(email || "").toLowerCase();
  var local = parts[0].replace(/\+.*$/, "");
  var domain = parts[1];
  if (domain === "gmail.com" || domain === "googlemail.com") { local = local.replace(/\./g, ""); domain = "gmail.com"; }
  return local + "@" + domain;
}

function cleanText(value, maxLen) {
  var text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > maxLen) text = text.slice(0, maxLen);
  return text;
}

// A name is greeted at the top of our emails, so it must not carry a link or a domain.
function looksLikeLink(text) {
  return /https?:|www\.|\.[a-z]{2,}(?=$|[\s\/,;:])/i.test(String(text || ""));
}

// Sheets treats cells starting with = + - @ as formulas; keep user input literal.
function cellSafe(value) {
  var text = String(value == null ? "" : value);
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

function normalizeLang(value) {
  var lang = String(value || "").trim().toLowerCase();
  if (lang === "jp" || lang === "ja-jp") lang = "ja";
  if (lang.indexOf("zh") === 0) lang = "zh";
  if (lang.indexOf("en") === 0) lang = "en";
  return CONFIG.LANGS.indexOf(lang) >= 0 ? lang : CONFIG.DEFAULT_LANG;
}

function siteLangPath(lang) {
  return lang === "ja" ? "jp" : lang;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function jsString(value) {
  return JSON.stringify(String(value)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function newToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
}

function cleanToken(value) {
  return String(value || "").replace(/[^a-f0-9]/g, "").slice(0, 64);
}

function isTruthy(value) {
  var v = String(value == null ? "" : value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** Turns the raw POST body (JSON, text/plain JSON, or a form post) into a plain object. */
function parseRequest(e) {
  var data = {};
  var json = false;
  var postData = e && e.postData;
  if (postData && postData.contents) {
    var type = String(postData.type || "");
    if (/json|text\/plain/i.test(type)) {
      try { data = JSON.parse(postData.contents) || {}; json = true; } catch (err) { data = {}; json = true; }
    }
  }
  if (!json && e && e.parameter) {
    Object.keys(e.parameter).forEach(function (k) { data[k] = e.parameter[k]; });
  }
  return { data: data, json: json };
}

/**
 * Validates a subscription request.
 * Returns { ok:false, error } for user-facing errors, { ok:true, silent, reason } for bot drops,
 * or { ok:true, record }. The timing check only applies to JS submissions, which send `elapsed`;
 * plain form posts rely on the honeypot and the double opt-in.
 */
function validateSubscription(data, isJson) {
  if (cleanText(data.ref_code, 200)) return { ok: true, silent: true, reason: "honeypot" };
  if (isJson) {
    var elapsed = Number(data.elapsed || 0);
    if (!(elapsed >= CONFIG.MIN_FORM_MS)) return { ok: true, silent: true, reason: "too_fast" };
  }

  var email = normalizeEmail(data.email);
  if (!email) return { ok: false, error: "invalid_email" };
  var name = cleanText(data.name, CONFIG.MAX_LEN.name);
  if (!name) return { ok: false, error: "name_required" };
  if (looksLikeLink(name)) return { ok: false, error: "name_invalid" };
  if (!isTruthy(data.consent)) return { ok: false, error: "consent_required" };

  return {
    ok: true,
    record: {
      email: email,
      name: name,
      org: cleanText(data.org, CONFIG.MAX_LEN.org),
      lang: normalizeLang(data.lang),
      source: cleanText(data.source, 200),
    },
  };
}

// ---------------------------------------------------------------------------
// Sheet access
// ---------------------------------------------------------------------------

function getSheet(name, columns) {
  // A Web App has no active container, even when the script is Sheet-bound.
  var id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!id) {
    var error = new Error("Subscription storage is not configured. Run setup() from the bound spreadsheet first.");
    error.code = "not_configured";
    throw error;
  }
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
    // Plain-text columns (whole columns, so rows appended later inherit it): nothing a visitor
    // types is ever evaluated as a formula or coerced to a date.
    try { sheet.getRange("A:" + columnLetter(columns.length)).setNumberFormat("@"); } catch (ignore) {}
  }
  return sheet;
}

function readRows(sheet, columns) {
  var values = sheet.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = { _row: i + 1 };
    for (var c = 0; c < columns.length; c++) row[columns[c]] = values[i][c];
    rows.push(row);
  }
  return rows;
}

function cellValue(col, value) {
  if (value == null) return "";
  return TEXT_COLUMNS[col] && typeof value === "string" ? cellSafe(value) : value;
}

function writeRow(sheet, columns, rowIndex, record) {
  var values = columns.map(function (col) { return cellValue(col, record[col]); });
  sheet.getRange(rowIndex, 1, 1, columns.length).setValues([values]);
}

function writeCell(sheet, columns, rowIndex, column, value) {
  sheet.getRange(rowIndex, columns.indexOf(column) + 1).setValue(value);
}

function appendRecord(sheet, columns, record) {
  sheet.appendRow(columns.map(function (col) { return cellValue(col, record[col]); }));
}

function findRow(rows, predicate) {
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) return rows[i];
  return null;
}

function logEvent(campaignId, email, result, detail) {
  try {
    appendRecord(getSheet(CONFIG.SHEET_LOG, LOG_COLUMNS), LOG_COLUMNS, {
      at: new Date().toISOString(), campaign_id: campaignId, email: email, result: result, detail: cellSafe(detail || ""),
    });
  } finally {
    // Errors are mailed to the owner even when the Log sheet itself is unreachable.
    if (CONFIG.ALERT_RESULTS[result]) alertOwner(campaignId, email, result, detail);
  }
}

// ---------------------------------------------------------------------------
// Error alerts
// ---------------------------------------------------------------------------

/** ALERT_EMAIL when set and valid, otherwise the account the script runs as. */
function alertRecipient() {
  return normalizeEmail(getSettings().alertEmail) || Session.getEffectiveUser().getEmail();
}

function spreadsheetUrl() {
  var id = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!id) return "";
  var url = "https://docs.google.com/spreadsheets/d/" + id + "/edit";
  try {
    var log = SpreadsheetApp.openById(id).getSheetByName(CONFIG.SHEET_LOG);
    if (log && typeof log.getSheetId === "function") url += "#gid=" + log.getSheetId();
  } catch (ignore) {}
  return url;
}

/**
 * Emails the owner about an error the Log sheet just recorded. At most one alert per
 * ALERT_COOLDOWN_MS (claimed under the script lock, so concurrent requests cannot both send);
 * a failed send gives the slot back. Never throws: a broken alert must not break the request.
 */
function alertOwner(campaignId, email, result, detail) {
  var claimed = false, previous = null;
  try {
    var now = Date.now();
    claimed = withLock(function () {
      var props = PropertiesService.getScriptProperties();
      previous = props.getProperty("ALERT_LAST_SENT_AT");
      if (now - (Number(previous) || 0) < CONFIG.ALERT_COOLDOWN_MS) return false;
      props.setProperty("ALERT_LAST_SENT_AT", String(now));
      return true;
    });
    if (!claimed) return;
    var text = String(detail || "").replace(/\s+$/, "");
    if (text.length > 4000) text = text.slice(0, 4000) + "\n…";
    var headline = (text.split("\n")[0] || result).slice(0, 120);
    var lines = [
      "研究訂閱系統在 " + new Date(now).toISOString() + " 記錄了一筆 " + result + "。",
      "",
      "結果：" + result,
      "Campaign：" + (campaignId || "（無）"),
      "Email：" + (email || "（無）"),
      "詳細：",
      text || "（無）",
      "",
    ];
    var sheetUrl = spreadsheetUrl();
    if (sheetUrl) lines.push("Log 工作表：" + sheetUrl);
    try { lines.push("Apps Script 執行紀錄：https://script.google.com/home/projects/" + ScriptApp.getScriptId() + "/executions"); } catch (ignore) {}
    lines.push("", "接下來一小時內的其他錯誤只會寫入 Log，不再寄信。");
    MailApp.sendEmail(alertRecipient(), "[Miyama 訂閱] 後端" + (result === "failed" ? "寄送失敗" : "錯誤") + "：" + headline, lines.join("\n"));
  } catch (err) {
    if (claimed) {
      try { withLock(function () { PropertiesService.getScriptProperties().setProperty("ALERT_LAST_SENT_AT", previous || "0"); }); } catch (ignore) {}
    }
    try { Logger.log("alert failed: " + (err && err.message || err)); } catch (ignore) {}
  }
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Site-wide ceiling on subscription emails per 10 minutes and per day. Call inside the lock. */
function throttleAllows() {
  var props = PropertiesService.getScriptProperties();
  var now = Date.now();
  var bucket = Math.floor(now / 600000);
  var day = Math.floor(now / 86400000);
  var state;
  try { state = JSON.parse(props.getProperty("THROTTLE_STATE") || "{}"); } catch (err) { state = {}; }
  if (state.bucket !== bucket) { state.bucket = bucket; state.bucketCount = 0; }
  if (state.day !== day) { state.day = day; state.dayCount = 0; }
  if (state.bucketCount >= CONFIG.THROTTLE.per10min || state.dayCount >= CONFIG.THROTTLE.perDay) return false;
  state.bucketCount++;
  state.dayCount++;
  props.setProperty("THROTTLE_STATE", JSON.stringify(state));
  return true;
}

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

function doPost(e) {
  var req = parseRequest(e);
  if (!req.json && String(req.data.action || "") === "unsubscribe") {
    return redirectOutput(statusPageUrl(null, null, safely(function () { return handleUnsubscribe(cleanToken(req.data.t)); })));
  }
  var result;
  try {
    result = handleSubscribe(req.data, req.json);
  } catch (err) {
    result = { ok: false, error: err && err.code === "not_configured" ? "unconfigured" : "server_error" };
    try { logEvent("", "", "error", String(err && err.stack || err)); } catch (ignore) {}
  }
  if (req.json) return jsonOutput(result);
  return redirectOutput(statusPageUrl(normalizeLang(req.data.lang), result.ok ? "check" : result.error));
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || "");
  if (action === "ping") return jsonOutput({ ok: true, service: "miyama-subscribe" });
  var token = cleanToken(p.t);
  if (action === "confirm") return redirectOutput(statusPageUrl(null, null, safely(function () { return handleConfirm(token); })));
  if (action === "unsubscribe") return unsubscribePage(token);
  return redirectOutput(getSettings().siteOrigin + "/");
}

function safely(fn) {
  try { return fn(); } catch (err) {
    try { logEvent("", "", "error", String(err && err.stack || err)); } catch (ignore) {}
    return { lang: null, state: "server_error" };
  }
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function pageShell(bodyHtml) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Miyama Capital</title></head><body style="font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:32px 24px;color:#0F172A;line-height:1.6">' +
    '<p style="font-weight:800;font-size:18px;margin:0 0 16px">Miyama Capital</p>' + bodyHtml + "</body></html>";
}

/**
 * Apps Script cannot send a 302, and HtmlService renders inside a sandboxed iframe,
 * so the page forwards itself to the site with window.open(url, "_top") and keeps a
 * visible target="_top" link as the fallback.
 */
function redirectOutput(url) {
  var safe = escapeHtml(url);
  var html = pageShell('<p style="margin:0"><a href="' + safe + '" target="_top" style="color:#4F46E5">Continue to Miyama Capital → ／ 前往 Miyama Capital ／ Miyama Capital へ進む</a></p>' +
    "<script>try { window.open(" + jsString(url) + ', "_top"); } catch (e) {}</script>');
  return HtmlService.createHtmlOutput(html).setTitle("Miyama Capital");
}

/** Builds /<lang>/subscribed.html?s=<state>. The third argument is a { lang, state } result object. */
function statusPageUrl(lang, state, result) {
  if (result) { lang = result.lang; state = result.state; }
  lang = normalizeLang(lang);
  return getSettings().siteOrigin + "/" + siteLangPath(lang) + "/subscribed.html?s=" + encodeURIComponent(state || "invalid");
}

// ---------------------------------------------------------------------------
// Subscribe / confirm / unsubscribe
// ---------------------------------------------------------------------------

function handleSubscribe(data, isJson) {
  var now = Date.now();
  var check = validateSubscription(data, isJson);
  if (!check.ok) return { ok: false, error: check.error };
  if (check.silent) { logEvent("", "", "dropped", check.reason); return { ok: true, state: "check" }; }
  // Refuse before storing a pending subscriber or building any email links.
  requireMailSettings();
  var rec = check.record;
  var nowIso = new Date(now).toISOString();

  var outcome = withLock(function () {
    var sheet = getSheet(CONFIG.SHEET_SUBSCRIBERS, SUBSCRIBER_COLUMNS);
    var rows = readRows(sheet, SUBSCRIBER_COLUMNS);
    var key = emailKey(rec.email);
    var recentlyMailed = findRow(rows, function (r) {
      var cooldown = r.status === "unsubscribed" ? CONFIG.UNSUB_COOLDOWN_MS : CONFIG.RESEND_COOLDOWN_MS;
      return emailKey(r.email) === key && now - (Date.parse(r.last_sent_at) || 0) < cooldown;
    });
    if (recentlyMailed) return { drop: "cooldown" };
    if (!throttleAllows()) return { drop: "throttle" };
    if (MailApp.getRemainingDailyQuota() <= CONFIG.QUOTA_RESERVE) return { drop: "quota" };

    var existing = findRow(rows, function (r) { return String(r.email).toLowerCase() === rec.email; });

    if (existing && existing.status === "confirmed") {
      writeCell(sheet, SUBSCRIBER_COLUMNS, existing._row, "last_sent_at", nowIso);
      return { kind: "already", record: existing, row: existing._row };
    }

    var history = existing && existing.history ? String(existing.history) + "\n" : "";
    if (existing && existing.status === "unsubscribed") history += "resubscribed " + nowIso + " (unsubscribed " + existing.unsubscribed_at + ")";
    var record = {
      email: rec.email,
      name: cellSafe(rec.name),
      org: cellSafe(rec.org),
      lang: rec.lang,
      status: "pending",
      confirm_token: newToken(),
      confirm_expires: now + CONFIG.CONFIRM_TTL_MS,
      // A token that may have leaked while unsubscribed must not survive re-subscription.
      unsub_token: existing && existing.status === "pending" ? existing.unsub_token : newToken(),
      created_at: (existing && existing.created_at) || nowIso,
      confirmed_at: "",
      unsubscribed_at: "",
      last_sent_at: nowIso,
      source: cellSafe(rec.source),
      consent: CONFIG.CONSENT_VERSION + " " + nowIso,
      history: cellSafe(history.trim()),
    };
    if (existing) { writeRow(sheet, SUBSCRIBER_COLUMNS, existing._row, record); return { kind: "confirm", record: record, row: existing._row }; }
    appendRecord(sheet, SUBSCRIBER_COLUMNS, record);
    return { kind: "confirm", record: record, row: sheet.getLastRow() };
  });

  if (outcome.drop) { logEvent("", "", "dropped", outcome.drop); return { ok: true, state: "check" }; }

  // Mail is sent outside the lock; a failed send releases the cooldown so the visitor can retry.
  try {
    sendTemplate(outcome.kind, outcome.record);
  } catch (err) {
    withLock(function () { writeCell(getSheet(CONFIG.SHEET_SUBSCRIBERS, SUBSCRIBER_COLUMNS), SUBSCRIBER_COLUMNS, outcome.row, "last_sent_at", ""); });
    throw err;
  }
  return { ok: true, state: "check" };
}

function handleConfirm(token) {
  if (!token) return { lang: null, state: "invalid" };
  var result = withLock(function () {
    var sheet = getSheet(CONFIG.SHEET_SUBSCRIBERS, SUBSCRIBER_COLUMNS);
    var row = findRow(readRows(sheet, SUBSCRIBER_COLUMNS), function (r) { return r.confirm_token === token; });
    if (!row) return { lang: null, state: "invalid" };
    if (row.status === "confirmed") return { lang: row.lang, state: "already" };
    if (Date.now() > Number(row.confirm_expires || 0)) return { lang: row.lang, state: "expired" };
    row.status = "confirmed";
    row.confirmed_at = new Date().toISOString();
    row.confirm_token = "";
    row.confirm_expires = "";
    writeRow(sheet, SUBSCRIBER_COLUMNS, row._row, row);
    return { lang: row.lang, state: "confirmed", record: row };
  });
  if (result.record && CONFIG.SEND_WELCOME) {
    try {
      var welcomeDrop = withLock(function () {
        if (MailApp.getRemainingDailyQuota() <= CONFIG.QUOTA_RESERVE) return "quota";
        return throttleAllows() ? "" : "throttle";
      });
      if (welcomeDrop) logEvent("", result.record.email, "dropped", "welcome: " + welcomeDrop);
      else sendTemplate("welcome", result.record);
    } catch (err) {
      // Confirmation is already saved; mail/log failures must not undo success.
      try { logEvent("", result.record.email, "error", "welcome: " + (err && err.message || err)); } catch (ignore) {}
    }
  }
  return { lang: result.lang, state: result.state };
}

function findByUnsubToken(token) {
  var sheet = getSheet(CONFIG.SHEET_SUBSCRIBERS, SUBSCRIBER_COLUMNS);
  return { sheet: sheet, row: findRow(readRows(sheet, SUBSCRIBER_COLUMNS), function (r) { return r.unsub_token === token; }) };
}

/** Step 1 of unsubscribing: a page with a button, so link scanners cannot unsubscribe people. */
function unsubscribePage(token) {
  if (!token) return redirectOutput(statusPageUrl(null, "invalid"));
  var found = findByUnsubToken(token);
  if (!found.row) return redirectOutput(statusPageUrl(null, "invalid"));
  if (found.row.status === "unsubscribed") return redirectOutput(statusPageUrl(found.row.lang, "unsubscribed"));
  var lang = normalizeLang(found.row.lang);
  var t = TEMPLATES[lang].unsubscribePage;
  var html = pageShell(
    "<p style=\"margin:0 0 20px\">" + escapeHtml(t.question).replace("{email}", "<strong>" + escapeHtml(found.row.email) + "</strong>") + "</p>" +
    '<form method="post" action="' + escapeHtml(getWebAppUrl()) + '" target="_top" style="margin:0 0 16px">' +
    '<input type="hidden" name="action" value="unsubscribe"><input type="hidden" name="t" value="' + escapeHtml(token) + '">' +
    '<button type="submit" style="padding:12px 22px;background:#4F46E5;color:#fff;border:0;border-radius:8px;font:inherit;font-weight:600;cursor:pointer">' + escapeHtml(t.button) + "</button></form>" +
    '<p style="margin:0"><a href="' + escapeHtml(getSettings().siteOrigin + "/" + siteLangPath(lang) + "/") + '" target="_top" style="color:#64748B">' + escapeHtml(t.keep) + "</a></p>");
  return HtmlService.createHtmlOutput(html).setTitle("Miyama Capital");
}

/** Step 2 of unsubscribing (POST from the page above). Idempotent. */
function handleUnsubscribe(token) {
  if (!token) return { lang: null, state: "invalid" };
  return withLock(function () {
    var found = findByUnsubToken(token);
    var row = found.row;
    if (!row) return { lang: null, state: "invalid" };
    if (row.status !== "unsubscribed") {
      row.status = "unsubscribed";
      row.unsubscribed_at = new Date().toISOString();
      row.confirm_token = "";
      row.confirm_expires = "";
      // The privacy policy keeps only the address and the opt-out record after unsubscribing.
      row.name = "";
      row.org = "";
      row.source = "";
      writeRow(found.sheet, SUBSCRIBER_COLUMNS, row._row, row);
    }
    return { lang: row.lang, state: "unsubscribed" };
  });
}

/** Menu: delete pending rows whose confirmation link expired more than 30 days ago. */
function purgeExpiredPending() {
  var removed = withLock(function () {
    var sheet = getSheet(CONFIG.SHEET_SUBSCRIBERS, SUBSCRIBER_COLUMNS);
    var rows = readRows(sheet, SUBSCRIBER_COLUMNS);
    var cutoff = Date.now() - CONFIG.PURGE_PENDING_AFTER_MS;
    var count = 0;
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      if (r.status === "pending" && Number(r.confirm_expires || 0) < cutoff) { sheet.deleteRow(r._row); count++; }
    }
    return count;
  });
  var msg = "已刪除 " + removed + " 筆逾期未確認的申請。";
  try { SpreadsheetApp.getUi().alert(msg); } catch (noUi) { Logger.log(msg); }
  return removed;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function displayName(record) {
  return String(record.name || "").replace(/^'(?=[=+\-@])/, "");
}

function confirmUrl(record) {
  return getWebAppUrl() + "?action=confirm&t=" + record.confirm_token;
}

function unsubscribeUrl(record) {
  return getWebAppUrl() + "?action=unsubscribe&t=" + record.unsub_token;
}

var TEMPLATES = {
  zh: {
    confirm: {
      subject: "請確認訂閱 Miyama Capital 研究",
      intro: "{name} 您好，\n\n感謝您訂閱 Miyama Capital 的研究報告。請點選下方連結確認您的電子郵件，之後我們才會寄送報告給您。",
      action: "確認訂閱",
      outro: "確認連結 7 天內有效。如果您沒有申請訂閱，請忽略這封信，我們不會再寄信給您。",
    },
    welcome: {
      subject: "訂閱完成：Miyama Capital 研究",
      intro: "{name} 您好，\n\n您的訂閱已完成。我們會不定期將研究報告（PDF）寄到這個信箱。",
      outro: "Miyama Capital 目前僅管理自有資本，不接受外部資金。研究內容為一般性分析，不構成投資建議。",
    },
    already: {
      subject: "您已訂閱 Miyama Capital 研究",
      intro: "{name} 您好，\n\n這個信箱已經在我們的訂閱名單中，不需要再次訂閱。",
      outro: "",
    },
    unsubscribePage: { question: "要取消 {email} 對 Miyama Capital 研究的訂閱嗎？", button: "確認取消訂閱", keep: "保留訂閱，回到網站" },
    footer: {
      why: "您收到這封信，是因為這個信箱曾在 www.miyamacap.com 訂閱 Miyama Capital 的研究。",
      unsubscribe: "取消訂閱",
      privacy: "隱私權政策",
    },
  },
  en: {
    confirm: {
      subject: "Confirm your subscription to Miyama Capital research",
      intro: "Hi {name},\n\nThanks for subscribing to Miyama Capital research. Please confirm your email address with the link below; we will only send reports after you confirm.",
      action: "Confirm subscription",
      outro: "The link is valid for 7 days. If you did not request this, ignore this email and we will not write again.",
    },
    welcome: {
      subject: "You're subscribed: Miyama Capital research",
      intro: "Hi {name},\n\nYour subscription is confirmed. We will send research reports (PDF) to this address from time to time.",
      outro: "Miyama Capital manages proprietary capital only and does not accept outside funds. Our research is general analysis and not investment advice.",
    },
    already: {
      subject: "You are already subscribed to Miyama Capital research",
      intro: "Hi {name},\n\nThis address is already on our list, so there is nothing more to do.",
      outro: "",
    },
    unsubscribePage: { question: "Unsubscribe {email} from Miyama Capital research?", button: "Yes, unsubscribe", keep: "Keep my subscription and return to the site" },
    footer: {
      why: "You are receiving this email because this address subscribed to Miyama Capital research at www.miyamacap.com.",
      unsubscribe: "Unsubscribe",
      privacy: "Privacy policy",
    },
  },
  ja: {
    confirm: {
      subject: "Miyama Capital リサーチの購読をご確認ください",
      intro: "{name} 様\n\nMiyama Capital のリサーチをご購読いただきありがとうございます。下のリンクからメールアドレスをご確認ください。確認後にレポートをお送りします。",
      action: "購読を確認する",
      outro: "このリンクは 7 日間有効です。お心当たりがない場合は、このメールを無視してください。以後メールをお送りすることはありません。",
    },
    welcome: {
      subject: "購読が完了しました：Miyama Capital リサーチ",
      intro: "{name} 様\n\n購読が完了しました。リサーチレポート（PDF）を不定期でこのアドレスにお送りします。",
      outro: "Miyama Capital は自己資本のみを運用しており、外部資金は受け付けておりません。リサーチは一般的な分析であり、投資助言ではありません。",
    },
    already: {
      subject: "すでに Miyama Capital リサーチをご購読中です",
      intro: "{name} 様\n\nこのアドレスはすでに購読リストに登録されています。追加の手続きは不要です。",
      outro: "",
    },
    unsubscribePage: { question: "{email} の Miyama Capital リサーチの購読を解除しますか？", button: "購読を解除する", keep: "購読を続けてサイトに戻る" },
    footer: {
      why: "このメールは、www.miyamacap.com で Miyama Capital のリサーチを購読されたアドレス宛にお送りしています。",
      unsubscribe: "購読を解除する",
      privacy: "プライバシーポリシー",
    },
  },
};

function buildEmail(kind, record, options) {
  var lang = normalizeLang(record.lang);
  var t = TEMPLATES[lang];
  var settings = getSettings();
  var name = displayName(record);
  var privacyUrl = settings.siteOrigin + "/" + siteLangPath(lang) + "/privacy.html";
  var unsubUrl = unsubscribeUrl(record);

  var subject, introText, actionUrl = "", actionLabel = "", outroText, bodyText = "";
  if (kind === "campaign") {
    subject = options.subject;
    bodyText = String(options.body || "").replace(/\{\{\s*name\s*\}\}/g, name);
    introText = "";
    outroText = "";
  } else {
    var tpl = t[kind];
    subject = tpl.subject;
    introText = tpl.intro.replace("{name}", name);
    outroText = tpl.outro;
    if (kind === "confirm") { actionUrl = confirmUrl(record); actionLabel = tpl.action; }
  }

  var textParts = [];
  if (introText) textParts.push(introText);
  if (bodyText) textParts.push(bodyText);
  if (actionUrl) textParts.push(actionLabel + ":\n" + actionUrl);
  if (outroText) textParts.push(outroText);
  textParts.push("—\n" + t.footer.why + "\n" + t.footer.unsubscribe + ": " + unsubUrl + "\n" + t.footer.privacy + ": " + privacyUrl + "\nMiyama Capital LLC · " + settings.postalAddress);
  var text = textParts.join("\n\n");

  var para = function (s) { return "<p style=\"margin:0 0 16px;line-height:1.65\">" + escapeHtml(s).replace(/\n/g, "<br>") + "</p>"; };
  var htmlParts = [];
  if (introText) htmlParts.push(para(introText));
  if (bodyText) htmlParts.push(para(bodyText));
  if (actionUrl) htmlParts.push('<p style="margin:0 0 24px"><a href="' + escapeHtml(actionUrl) + '" style="display:inline-block;padding:12px 22px;background:#4F46E5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">' + escapeHtml(actionLabel) + '</a><br><span style="font-size:12px;color:#64748B">' + escapeHtml(actionUrl) + "</span></p>");
  if (outroText) htmlParts.push(para(outroText));
  htmlParts.push('<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #E2E8F0;font-size:12px;color:#64748B;line-height:1.6">' +
    escapeHtml(t.footer.why) + "<br>" +
    '<a href="' + escapeHtml(unsubUrl) + '" style="color:#64748B">' + escapeHtml(t.footer.unsubscribe) + "</a> · " +
    '<a href="' + escapeHtml(privacyUrl) + '" style="color:#64748B">' + escapeHtml(t.footer.privacy) + "</a><br>" +
    "Miyama Capital LLC · " + escapeHtml(settings.postalAddress) + "</p>");
  var html = '<div style="font-family:Inter,-apple-system,Segoe UI,Helvetica,Arial,\'Noto Sans TC\',\'Noto Sans JP\',sans-serif;font-size:16px;color:#0F172A;max-width:600px;margin:0 auto;padding:24px">' +
    '<p style="margin:0 0 24px;font-weight:800;font-size:18px">Miyama Capital</p>' + htmlParts.join("") + "</div>";

  return { subject: subject, text: text, html: html };
}

function sendMail(to, mail, attachments) {
  var settings = requireMailSettings();
  var options = { name: settings.fromName, replyTo: settings.replyTo, htmlBody: mail.html };
  if (settings.sender) options.from = settings.sender;
  if (attachments && attachments.length) options.attachments = attachments;
  GmailApp.sendEmail(to, mail.subject, mail.text, options);
}

function sendTemplate(kind, record) {
  sendMail(record.email, buildEmail(kind, record));
}

// ---------------------------------------------------------------------------
// Campaigns (menu-driven)
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Miyama 訂閱")
    .addItem("寄測試信給自己（選取的 Campaign 列）", "sendSelectedCampaignTest")
    .addItem("寄出給訂閱者（選取的 Campaign 列）", "sendSelectedCampaign")
    .addSeparator()
    .addItem("建立／檢查工作表與設定", "setup")
    .addItem("清理逾期未確認的申請（30 天）", "purgeExpiredPending")
    .addToUi();
}

function setup() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", active.getId());
  if (!PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID")) {
    var missingSheet = "請先從綁定的 Google Sheet 開啟 Apps Script 並執行 setup，以儲存 SPREADSHEET_ID。";
    try { SpreadsheetApp.getUi().alert(missingSheet); } catch (noUi) { Logger.log(missingSheet); }
    return missingSheet;
  }
  getSheet(CONFIG.SHEET_SUBSCRIBERS, SUBSCRIBER_COLUMNS);
  getSheet(CONFIG.SHEET_CAMPAIGNS, CAMPAIGN_COLUMNS);
  getSheet(CONFIG.SHEET_LOG, LOG_COLUMNS);
  var s = getSettings();
  var problems = [];
  if (!String(s.postalAddress).trim()) problems.push("缺 POSTAL_ADDRESS");
  if (!s.webAppUrl) problems.push("缺 WEB_APP_URL（部署後的 /exec 網址）");
  else if (!isWebAppUrl(s.webAppUrl)) problems.push("WEB_APP_URL 應是部署後以 /exec 結尾的網頁應用程式網址（https://script.google.com/macros/s/…/exec 或 https://script.google.com/a/macros/<網域>/s/…/exec）");
  if (!s.reportsFolderId) problems.push("缺 REPORTS_FOLDER_ID（寄報告時需要）");
  if (s.sender) {
    var aliases = [];
    try { aliases = GmailApp.getAliases(); } catch (err) { aliases = []; }
    if (aliases.indexOf(s.sender) < 0) problems.push("SENDER " + s.sender + " 不在 Gmail 的「以這個地址寄送郵件」別名清單中，寄信會失敗");
  }
  if (s.alertEmail && !normalizeEmail(s.alertEmail)) problems.push("ALERT_EMAIL " + s.alertEmail + " 不是有效的電子郵件，錯誤通知會改寄給部署帳號");
  var msg = "工作表已就緒。" + (problems.length ? "\n請處理：\n- " + problems.join("\n- ") : "\n設定已齊全。");
  try { msg += "\n錯誤通知會寄到：" + alertRecipient() + "（每小時最多一封）。"; } catch (ignore) {}
  try { SpreadsheetApp.getUi().alert(msg); } catch (noUi) { Logger.log(msg); }
  return msg;
}

function selectedCampaign() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (sheet.getName() !== CONFIG.SHEET_CAMPAIGNS) throw new Error("請先切換到 " + CONFIG.SHEET_CAMPAIGNS + " 工作表並選取一列。");
  var rowIndex = sheet.getActiveRange().getRow();
  if (rowIndex < 2) throw new Error("請選取標題列以下的一列。");
  var values = sheet.getRange(rowIndex, 1, 1, CAMPAIGN_COLUMNS.length).getValues()[0];
  var campaign = { _row: rowIndex };
  CAMPAIGN_COLUMNS.forEach(function (col, i) { campaign[col] = values[i]; });
  if (!campaign.id || !campaign.subject || !campaign.pdf_name) throw new Error("id、subject、pdf_name 都要填。");
  var lang = String(campaign.lang || "all").trim().toLowerCase();
  if (["all", "zh", "en", "ja", "jp"].indexOf(lang) < 0) throw new Error("lang 只能是 all、zh、en 或 ja（目前是「" + campaign.lang + "」）。");
  campaign.lang = lang;
  return campaign;
}

function findReportBlob(pdfName) {
  var settings = getSettings();
  if (!settings.reportsFolderId) throw new Error("請先設定 Script property REPORTS_FOLDER_ID。");
  var files = DriveApp.getFolderById(settings.reportsFolderId).getFilesByName(String(pdfName).trim());
  if (!files.hasNext()) throw new Error("資料夾裡找不到檔案：" + pdfName);
  var file = files.next();
  if (files.hasNext()) throw new Error("資料夾裡有多個同名檔案：" + pdfName);
  return file.getBlob();
}

function sendSelectedCampaignTest() {
  var campaign = selectedCampaign();
  var me = Session.getEffectiveUser().getEmail();
  var record = { email: me, name: "Test", lang: campaign.lang === "all" || !campaign.lang ? "en" : campaign.lang, unsub_token: "test" };
  sendMail(me, buildEmail("campaign", record, { subject: "[TEST] " + campaign.subject, body: campaign.body }), [findReportBlob(campaign.pdf_name)]);
  SpreadsheetApp.getUi().alert("測試信已寄到 " + me);
}

function sendSelectedCampaign() {
  var campaign = selectedCampaign();
  var ui = SpreadsheetApp.getUi();
  var confirm = ui.alert("確認寄出", "要把「" + campaign.subject + "」寄給所有已確認的訂閱者嗎？\n（語言：" + (campaign.lang || "all") + "）", ui.ButtonSet.OK_CANCEL);
  if (confirm !== ui.Button.OK) return;
  var summary = sendCampaign(campaign);
  ui.alert(summary);
}

// Keep only lease bookkeeping under ScriptLock. Holding it while mailing would
// prevent subscription confirmations and unsubscribes during a campaign run.
function claimCampaignRun(id) {
  return withLock(function () {
    var props = PropertiesService.getScriptProperties();
    var leases;
    try { leases = JSON.parse(props.getProperty("CAMPAIGN_RUNS") || "{}"); } catch (err) { leases = {}; }
    var key = "$" + String(id);
    if (leases[key] && leases[key].expires > Date.now()) return "";
    var token = newToken();
    // Longer than Apps Script's six-minute execution limit; a killed run can
    // resume after this lease expires instead of leaving a permanent lock.
    leases[key] = { token: token, expires: Date.now() + 10 * 60 * 1000 };
    props.setProperty("CAMPAIGN_RUNS", JSON.stringify(leases));
    return token;
  });
}

function releaseCampaignRun(id, token) {
  withLock(function () {
    var props = PropertiesService.getScriptProperties();
    var leases;
    try { leases = JSON.parse(props.getProperty("CAMPAIGN_RUNS") || "{}"); } catch (err) { leases = {}; }
    var key = "$" + String(id);
    if (leases[key] && leases[key].token === token) {
      delete leases[key];
      props.setProperty("CAMPAIGN_RUNS", JSON.stringify(leases));
    }
  });
}

/** Sends one campaign; sequential retries skip sent recipients, overlapping runs wait. */
function sendCampaign(campaign) {
  var lease = claimCampaignRun(campaign.id);
  if (!lease) return "這份報告正在寄送中，請等目前的執行完成後再試。";
  try { return runCampaign(campaign); }
  finally { releaseCampaignRun(campaign.id, lease); }
}

function runCampaign(campaign) {
  var started = Date.now();
  var blob = findReportBlob(campaign.pdf_name);
  var campaignLang = String(campaign.lang || "all").trim().toLowerCase();
  var subSheet = getSheet(CONFIG.SHEET_SUBSCRIBERS, SUBSCRIBER_COLUMNS);
  var subscribers = readRows(subSheet, SUBSCRIBER_COLUMNS)
    .filter(function (r) { return r.status === "confirmed" && (campaignLang === "all" || normalizeLang(r.lang) === normalizeLang(campaignLang)); });
  var logSheet = getSheet(CONFIG.SHEET_LOG, LOG_COLUMNS);
  var alreadySent = {};
  readRows(logSheet, LOG_COLUMNS).forEach(function (l) {
    if (String(l.campaign_id) === String(campaign.id) && l.result === "sent") alreadySent[String(l.email).toLowerCase()] = true;
  });

  var campaignSheet = getSheet(CONFIG.SHEET_CAMPAIGNS, CAMPAIGN_COLUMNS);
  var statusCol = SUBSCRIBER_COLUMNS.indexOf("status") + 1;
  var sent = 0, skipped = 0, failed = 0, stoppedReason = "";
  for (var i = 0; i < subscribers.length; i++) {
    var r = subscribers[i];
    if (alreadySent[String(r.email).toLowerCase()]) { skipped++; continue; }
    if (MailApp.getRemainingDailyQuota() <= CONFIG.QUOTA_RESERVE) { stoppedReason = "今日寄信額度快用完"; break; }
    if (Date.now() - started > CONFIG.RUN_BUDGET_MS) { stoppedReason = "單次執行時間到"; break; }
    // Someone who unsubscribed while this run is in progress is skipped.
    if (subSheet.getRange(r._row, statusCol).getValue() !== "confirmed") { skipped++; continue; }
    try {
      sendMail(r.email, buildEmail("campaign", r, { subject: campaign.subject, body: campaign.body }), [blob]);
      logEvent(campaign.id, r.email, "sent", "");
      sent++;
    } catch (err) {
      logEvent(campaign.id, r.email, "failed", String(err && err.message || err));
      failed++;
    }
  }
  // Failed recipients are still outstanding and must remain retryable.
  var remaining = subscribers.length - skipped - sent;
  var status = remaining > 0 ? "sending" : "sent";
  campaignSheet.getRange(campaign._row, CAMPAIGN_COLUMNS.indexOf("status") + 1, 1, 3)
    .setValues([[status, new Date().toISOString(), skipped + sent]]);
  var summary = "本次寄出 " + sent + " 封，略過已寄 " + skipped + " 封，失敗 " + failed + " 封。";
  if (remaining > 0) summary += "\n還有 " + remaining + " 位未寄" + (stoppedReason ? "（" + stoppedReason + "）" : "") + "，回到 Campaigns 選取同一列，再執行一次「寄出給訂閱者」即可接續。";
  return summary;
}
