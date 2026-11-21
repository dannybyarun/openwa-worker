#!/usr/bin/env node
/**
 * Drain the outbox. This is the process your cron / Task Scheduler / Cloudflare Cron Trigger runs.
 *
 *   OPENWA_URL=https://wa.example.com OPENWA_TOKEN=owa_… node run.mjs
 *   OPENWA_URL=… OPENWA_TOKEN=… node run.mjs --watch 60      # long-running (dev, systemd, pm2)
 *   node run.mjs --list                                      # inspect the queue
 *   node run.mjs --retry-failed                              # requeue permanent failures
 *
 * Exit codes: 0 = nothing failed, 1 = at least one message failed permanently, 2 = config/DB error.
 * Failures are also rows in the table, so a cron that only looks at the exit code still alerts.
 *
 * Note: `node:sqlite` prints an experimental warning on some Node versions; it is harmless.
 * Run with `node --no-warnings run.mjs` to silence it.
 */

import {
  DEFAULTS,
  drainOnce,
  listRows,
  nextAttemptAt,
  openOutbox,
  requeueFailed,
  stats,
} from './outbox.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = 'true';
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

function usage() {
  console.log(`Usage: node run.mjs [options]

  --url <origin>        worker origin (env OPENWA_URL)
  --token <owa_…>       send token (env OPENWA_TOKEN)
  --db <path>           outbox database (env OUTBOX_DB, default ./outbox.sqlite)
  --batch <n>           rows per drain (default ${DEFAULTS.batch})
  --max-attempts <n>    retries before a row becomes failed (default ${DEFAULTS.maxAttempts})
  --watch <seconds>     keep draining instead of running once
  --list                print the newest rows and exit
  --retry-failed        move failed rows back to queued, then drain (or combine with --list)
`);
}

async function main() {
  if (args.help) {
    usage();
    return 0;
  }

  const url = process.env.OPENWA_URL ?? args.url ?? '';
  const token = process.env.OPENWA_TOKEN ?? args.token ?? '';
  const dbPath = args.db ?? process.env.OUTBOX_DB ?? './outbox.sqlite';
  const batch = Number(args.batch ?? process.env.OUTBOX_BATCH ?? DEFAULTS.batch);
  const maxAttempts = Number(
    args['max-attempts'] ?? process.env.OUTBOX_MAX_ATTEMPTS ?? DEFAULTS.maxAttempts,
  );
  const watchSeconds = Number(args.watch ?? 0);

  let db;
  try {
    db = openOutbox(dbPath);
  } catch (error) {
    console.error(`cannot open ${dbPath}: ${error.message}`);
    return 2;
  }

  try {
    if (args['retry-failed']) {
      const requeued = requeueFailed(db);
      console.error(`requeued ${requeued} failed row(s)`);
    }

    if (args.list) {
      const rows = listRows(db, 25);
      if (rows.length === 0) console.log('outbox is empty');
      for (const row of rows) {
        const what = row.file_path ? `document ${row.file_name}` : `text ${JSON.stringify(row.text ?? '')}`;
        console.log(
          [
            row.id,
            row.status,
            `attempts=${row.attempts}`,
            row.chat_id,
            what,
            row.message_id ?? '',
            row.last_error ?? '',
          ].join('  '),
        );
      }
      console.log(JSON.stringify({ stats: stats(db), nextAttemptAt: nextAttemptAt(db) }, null, 2));
      return 0;
    }

    if (!url || !token) {
      console.error('Set OPENWA_URL and OPENWA_TOKEN (mint a `send` token in the dashboard).');
      return 2;
    }

    const drain = async () => {
      const summary = await drainOnce(db, {
        url,
        token,
        batch,
        maxAttempts,
        log: line => console.error(line),
      });
      console.log(JSON.stringify({ ...summary, stats: stats(db) }, null, 2));
      return summary;
    };

    if (watchSeconds > 0) {
      console.error(`draining every ${watchSeconds}s — Ctrl+C to stop`);
      for (;;) {
        try {
          await drain();
        } catch (error) {
          console.error(`drain failed: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, watchSeconds * 1000));
      }
    }

    const summary = await drain();
    return summary.failed > 0 ? 1 : 0;
  } finally {
    db.close();
  }
}

// Set the exit code instead of calling process.exit(): on Windows, exiting while libuv is still
// closing fetch/socket handles trips an assertion in Node. The event loop empties on its own.
main().then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(error);
    process.exitCode = 2;
  },
);
