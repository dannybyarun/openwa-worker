/**
 * OpenWA Worker → Google Sheets drainer.
 *
 * The gateway holds no socket in lazy mode. This script is the "always-on" half:
 * a time-driven trigger wakes each session for a few seconds, pulls new messages with a cursor,
 * writes them to the Inbox sheet, acks the cursor, flushes the Outbox sheet, then closes the socket.
 *
 * Configuration lives in Script Properties, not in this file: run `setup()` from the OpenWA menu
 * (or Project Settings → Script properties) once. The CONFIG object below is only a fallback for
 * older deployments that edited the file directly; properties always win.
 *
 * Setup notes: apps-script/README.md.
 */

const CONFIG = {
  WORKER_URL: '',
  API_TOKEN: '',
  SESSIONS: [],
  WAKE_WAIT_MS: 8000, // how long /wake may block waiting for the WhatsApp socket
  EMPTY_PULL_SLEEP_MS: 1500, // one extra pull after a wake, to catch offline-queued messages
  POLL_MINUTES: 5, // 1 | 5 | 10 | 15 | 30 — see the runtime budget in README.md
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

let CONFIG_CACHE_ = null;

/* ---------- configuration ---------- */

/**
 * Reads Script Properties over the defaults above. Project Settings → Script properties keys:
 *   OPENWA_URL            https://wa.example.com            (required)
 *   OPENWA_TOKEN          API token / password              (blank when the worker has none)
 *   OPENWA_SESSION        the session to drain               (required-ish)
 *   OPENWA_SESSIONS       a comma-separated list (wins over OPENWA_SESSION)
 *   OPENWA_POLL_MINUTES   1 | 5 | 10 | 15 | 30
 *   OPENWA_INBOX_SHEET    Inbox
 *   OPENWA_OUTBOX_SHEET   Outbox
 */
function config_() {
  if (CONFIG_CACHE_) return CONFIG_CACHE_;
  const props = PropertiesService.getScriptProperties();
  const read = (key, fallback) => {
    const value = props.getProperty(key);
    return value === null || value === '' ? fallback : value;
  };
  const sessionsRaw = read('OPENWA_SESSIONS', read('OPENWA_SESSION', (CONFIG.SESSIONS || []).join(',')));
  const sessions = String(sessionsRaw)
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  const cfg = {
    WORKER_URL: String(read('OPENWA_URL', CONFIG.WORKER_URL || '')).replace(/\/+$/, ''),
    API_TOKEN: read('OPENWA_TOKEN', CONFIG.API_TOKEN || ''),
    SESSIONS: sessions,
    WAKE_WAIT_MS: Number(read('OPENWA_WAKE_WAIT_MS', CONFIG.WAKE_WAIT_MS)),
    EMPTY_PULL_SLEEP_MS: Number(read('OPENWA_EMPTY_PULL_SLEEP_MS', CONFIG.EMPTY_PULL_SLEEP_MS)),
    POLL_MINUTES: Number(read('OPENWA_POLL_MINUTES', CONFIG.POLL_MINUTES)),
    PAGE_SIZE: Number(read('OPENWA_PAGE_SIZE', CONFIG.PAGE_SIZE)),
    MAX_PAGES: Number(read('OPENWA_MAX_PAGES', CONFIG.MAX_PAGES)),
    MAX_SEND_ATTEMPTS: Number(read('OPENWA_MAX_SEND_ATTEMPTS', CONFIG.MAX_SEND_ATTEMPTS)),
    SEEN_LIMIT: Number(read('OPENWA_SEEN_LIMIT', CONFIG.SEEN_LIMIT)),
    INBOX_SHEET: read('OPENWA_INBOX_SHEET', CONFIG.INBOX_SHEET),
    OUTBOX_SHEET: read('OPENWA_OUTBOX_SHEET', CONFIG.OUTBOX_SHEET),
  };
  if (!cfg.WORKER_URL) {
    throw new Error('OPENWA_URL is not set — run OpenWA → Setup in the sheet menu.');
  }
  if (cfg.SESSIONS.length === 0) {
    throw new Error('OPENWA_SESSION is not set — run OpenWA → Setup in the sheet menu.');
  }
  CONFIG_CACHE_ = cfg;
  return cfg;
}

/** Runs every script invocation after a property change. */
function resetConfigCache_() {
  CONFIG_CACHE_ = null;
}

/**
 * One-time interactive setup. Prompts for the worker URL, token, session and poll interval,
 * stores them in Script Properties, creates the Inbox/Outbox sheets, installs the trigger and
 * checks the connection. Re-run it whenever the worker or session changes.
 */
function setup() {
  const ui = SpreadsheetApp.getUi();
  const ask = (title, text, fallback) => {
    const answer = ui.prompt(title, text, ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return null;
    const value = String(answer.getResponseText() || '').trim();
    return value || fallback || '';
  };

  const current = configSafe_();
  const url = ask(
    'Worker URL',
    'The deployed worker origin, e.g. https://wa.example.com',
    current.WORKER_URL
  );
  if (url === null) return 'cancelled';

  const token = ask(
    'API token',
    'The worker API_TOKEN / UI password. Leave blank if the worker has no password.',
    current.API_TOKEN
  );
  if (token === null) return 'cancelled';

  const sessions = ask(
    'Session(s)',
    'Session name(s) to drain, comma-separated, e.g. ledger or ledger,personal',
    current.SESSIONS.join(',')
  );
  if (sessions === null) return 'cancelled';

  const minutes = ask(
    'Poll interval (minutes)',
    'How often to drain: 1, 5, 10, 15 or 30.',
    String(current.POLL_MINUTES || 5)
  );
  if (minutes === null) return 'cancelled';

  PropertiesService.getScriptProperties().setProperties(
    {
      OPENWA_URL: url,
      OPENWA_TOKEN: token,
      OPENWA_SESSIONS: sessions,
      OPENWA_POLL_MINUTES: String(Number(minutes) || 5),
    },
    false
  );

  resetConfigCache_();
  setupSheets_();
  installTrigger();
  const report = testConnection();
  ui.alert('OpenWA is configured.\n\n' + report);
  return report;
}

/** config_() without throwing, for the setup prompts that must run before it is valid. */
function configSafe_() {
  try {
    return config_();
  } catch (err) {
    return CONFIG;
  }
}

/** Run once manually (setup does it too). Creates (or replaces) the drainAll time trigger. */
function installTrigger() {
  const cfg = config_();
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'drainAll') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('drainAll').timeBased().everyMinutes(cfg.POLL_MINUTES).create();
  console.log('drainAll scheduled every ' + cfg.POLL_MINUTES + ' min');
  return cfg.POLL_MINUTES;
}

/** Checks /health and the session list; returns a human-readable report (also logs it). */
function testConnection() {
  const cfg = config_();
  const health = api_('/health');
  const payload = api_('/api/sessions');
  const names = (payload.sessions || []).map(session => session.id);
  const missing = cfg.SESSIONS.filter(name => names.indexOf(name) === -1);
  const lines = [
    'Worker: ' + cfg.WORKER_URL,
    'Health: ' + (health && health.ok ? 'ok' : 'unexpected response'),
    'Sessions on the worker: ' + (names.length ? names.join(', ') : 'none'),
    'Draining: ' + cfg.SESSIONS.join(', '),
    'Poll interval: every ' + cfg.POLL_MINUTES + ' min',
  ];
  if (missing.length) {
    lines.push('WARNING: not found on the worker: ' + missing.join(', '));
  }
  const report = lines.join('\n');
  console.log(report);
  return report;
}

/** Optional spreadsheet menu (this script must be bound to the ledger sheet). */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('OpenWA')
    .addItem('Setup…', 'setup')
    .addItem('Drain now', 'drainAll')
    .addItem('Test connection', 'testConnection')
    .addSeparator()
    .addItem('Queue a message…', 'promptQueueMessage')
    .addItem('Install/replace trigger', 'installTrigger')
    .addItem('Export XLSX', 'exportXlsx')
    .addToUi();
}

