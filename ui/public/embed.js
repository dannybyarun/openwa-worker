/**
 * OpenWA website widget.
 *
 * Drop this on any site:
 *
 *   <script src="https://your-worker.example.com/embed.js"
 *           data-token="owa_..."
 *           data-title="Chat with us"
 *           async></script>
 *
 * The token is created in the OpenWA UI (Settings → Website widget) and is pinned to one
 * WhatsApp chat. It can only send — it cannot read your conversations — and is rate-limited
 * by the worker. Everything lives in a shadow root so the host page's CSS cannot break it.
 */
(function () {
  var script = document.currentScript;
  if (!script) {
    var candidates = document.querySelectorAll('script[data-token]');
    script = candidates[candidates.length - 1];
  }
  if (!script) return;

  var token = script.getAttribute('data-token');
  if (!token) {
    console.warn('[openwa] embed.js needs a data-token attribute');
    return;
  }

  var src = script.src || '';
  var base = (script.getAttribute('data-worker') || (src ? new URL(src).origin : location.origin)).replace(/\/+$/, '');
  var title = script.getAttribute('data-title') || 'Chat with us';
  var greeting = script.getAttribute('data-greeting') || 'Hi! Send us a message and we will reply on WhatsApp.';
  var accent = script.getAttribute('data-accent') || '#00a884';
  var side = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var dark = script.getAttribute('data-theme') === 'dark';
  var maxLength = 1000;

  var host = document.createElement('div');
  host.setAttribute('data-openwa-widget', '');
  var root = host.attachShadow({ mode: 'open' });

  var bg = dark ? '#111b21' : '#ffffff';
  var ink = dark ? '#e9edef' : '#111b21';
  var muted = dark ? '#8696a0' : '#667781';
  var line = dark ? '#2a3942' : '#e3e6e8';
  var panel2 = dark ? '#202c33' : '#f0f2f5';

  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:"Segoe UI",system-ui,-apple-system,sans-serif}',
    '.launcher{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;display:flex;align-items:center;gap:8px;',
    'border:0;border-radius:999px;padding:12px 18px;background:' + accent + ';color:#fff;font-size:14px;font-weight:600;',
    'cursor:pointer;box-shadow:0 8px 24px rgb(0 0 0 / .28)}',
    '.launcher:hover{filter:brightness(1.06)}',
    '.launcher svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
    '.panel{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483001;width:min(92vw,340px);max-height:min(78vh,520px);',
    'display:none;flex-direction:column;overflow:hidden;border-radius:16px;background:' + bg + ';color:' + ink + ';',
    'box-shadow:0 18px 48px rgb(0 0 0 / .35);border:1px solid ' + line + '}',
    '.panel.open{display:flex}',
    '.head{display:flex;align-items:center;gap:10px;padding:14px 14px 12px;background:' + accent + ';color:#fff}',
    '.head .dot{width:9px;height:9px;border-radius:999px;background:#fff;opacity:.85}',
    '.head .t{flex:1;min-width:0;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.head .s{font-size:11.5px;opacity:.85}',
    '.x{border:0;background:transparent;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:2px 4px}',
    '.body{flex:1;min-height:120px;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:' + panel2 + '}',
    '.msg{max-width:85%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:18px;white-space:pre-wrap;word-wrap:break-word}',
    '.msg.them{align-self:flex-start;background:' + bg + ';color:' + ink + ';border:1px solid ' + line + '}',
    '.msg.me{align-self:flex-end;background:' + accent + ';color:#fff}',
    '.msg.err{align-self:center;background:transparent;color:#ea4335;font-size:12px;text-align:center}',
    '.form{display:flex;gap:8px;align-items:flex-end;padding:10px;border-top:1px solid ' + line + ';background:' + bg + '}',
    'textarea{flex:1;min-height:40px;max-height:110px;resize:none;border:1px solid ' + line + ';border-radius:10px;',
    'padding:10px 11px;font-size:13px;line-height:18px;background:' + bg + ';color:' + ink + ';outline:none}',
    'textarea:focus{border-color:' + accent + '}',
    'button.send{border:0;border-radius:10px;padding:10px 14px;background:' + accent + ';color:#fff;font-size:13px;',
    'font-weight:600;cursor:pointer}',
    'button.send[disabled]{opacity:.55;cursor:default}',
    '.foot{padding:0 14px 10px;font-size:10.5px;color:' + muted + ';background:' + bg + '}',
    '</style>',
    '<button class="launcher" type="button" aria-label="Open chat">',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5a8.4 8.4 0 0 1-.9-3.9 8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 8.6 7.8Z"/></svg>',
    '<span>' + escapeHtml(title) + '</span>',
    '</button>',
    '<div class="panel" role="dialog" aria-label="' + escapeHtml(title) + '">',
    '<div class="head"><span class="dot"></span><div class="t">' + escapeHtml(title) + '</div><button class="x" type="button" aria-label="Close">×</button></div>',
    '<div class="body" aria-live="polite"></div>',
    '<form class="form"><textarea rows="1" maxlength="' + maxLength + '" placeholder="Type a message…" aria-label="Message"></textarea>',
    '<button class="send" type="submit">Send</button></form>',
    '<div class="foot">Powered by OpenWA · replies arrive on WhatsApp</div>',
    '</div>',
  ].join('');

  var launcher = root.querySelector('.launcher');
  var panel = root.querySelector('.panel');
  var close = root.querySelector('.x');
  var body = root.querySelector('.body');
  var form = root.querySelector('form');
  var input = root.querySelector('textarea');
  var send = root.querySelector('.send');
  var opened = false;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function addMessage(kind, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + kind;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  function openPanel() {
    opened = true;
    panel.classList.add('open');
    launcher.style.display = 'none';
    if (!body.childElementCount) addMessage('them', greeting);
    setTimeout(function () {
      input.focus();
    }, 30);
  }

  function closePanel() {
    opened = false;
    panel.classList.remove('open');
    launcher.style.display = 'flex';
  }

  launcher.addEventListener('click', openPanel);
  close.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (event) {
    if (opened && event.key === 'Escape') closePanel();
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    if (text.length > maxLength) text = text.slice(0, maxLength);

    send.disabled = true;
    addMessage('me', text);
    input.value = '';

    fetch(base + '/api/embed/send', {
      method: 'POST',
      mode: 'cors',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token, text: text }),
    })
      .then(function (res) {
        if (res.ok) return null;
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (payload) {
            var message = (payload && (payload.error || payload.message)) || 'Message failed (' + res.status + ')';
            throw new Error(message);
          });
      })
      .then(function () {
        addMessage('them', 'Delivered to WhatsApp. We will reply there.');
      })
      .catch(function (error) {
        addMessage('err', error && error.message ? error.message : 'Could not send. Please try again.');
      })
      .then(function () {
        send.disabled = false;
        input.focus();
      });
  });

  function mount() {
    document.body.appendChild(host);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
