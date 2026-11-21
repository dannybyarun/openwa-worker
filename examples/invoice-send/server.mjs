#!/usr/bin/env node
/**
 * A website backend that invoices customers over WhatsApp.
 *
 *   OPENWA_URL=https://wa.example.com \
 *   OPENWA_TOKEN=owa_… \
 *   PORT=3000 node server.mjs
 *
 * Then open http://localhost:3000/ and submit the form. The token stays on this server;
 * the browser never sees it. In production, put this behind your own login/CSRF checks.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildInvoicePdf } from './pdf.mjs';

const url = (process.env.OPENWA_URL ?? '').replace(/\/+$/, '');
const token = process.env.OPENWA_TOKEN ?? '';
const port = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 32 * 1024;

if (!url || !token) {
  console.error('Set OPENWA_URL and OPENWA_TOKEN (mint a `send` token in the dashboard).');
  process.exit(1);
}

const formPath = fileURLToPath(new URL('./form.html', import.meta.url));

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

/** Digits only: `+977 980-0000000` → `9779800000000`. */
function normalizePhone(value) {
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

async function invoice(request, response) {
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }

  const phone = normalizePhone(body.phone);
  if (!phone) return sendJson(response, 400, { error: 'a valid phone number is required' });

  const number = String(body.number ?? '').trim() || `INV-${Date.now().toString().slice(-6)}`;
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return sendJson(response, 400, { error: 'amount must be a positive number' });
  }
  const currency = String(body.currency ?? 'Rs').slice(0, 8);
  const customer = String(body.customer ?? 'Customer').slice(0, 120);

  const pdf = buildInvoicePdf({ number, customer, amount: amount.toFixed(2), currency });
  const caption = `Invoice ${number}\nAmount due: ${currency} ${amount.toFixed(2)}`;

  const upstream = await fetch(`${url}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      chatId: phone,
      text: caption,
      document: {
        fileName: `invoice-${number}.pdf`,
        mimetype: 'application/pdf',
        caption,
        base64: pdf.toString('base64'),
      },
    }),
  });
  const payload = await upstream.json().catch(() => ({}));

  if (!upstream.ok) {
    // 429 = daily send cap, 401/403 = token problem, 5xx = WhatsApp side.
    return sendJson(response, upstream.status, {
      error: payload.error ?? 'send failed',
      status: upstream.status,
    });
  }
  return sendJson(response, 200, { ok: true, id: payload.id, chatId: payload.chatId, number });
}

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && (path === '/' || path === '/form.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(formPath));
      return;
    }
    if (request.method === 'POST' && path === '/api/invoice') {
      await invoice(request, response);
      return;
    }
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Invoice demo on http://localhost:${port} → ${url}`);
});