/** Menu action: append a pending row to the Outbox sheet. */
function promptQueueMessage() {
  const ui = SpreadsheetApp.getUi();
  const cfg = config_();
  const session = ui.prompt('Session', cfg.SESSIONS.join(', '), ui.ButtonSet.OK_CANCEL);
  if (session.getSelectedButton() !== ui.Button.OK) return '';
  const chat = ui.prompt('Chat', 'Phone number or WhatsApp JID, e.g. 9779800000000', ui.ButtonSet.OK_CANCEL);
  if (chat.getSelectedButton() !== ui.Button.OK) return '';
  const body = ui.prompt('Message', 'The text to send.', ui.ButtonSet.OK_CANCEL);
  if (body.getSelectedButton() !== ui.Button.OK) return '';
  return enqueueMessage(
    String(session.getResponseText() || '').trim() || cfg.SESSIONS[0],
    String(chat.getResponseText() || '').trim(),
    String(body.getResponseText() || '')
  );
}

/**
 * Appends one message to the Outbox sheet. Callable from the menu, a button, or another script.
 * The next drain (or the trigger) sends it.
 */
function enqueueMessage(session, chatId, body) {
  const cfg = config_();
  setupSheets_();
  const outbox = sheet_(cfg.OUTBOX_SHEET);
  if (!session || !chatId || !body) throw new Error('session, chatId and body are required');
  const id = Utilities.getUuid();
  outbox.appendRow([id, session, chatId, safeCell_(body), 'pending', 0, '', '']);
  console.log('queued ' + id + ' for ' + session + ' → ' + chatId);
  return id;
}

