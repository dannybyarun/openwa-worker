#!/usr/bin/env node
/**
 * Send an invoice PDF over WhatsApp with a `send` token.
 *
 *   OPENWA_URL=https://wa.example.com \
 *   OPENWA_TOKEN=owa_… \
 *   node send-invoice.mjs --phone 9779800000000 --amount 2500 --number INV-42
 *
 * Add `--file path/to/invoice.pdf` to send a real PDF instead of the built-in sample.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { buildInvoicePdf } from './pdf.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const url = (process.env.OPENWA_URL ?? args.url ?? '').replace(/\/+$/, '');
const token = process.env.OPENWA_TOKEN ?? args.token ?? '';
const chatId = args.chat ?? args.phone ?? '';

if (!url || !token || !chatId) {
  console.error(
    'Missing config. Set OPENWA_URL and OPENWA_TOKEN, and pass --phone (or --chat).\n' +
      '  OPENWA_URL=https://wa.example.com OPENWA_TOKEN=owa_… \\\n' +
      '    node send-invoice.mjs --phone 9779800000000 --amount 2500',
  );
  process.exit(1);
}

const number = args.number ?? `INV-${Date.now().toString().slice(-6)}`;
const customer = args.customer ?? 'Customer';
const amount = args.amount ?? '0.00';
const currency = args.currency ?? 'Rs';
const caption =
  args.caption ?? `Invoice ${number}\nAmount due: ${currency} ${amount}\nThank you!`;

const pdf = args.file
  ? await readFile(args.file)
  : buildInvoicePdf({ number, customer, amount, currency });

const fileName = args.file ? basename(args.file) : `invoice-${number}.pdf`;

const started = Date.now();
const response = await fetch(`${url}/api/send`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    token,
    chatId,
    text: caption,
    document: {
      fileName,
      mimetype: 'application/pdf',
      caption,
      base64: pdf.toString('base64'),
    },
  }),
});

const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Failed (${response.status}):`, body.error ?? response.statusText);
  process.exit(1);
}

console.log(`Sent ${fileName} (${(pdf.length / 1024).toFixed(1)} KB) in ${Date.now() - started} ms`);
console.log(`  message id: ${body.id}`);
console.log(`  chat:       ${body.chatId}`);
