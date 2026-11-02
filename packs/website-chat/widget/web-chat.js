/* Soot website chat, browser mode (channel-adapter §11.17).
 *
 * The product hosts this folder and embeds:
 *   <script src="/soot/web-chat.js" data-host="https://soot.example.com" data-binding="lohi-web"
 *           data-assertion-url="/api/soot/assertion" data-config='{"name":"Hỗ trợ","greeting":"…"}' async></script>
 *
 * It frames the same chat UI as the live-chat widget (frame.html next to this
 * file) and talks to the Soot host as the binding's sender through the SDK's
 * BrowserChannel. No secret enters the page: a signed-in visitor is proven by
 * a short-lived assertion the product's backend signs (data-assertion-url,
 * fetched same-origin with cookies; 204/401 means anonymous). Appearance
 * comes from data-config, never from the Soot host.
 */
(() => {
  const script = document.currentScript;
  const host = script?.dataset.host;
  const binding = script?.dataset.binding;
  if (!host || !/^https?:\/\//.test(host) || !binding || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(binding)) return;

  const here = new URL('.', script.src);
  const base = here.origin;
  const instances = window.SootWebChat ?? (window.SootWebChat = {});
  if (instances[binding]) return;

  let config = {};
  try { const parsed = JSON.parse(script.dataset.config || '{}'); if (parsed && typeof parsed === 'object') config = parsed; } catch {}
  const assertionURL = script.dataset.assertionUrl ? new URL(script.dataset.assertionUrl, location.href) : null;
  if (assertionURL && assertionURL.origin !== location.origin) return; // the product's own backend only

  const frame = document.createElement('iframe');
  const frameTitle = name => (document.documentElement.lang?.toLowerCase().startsWith('vi') ? 'Chat hỗ trợ' : 'Support chat') + (name ? ' · ' + name : '');
  frame.title = frameTitle(config.name);
  frame.src = `${new URL('frame.html', here)}?parent=${encodeURIComponent(location.origin)}`;
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  frame.referrerPolicy = 'no-referrer';
  frame.allow = 'clipboard-write';
  frame.loading = 'lazy';
  Object.assign(frame.style, { position: 'fixed', bottom: '16px', right: '16px', width: '80px', height: '80px', border: '0', zIndex: '2147483000', colorScheme: 'normal' });
  if (document.body) document.body.append(frame);
  else addEventListener('DOMContentLoaded', () => document.body.append(frame), { once: true });

  const nonce = crypto.randomUUID();
  let session = null;
  let sessionPromise = null;
  let initializedSession = null;
  let epoch = 0;
  let syncing = false;
  let submitting = false;
  let expanded = false;
  let ready = false;
  let position = config.position === 'left' ? 'left' : 'right';
  let scrollLock = null;
  // The session could not be opened (unknown binding, host down): the frame
  // shows the unavailable state until a reconnect, and the poll leaves it be.
  let openFailed = false;
  const detectLanguage = () => document.documentElement.lang?.toLowerCase().startsWith('vi') ? 'vi' : 'en';
  let detectedLanguage = detectLanguage();

  const send = (type, extra = {}) => frame.contentWindow?.postMessage({ soot_chat: 1, type, nonce, ...extra }, base);

  // A signed-in visitor's proof, minted per session open by the product.
  async function assertion() {
    if (!assertionURL) return undefined;
    const res = await fetch(assertionURL, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (res.status === 204 || res.status === 401) return undefined;
    if (!res.ok) throw Object.assign(new Error('assertion unavailable'), { status: 503 });
    const out = await res.json();
    return typeof out?.assertion === 'string' ? out.assertion : undefined;
  }

  function unlock() {
    if (!scrollLock) return;
    for (const [element, value, priority] of scrollLock) {
      if (element.style.getPropertyValue('overflow') !== 'hidden') continue;
      if (value) element.style.setProperty('overflow', value, priority);
      else element.style.removeProperty('overflow');
    }
    scrollLock = null;
  }

  function resize() {
    const mobile = innerWidth <= 600;
    if (expanded && mobile) {
      const viewport = window.visualViewport;
      Object.assign(frame.style, {
        width: (viewport?.width ?? innerWidth) + 'px', height: (viewport?.height ?? innerHeight) + 'px',
        top: (viewport?.offsetTop ?? 0) + 'px', left: (viewport?.offsetLeft ?? 0) + 'px', right: 'auto', bottom: 'auto',
      });
      if (!scrollLock && document.body) {
        scrollLock = [document.documentElement, document.body].map(element => [element, element.style.getPropertyValue('overflow'), element.style.getPropertyPriority('overflow')]);
        for (const [element] of scrollLock) element.style.setProperty('overflow', 'hidden');
      }
    } else {
      unlock();
      Object.assign(frame.style, {
        width: expanded ? Math.min(380, innerWidth - 32) + 'px' : '80px', height: expanded ? Math.min(600, innerHeight - 32) + 'px' : '80px',
        top: 'auto', bottom: '16px', left: position === 'left' ? '16px' : 'auto', right: position === 'right' ? '16px' : 'auto',
      });
    }
    send('layout', { mobile });
  }

  async function getSessionInstance() {
    if (session) return session;
    sessionPromise ??= import(new URL('web-session.js', here).href)
      .then(m => (session = new m.WebChatSession({ host, binding, assertion, language: detectedLanguage, widget: config, name: config.name })))
      .finally(() => { sessionPromise = null; });
    return sessionPromise;
  }

  const kindOf = err => err?.status === 429 ? 'rate' : err?.status === 400 ? 'validation' : err?.status === 401 ? 'expired' : 'send';

  async function connect() {
    if (!ready) return false;
    const version = epoch;
    let s;
    try {
      s = await getSessionInstance();
      let state = s.readState();
      let appInfo;
      // A saved visitor reconnects and settles an unconfirmed send; a new one opens nothing until the first Send.
      if (state.session) { ({ appInfo, state } = await s.init()); initializedSession = s; }
      else appInfo = await s.client.getAppInfo();
      if (session !== s || epoch !== version) return false;
      if (appInfo.widget?.position) position = appInfo.widget.position;
      frame.title = frameTitle(appInfo.widget?.name);
      resize();
      openFailed = false;
      send('init', { config: appInfo.widget, scopes: [], language: detectedLanguage, draft: state.draft, pendingMessage: state.pendingMessage });
      if (expanded) send('open');
      return true;
    } catch (err) {
      if (epoch !== version || (s && session !== s)) return false;
      let draft;
      try { draft = s?.readState().draft; } catch {}
      send('unavailable', { language: detectedLanguage, draft, error: { kind: err?.status === 401 ? 'expired' : 'connection' } });
      resize();
      if (expanded) send('open');
      return false;
    }
  }

  async function syncMessages(after, submission = false) {
    if (!submission && (openFailed || syncing || submitting || !expanded || document.visibilityState === 'hidden')) return;
    const version = epoch;
    let source;
    syncing = true;
    try {
      const s = await getSessionInstance();
      source = s;
      const saved = s.readState();
      const state = saved.session ? await s.reconcile() : saved;
      if (session !== s || epoch !== version) return;
      let messages = [], next_after = after, activity = 'connected', progress = null;
      if (state.conversationId) {
        const conv = await s.client.getConversation(state.conversationId);
        if (conv.state) activity = conv.state;
        if (conv.progress) progress = conv.progress;
        const unchanged = after > 0 && conv.message_cursor <= after;
        if (submission || !unchanged) {
          const page = await s.client.getMessages(state.conversationId, { after, limit: 50 });
          messages = page.messages || [];
          next_after = page.next_after || after;
        }
      }
      if (session !== s || epoch !== version) return;
      send('sync', { submission, messages, next_after, activity, progress, pointers: [], pendingMessage: state.pendingMessage, pendingAnswer: null });
    } catch (err) {
      if (epoch !== version || (source && session !== source)) return;
      send('sync', { submission, error: { kind: err?.status === 401 ? 'expired' : 'connection' } });
    } finally { syncing = false; }
  }

  instances[binding] = {
    open: () => { expanded = true; resize(); send('open'); },
    close: () => { expanded = false; resize(); send('close'); },
    reset: () => send('reset'),
    retry: () => void connect(),
  };
  addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  addEventListener('pagehide', () => { unlock(); session?.close(); });
  new MutationObserver(() => {
    const next = detectLanguage();
    if (next === detectedLanguage) return;
    detectedLanguage = next;
    session?.setLanguage(next);
    send('language', { language: next });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  addEventListener('message', async event => {
    if (event.origin !== base || event.source !== frame.contentWindow || event.data?.soot_chat !== 1) return;
    const msg = event.data;
    if (msg.type === 'ready') { ready = true; void connect(); return; }
    if (msg.nonce !== nonce) return;
    if (msg.type === 'retry-connect') { await connect(); return; }
    if (msg.type === 'open') { expanded = true; resize(); }
    else if (msg.type === 'close') { expanded = false; resize(); }
    else if (msg.type === 'position' && ['left', 'right'].includes(msg.position)) { position = msg.position; resize(); }
    else if (msg.type === 'sync') await syncMessages(msg.after ?? 0);
    else if (msg.type === 'draft') {
      if (typeof msg.text === 'string') (await getSessionInstance().catch(() => null))?.saveDraft(msg.text);
    } else if (msg.type === 'send') {
      if (submitting) return;
      submitting = true;
      epoch++;
      try {
        const s = await getSessionInstance();
        if (initializedSession !== s) {
          try { await s.init(); } catch (err) {
            // Nothing was sent: keep the text as the draft and say the chat is
            // unavailable (not "receipt unconfirmed", which offers a Resend).
            openFailed = true;
            try { s.saveDraft(msg.text); } catch {}
            // End the frame's submission (it re-enables Reconnect), then the state.
            send('sync', { submission: true, messages: [], next_after: 0, activity: 'idle', progress: null, pointers: [], pendingMessage: null, pendingAnswer: null });
            send('unavailable', { language: detectedLanguage, draft: msg.text, error: { kind: err?.status === 401 ? 'expired' : 'connection' } });
            return;
          }
          initializedSession = s;
        }
        await s.sendMessage(msg.text);
        if (session !== s) return;
        await syncMessages(0, true);
      } catch (err) {
        send('sync', { submission: true, error: { kind: kindOf(err) } });
      } finally { submitting = false; }
    } else if (msg.type === 'answer') {
      // Browser mode serves no question cards; every answer still gets its one reply.
      send('sync', { answer: { item: msg.item, code: 'busy' } });
    } else if (msg.type === 'reset') {
      if (submitting) { send('sync', { error: { kind: 'reset' } }); return; }
      epoch++;
      try {
        const s = await getSessionInstance();
        await s.reset();
        initializedSession = null;
        await connect();
        send('reset-done');
      } catch {
        send('sync', { error: { kind: 'reset' } });
      }
    }
  });
})();