/**
 * Main entry point. Processes every session sequentially under one lock. Runtime per run is
 * roughly SESSIONS × (wake + pull + outbox), so keep it well under the 6-minute execution limit.
 */
function drainAll() {
  let cfg;
  try {
    cfg = config_();
  } catch (err) {
    console.error(String((err && err.message) || err));
    return;
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('another drain is running — skipping');
    return;
  }
  try {
    setupSheets_();
    for (const session of cfg.SESSIONS) {
      try {
        drainSession_(session, cfg);
      } catch (err) {
        console.error('[' + session + '] ' + (err && err.stack ? err.stack : err));
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function drainSession_(session, cfg) {
  const props = PropertiesService.getScriptProperties();
  const cursorKey = 'cursor:' + session;
  let cursor = Number(props.getProperty(cursorKey) || 0);

  try {
    wake_(session, cfg);
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
    const inbox = sheet_(cfg.INBOX_SHEET);
    const seen = seenIds_(inbox, cfg.SEEN_LIMIT);

    for (let page = 0; page < cfg.MAX_PAGES; page += 1) {
      const payload = api_(
        '/api/sessions/' + encodeURIComponent(session) +
          '/messages?after=' + cursor + '&limit=' + cfg.PAGE_SIZE
      );
      const messages = payload.messages || [];

      // WhatsApp delivers its offline queue just after the socket opens. If the first pull is
      // empty, wait once and pull again before deciding there is nothing to do.
      if (messages.length === 0 && page === 0 && cfg.EMPTY_PULL_SLEEP_MS > 0) {
        Utilities.sleep(cfg.EMPTY_PULL_SLEEP_MS);
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
    sendOutbox_(session, cfg);

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
function sendOutbox_(session, cfg) {
  const outbox = sheet_(cfg.OUTBOX_SHEET);
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
      const final = tries >= cfg.MAX_SEND_ATTEMPTS;
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

function wake_(session, cfg) {
  cfg = cfg || config_();
  return api_(
    '/api/sessions/' + encodeURIComponent(session) + '/wake?wait=' + cfg.WAKE_WAIT_MS,
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
  const cfg = config_();
  options = options || {};
  const headers = Object.assign({}, options.headers || {});
  if (cfg.API_TOKEN) headers['x-api-key'] = cfg.API_TOKEN;

  const res = UrlFetchApp.fetch(cfg.WORKER_URL + path, {
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
  const cfg = config_();
  const ss = SpreadsheetApp.getActive();
  ensureSheet_(ss, cfg.INBOX_SHEET, HEADERS_.inbox);
  ensureSheet_(ss, cfg.OUTBOX_SHEET, HEADERS_.outbox);
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
