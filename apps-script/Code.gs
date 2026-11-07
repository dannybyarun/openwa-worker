/**
 * OpenWA Worker → Google Sheets drainer.
 *
 * The gateway holds no socket in lazy mode. This script is the "always-on" half:
 * a time-driven trigger wakes each session for a few seconds, pulls new messages with a cursor,
 * writes them to the Inbox sheet, acks the cursor, flushes the Outbox sheet, then closes the socket.
 *
 * Setup: see apps-script/README.md. Edit CONFIG, run installTrigger() once.
 */

const CONFIG = {
  WORKER_URL: 'https://openwa-worker.YOUR-SUBDOMAIN.workers.dev',
  API_TOKEN: '', // same value as `wrangler secret put API_TOKEN` (leave '' when unset)
  SESSIONS: ['ledger'], // session names created in the worker
  WAKE_WAIT_MS: 8000, // how long /wake may block waiting for the WhatsApp socket
  EMPTY_PULL_SLEEP_MS: 1500, // one extra pull after a wake, to catch offline-queued messages
  POLL_MINUTES: 15, // 1 | 5 | 10 | 15 | 30 — see the runtime budget in README.md
  PAGE_SIZE: 100, // messages per /messages page (max 200)
  MAX_PAGES: 5, // per session per run
  MAX_SEND_ATTEMPTS: 3,
  SEEN_LIMIT: 1000, // msg ids read back from Inbox for crash-safe dedupe
  INBOX_SHEET: 'Inbox',
  OUTBOX_SHEET: 'Outbox',
};

const HEADERS_ = {
  inbox: ['msg_id', 'drained_at', 'sent_at', 'session', 'chat_id', 'from_me', 'sender', 'push_name', 'type', 'text', 'seq'],
  outbox: ['id', 'session', 'chat_id', 'body', 'status', 'attempts', 'last_error', 'next_try_at'],
};

/** Run once manually. Creates (or replaces) the drainAll time trigger. */
function installTrigger() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'drainAll') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('drainAll').timeBased().everyMinutes(CONFIG.POLL_MINUTES).create();
  console.log('drainAll scheduled every ' + CONFIG.POLL_MINUTES + ' min');
}

/** Optional spreadsheet menu (this script must be bound to the ledger sheet). */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('OpenWA')
    .addItem('Drain now', 'drainAll')
    .addItem('Install/replace trigger', 'installTrigger')
    .addItem('Export XLSX', 'exportXlsx')
    .addToUi();
}

/**
 * Main entry point. Processes every session sequentially under one lock. Runtime per run is
 * roughly SESSIONS × (wake + pull + outbox), so keep it well under the 6-minute execution limit.
 */
function drainAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('another drain is running — skipping');
    return;
  }
  try {
    setupSheets_();
    for (const session of CONFIG.SESSIONS) {
      try {
        drainSession_(session);
      } catch (err) {
        console.error('[' + session + '] ' + (err && err.stack ? err.stack : err));
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function drainSession_(session) {
  const props = PropertiesService.getScriptProperties();
  const cursorKey = 'cursor:' + session;
  let cursor = Number(props.getProperty(cursorKey) || 0);

  try {
    wake_(session);
  } catch (err) {
    // 429 = daily wake budget exhausted; the worker resets at 00:00 UTC.
    if (err.status === 429) {
      console.warn('[' + session + '] wake limit reached, waiting for 00:00 UTC');
      return;
    }
    throw err;
  }

  let appended = 0;
  try {
    const inbox = sheet_(CONFIG.INBOX_SHEET);
    const seen = seenIds_(inbox, CONFIG.SEEN_LIMIT);

    for (let page = 0; page < CONFIG.MAX_PAGES; page += 1) {
      const payload = api_(
        '/api/sessions/' + encodeURIComponent(session) +
          '/messages?after=' + cursor + '&limit=' + CONFIG.PAGE_SIZE
      );
      const messages = payload.messages || [];

      // WhatsApp delivers its offline queue just after the socket opens. If the first pull is
      // empty, wait once and pull again before deciding there is nothing to do.
      if (messages.length === 0 && page === 0 && CONFIG.EMPTY_PULL_SLEEP_MS > 0) {
        Utilities.sleep(CONFIG.EMPTY_PULL_SLEEP_MS);
        continue;
      }

      const fresh = messages.filter(m => !seen.has(String(m.id || '')));

      if (fresh.length) {
        const rows = fresh.map(m => messageRow_(session, m));
        inbox.getRange(inbox.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
        fresh.forEach(m => seen.add(String(m.id || '')));
        appended += fresh.length;
      }

      const next = Number(payload.nextCursor);
      if (Number.isFinite(next)) cursor = Math.max(cursor, next);
      props.setProperty(cursorKey, String(cursor));

      if (!payload.hasMore || messages.length === 0) break;
    }

    // Ack only after the rows are committed to the sheet. If this throws, the next run
    // re-reads the same range and the seen-set dedupes the overlap.
    ack_(session, cursor);
    sendOutbox_(session);

    console.log('[' + session + '] cursor=' + cursor + ' appended=' + appended);
  } finally {
    // Close immediately: the Durable Object should bill seconds per run, not a full minute.
    try {
      idle_(session);
    } catch (err) {
      console.warn('[' + session + '] idle failed: ' + err);
    }
  }
}

/** Scan the Outbox sheet and send pending rows for one session. */
function sendOutbox_(session) {
  const outbox = sheet_(CONFIG.OUTBOX_SHEET);
  const last = outbox.getLastRow();
  if (last < 2) return;

  const width = HEADERS_.outbox.length;
  const values = outbox.getRange(2, 1, last - 1, width).getValues();
  const now = Date.now();

  for (let i = 0; i < values.length; i += 1) {
    const row = values[i];
    const id = row[0];
    const rowSession = String(row[1] || '');
    const chatId = String(row[2] || '');
    const body = String(row[3] || '');
    const status = String(row[4] || '');
    const attempts = Number(row[5] || 0);
    const nextTryAt = row[7];

    if (rowSession !== session || status !== 'pending') continue;
    if (!chatId || !body) continue;
    if (nextTryAt && new Date(nextTryAt).getTime() > now) continue;

    try {
      const sent = api_('/api/sessions/' + encodeURIComponent(session) + '/send-text', {
        method: 'post',
        body: { chatId: chatId, text: body },
      });
      outbox.getRange(i + 2, 5, 1, 4).setValues([['sent', attempts + 1, '', '']]);
      console.log('[' + session + '] sent ' + id + ' → ' + sent.id);
    } catch (err) {
      const tries = attempts + 1;
      const final = tries >= CONFIG.MAX_SEND_ATTEMPTS;
      const retryAt = final ? '' : new Date(now + Math.min(3600, 60 * Math.pow(2, tries)) * 1000);
      outbox.getRange(i + 2, 5, 1, 4).setValues([[
        final ? 'failed' : 'pending',
        tries,
        String(err.message || err).slice(0, 300),
        retryAt,
      ]]);
      console.warn('[' + session + '] send ' + id + ' failed (' + tries + '): ' + err);
    }
  }
}

/* ---------- worker calls ---------- */

function wake_(session) {
  return api_(
    '/api/sessions/' + encodeURIComponent(session) + '/wake?wait=' + CONFIG.WAKE_WAIT_MS,
    { method: 'post' }
  );
}

function ack_(session, upto) {
  return api_('/api/sessions/' + encodeURIComponent(session) + '/ack', {
    method: 'post',
    body: { upto: upto },
  });
}

function idle_(session) {
  return api_('/api/sessions/' + encodeURIComponent(session) + '/idle', { method: 'post' });
}

function api_(path, options) {
  options = options || {};
  const headers = Object.assign({}, options.headers || {});
  if (CONFIG.API_TOKEN) headers['x-api-key'] = CONFIG.API_TOKEN;

  const res = UrlFetchApp.fetch(String(CONFIG.WORKER_URL).replace(/\/+$/, '') + path, {
    method: options.method || 'get',
    contentType: options.body ? 'application/json' : undefined,
    headers: headers,
    payload: options.body ? JSON.stringify(options.body) : undefined,
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = { raw: text };
  }
  if (code < 200 || code >= 300) {
    const message = 'HTTP ' + code + ' ' + path + ': ' + ((data && data.error) || text);
    const error = new Error(message.slice(0, 300));
    error.status = code;
    throw error;
  }
  return data;
}

/* ---------- sheets ---------- */

function setupSheets_() {
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, CONFIG.INBOX_SHEET, HEADERS_.inbox);
  ensureSheet_(ss, CONFIG.OUTBOX_SHEET, HEADERS_.outbox);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function sheet_(name) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('missing sheet "' + name + '" — run setupSheets_() first');
  return sheet;
}

function seenIds_(sheet, limit) {
  const seen = new Set();
  const last = sheet.getLastRow();
  if (last < 2) return seen;
  const start = Math.max(2, last - limit + 1);
  const values = sheet.getRange(start, 1, last - start + 1, 1).getValues();
  for (const row of values) if (row[0]) seen.add(String(row[0]));
  return seen;
}

function messageRow_(session, m) {
  return [
    safeCell_(m.id),
    new Date().toISOString(),
    m.timestamp ? String(m.timestamp) : '',
    session,
    safeCell_(m.chatId),
    m.fromMe === true,
    safeCell_(m.sender),
    safeCell_(m.pushName),
    safeCell_(m.type),
    safeCell_(m.text),
    Number(m.seq || 0),
  ];
}

/**
 * Untrusted WhatsApp text must never be stored as a live formula. setValue/appendRow evaluate
 * leading "=" (and Sheets may treat +, -, @ the same way in some locales), so escape those values.
 */
function safeCell_(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

/** Manual/scheduled export of the whole ledger to a real .xlsx file in Drive. */
function exportXlsx() {
  const ss = SpreadsheetApp.getActive();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd-HHmm');
  const blob = DriveApp.getFileById(ss.getId())
    .getAs('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .setName('openwa-ledger-' + stamp + '.xlsx');
  const file = DriveApp.createFile(blob);
  console.log('exported ' + file.getUrl());
  return file.getUrl();
}
