/* Soot Live chat: direct Soot API browser widget loader.
 * Backend credentials never enter this file; only publishable app keys (spk_*).
 */
(() => {
  const script = document.currentScript;
  const app = script?.dataset.app;
  if (!app || !/^spk_[A-Za-z0-9_-]{20,124}$/.test(app)) return;

  const base = new URL(script.src).origin;
  const instances = window.SootChat ?? (window.SootChat = {});
  if (instances[app]) return;

  const frame = document.createElement('iframe');
  // Screen readers announce the frame by this title: name the site's chat, not the vendor.
  const frameTitle = name => (document.documentElement.lang?.toLowerCase().startsWith('vi') ? 'Chat hỗ trợ' : 'Support chat') + (name ? ' · ' + name : '');
  frame.title = frameTitle();
  frame.src = `${base}/public/widget/frame/${encodeURIComponent(app)}?parent=${encodeURIComponent(location.origin)}`;
  // Popups let a reply's https link open in a normal, unsandboxed tab.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  frame.referrerPolicy = 'no-referrer';
  // A reply's command can be copied with one tap.
  frame.allow = 'clipboard-write';
  frame.loading = 'lazy';
  Object.assign(frame.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    width: '80px',
    height: '80px',
    border: '0',
    zIndex: '2147483000',
    colorScheme: 'normal',
  });

  if (document.body) document.body.append(frame);
  else addEventListener('DOMContentLoaded', () => document.body.append(frame), { once: true });

  const nonce = crypto.randomUUID();
  let session = null;
  let sessionPromise = null;
  // The public SDK module: it owns question, pointer and waiting rules (spec D13).
  let sdkModule = null;
  let initializedSession = null;
  let epoch = 0;
  let syncing = false;
  const scopeStorage=`soot.widget.scope.v1:${base}:${app}`;
  let selection=null;
  try {
    const saved = JSON.parse(localStorage.getItem(scopeStorage) || 'null');
    if (saved && typeof saved.soot === 'string' && typeof saved.nonce === 'string' &&
        (saved.group === undefined || typeof saved.group === 'string')) selection = saved;
  } catch {}
  let scopeChoices=[];
  let switching=false;
  let submitting=false;
  let expanded = false;
  let ready = false;
  let position = 'right';
  let scrollLock = null;

  const detectLanguage = () => document.documentElement.lang?.toLowerCase().startsWith('vi') ? 'vi' : 'en';
  let detectedLanguage = detectLanguage();

  const send = (type, extra = {}) => {
    frame.contentWindow?.postMessage({ soot_chat: 1, type, nonce, ...extra }, base);
  };

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
        width: (viewport?.width ?? innerWidth) + 'px',
        height: (viewport?.height ?? innerHeight) + 'px',
        top: (viewport?.offsetTop ?? 0) + 'px',
        left: (viewport?.offsetLeft ?? 0) + 'px',
        right: 'auto',
        bottom: 'auto',
      });
      if (!scrollLock && document.body) {
        scrollLock = [document.documentElement, document.body].map(element => [
          element,
          element.style.getPropertyValue('overflow'),
          element.style.getPropertyPriority('overflow'),
        ]);
        for (const [element] of scrollLock) element.style.setProperty('overflow', 'hidden');
      }
    } else {
      unlock();
      Object.assign(frame.style, {
        width: expanded ? Math.min(380, innerWidth - 32) + 'px' : '80px',
        height: expanded ? Math.min(600, innerHeight - 32) + 'px' : '80px',
        top: 'auto',
        bottom: '16px',
        left: position === 'left' ? '16px' : 'auto',
        right: position === 'right' ? '16px' : 'auto',
      });
    }
    send('layout', { mobile });
  }

  // A failed or unanswered challenge means nothing was sent: the send says so
  // (kind 'challenge'), not that a receipt is unconfirmed. Nothing is admitted
  // before the proof, so one quiet second attempt cannot duplicate work.
  async function acquireTurnstileProof(challenge) {
    try {
      return await turnstileProof(challenge);
    } catch (err) {
      if (!err?.retryable) throw Object.assign(err instanceof Error ? err : new Error(String(err)), { challenge: true });
      try {
        return await turnstileProof(challenge);
      } catch (again) {
        throw Object.assign(again instanceof Error ? again : new Error(String(again)), { challenge: true });
      }
    }
  }

  async function turnstileProof(challenge) {
    if (!challenge || !challenge.required) return undefined;
    if (!challenge.site_key) throw new Error('Missing Turnstile site key');

    if (!window.turnstile) {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="turnstile/v0/api.js"]');
        const s = existing || document.createElement('script');
        const finish = error => {
          clearTimeout(timeout);
          s.removeEventListener('load', loaded);
          s.removeEventListener('error', failed);
          if (error) { if (!existing) s.remove(); reject(error); }
          else resolve();
        };
        const loaded = () => finish(window.turnstile ? undefined : new Error('Turnstile unavailable'));
        const failed = () => finish(new Error('Failed to load Turnstile script'));
        const timeout = setTimeout(() => finish(new Error('Turnstile script load timed out')), 15000);
        s.addEventListener('load', loaded, { once: true });
        s.addEventListener('error', failed, { once: true });
        if (!existing) {
          s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
          s.async = true;
          s.defer = true;
          document.head.appendChild(s);
        }
      });
    }

    return new Promise((resolve, reject) => {
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;right:16px;bottom:96px;max-width:calc(100vw - 32px);z-index:2147483001;';
      document.body.appendChild(container);
      let widgetId;
      let settled = false;
      const finish = (error, token) => {
        if (settled) return;
        settled = true;
        if (widgetId !== undefined) { try { window.turnstile.remove(widgetId); } catch {} }
        container.remove();
        if (error) reject(error);
        else resolve(token);
      };
      try {
        widgetId = window.turnstile.render(container, {
          sitekey: challenge.site_key,
          action: challenge.action || 'chat',
          language: detectedLanguage,
          appearance: 'interaction-only',
          callback: token => finish(undefined, token),
          'error-callback': () => finish(Object.assign(new Error('Turnstile challenge failed'), { retryable: true })),
          'expired-callback': () => finish(Object.assign(new Error('Turnstile token expired'), { retryable: true })),
          'timeout-callback': () => finish(Object.assign(new Error('Turnstile challenge timed out'), { retryable: true })),
        });
        // Test transports and cached providers may finish during render.
        if (settled) { try { window.turnstile.remove(widgetId); } catch {} }
      } catch (err) {
        finish(err);
      }
    });
  }

  async function getSessionInstance() {
    if (session) return session;
    if (sessionPromise) return sessionPromise;
    sessionPromise = import(`${base}/public/widget/browser.js`).then(sdk => (sdkModule = sdk, new sdk.SootChatSession({
      baseUrl: base,
      appKey: app,
      language: detectedLanguage,
      ...(selection?{sootId:selection.soot,groupId:selection.group,storageKey:`${scopeStorage}:${selection.nonce}`} : {}),
      proofProvider: acquireTurnstileProof,
    }))).then(value => (session = value)).finally(() => { sessionPromise = null; });
    return sessionPromise;
  }

  async function connect() {
    if (!ready) return;
    const version = epoch;
    let s;
    try {
      s = await getSessionInstance();
      let state = s.readState();
      // Read appearance without minting a visitor identity or asking every
      // page visitor for proof. First Send creates a session; saved visitors
      // still reconcile their durable receipts on load.
      let appInfo;
      if (state.session) {
        ({ appInfo, state } = await s.init());
        initializedSession = s;
      } else {
        appInfo = await s.client.getAppInfo();
      }
      if(session!==s || epoch!==version)return false;
      scopeChoices=appInfo.soots.flatMap(soot=>(soot.automatic_groups&&appInfo.capabilities?.includes('groups.auto.v1')?[{id:'auto',default:true}]:soot.groups?.length?soot.groups:[undefined]).map(group=>({value:JSON.stringify([soot.id,group?.id||'']),label:[soot.name||soot.id,group?.name].filter(Boolean).join(' · '),soot:soot.id,group:group?.id,default:group?.default})));
      const activeConversation=state.conversationId?await s.client.getConversation(state.conversationId):null;
      if(session!==s || epoch!==version)return false;
      if(activeConversation&&!scopeChoices.some(x=>x.soot===activeConversation.soot&&(x.group||'')===(activeConversation.group_id||''))){
        const soot=appInfo.soots.find(x=>x.id===activeConversation.soot);
        if(soot){const group=soot.groups?.find(g=>g.id===activeConversation.group_id);scopeChoices.push({value:JSON.stringify([soot.id,activeConversation.group_id||'']),label:[soot.name||soot.id,group?.name].filter(Boolean).join(' · '),soot:soot.id,group:activeConversation.group_id});}
      }
      const chosen=activeConversation?scopeChoices.find(x=>x.soot===activeConversation.soot&&(x.group||'')===(activeConversation.group_id||'')):selection?scopeChoices.find(x=>x.soot===selection.soot&&(x.group||'')===(selection.group||'')):scopeChoices.find(x=>x.default)||(scopeChoices.length===1?scopeChoices[0]:undefined);
      if (appInfo.widget?.position) position = appInfo.widget.position;
      frame.title = frameTitle(appInfo.widget?.name);
      resize();
      send('init', {
        config: appInfo.widget,
        scopes:scopeChoices.map(({value,label})=>({value,label})),scopeValue:chosen?.value,scopeName:chosen?.label,scopeRequired:scopeChoices.length>1&&!chosen,
        language: detectedLanguage,
        draft: state.draft,
        pendingMessage: state.pendingMessage,
      });
      if (expanded) send('open');
      return true;
    } catch (err) {
      if (epoch !== version || (s && session !== s)) return false;
      let draft;
      try { draft = s?.readState().draft; } catch {}
      send('unavailable', { language: detectedLanguage, draft,
        error: { kind: err?.status === 401 ? 'expired' : 'connection' } });
      resize();
      if (expanded) send('open');
      return false;
    }
  }

  // Question cards and pointers, validated by the SDK. A browser.js older than
  // the attention helpers (a cached asset across a runtime upgrade) yields
  // nothing, so the frame keeps showing text as before.
  const cardOf = raw => (raw === undefined || !sdkModule?.questionOf ? undefined : sdkModule.questionOf(raw));
  function withCards(messages) {
    return messages.map(m => {
      if (m?.question === undefined) return m;
      const { question: raw, ...rest } = m;
      const question = cardOf(raw);
      return question ? { ...rest, question } : rest;
    });
  }
  function attentionOf(conv) {
    const question = cardOf(conv.question);
    return {
      question: question && !question.resolution ? question : undefined,
      waiting: sdkModule?.waitingOf?.(conv.waiting),
      pointers: sdkModule?.pointersOf?.(conv.pointers) || [],
    };
  }

  async function syncMessages(after, submission = false, extra = {}) {
    if (!submission && (syncing || submitting || switching || !expanded || document.visibilityState === 'hidden')) return;
    const version = epoch;
    let source;
    syncing = true;
    try {
      const s = await getSessionInstance();
      source=s;
      const saved = s.readState();
      const state = saved.session ? await s.reconcile() : saved;
      if(session!==s || epoch!==version)return;
      let messages = [];
      let next_after = after;
      let activity = 'connected';
      let progress = null;
      let attention = { pointers: [] };
      let refreshed;

      if (state.conversationId) {
        try {
          const conv = await s.client.getConversation(state.conversationId);
          if (conv.state) activity = conv.state;
          if (conv.progress) progress = { run: conv.progress.run, phase: conv.progress.phase, steps: conv.progress.steps, since: conv.progress.since };
          attention = attentionOf(conv);
          // A visitor's reads are rate limited, so the transcript is read only
          // when it holds something past the frame's cursor.
          const unchanged = after > 0 && typeof conv.message_cursor === 'number' && conv.message_cursor <= after;
          if (submission || !unchanged) {
            const page = await s.client.getMessages(state.conversationId, { after, limit: 50 });
            messages = withCards(page.messages || []);
            next_after = page.next_after || after;
          }
          // A card whose question is no longer open is read again by itself, so
          // it freezes with its resolution. Its message is behind the cursor.
          const refresh = Number(extra.refresh);
          if (Number.isSafeInteger(refresh) && refresh > 0 && !messages.some(m => Number(m.id) === refresh)) {
            const page = await s.client.getMessages(state.conversationId, { after: refresh - 1, limit: 1 });
            messages = [...withCards((page.messages || []).filter(m => Number(m.id) === refresh)), ...messages];
            refreshed = refresh;
          }
        } catch (err) {
          if(session!==s || epoch!==version)return;
          send('sync', { submission, ...(extra.answer ? { answer: { ...extra.answer, read: false } } : {}), error: { kind: err?.status === 401 ? 'expired' : 'connection' } });
          return;
        }
      }

      if(session!==s || epoch!==version)return;
      send('sync', {
        submission,
        messages,
        next_after,
        activity,
        progress,
        ...attention,
        pendingMessage: state.pendingMessage,
        pendingAnswer: state.pendingAnswer || null,
        ...(extra.answer ? { answer: extra.answer } : {}),
        ...(refreshed ? { refreshed } : {}),
      });
    } catch (err) {
      if(epoch!==version || (source && session!==source))return;
      send('sync', { submission, ...(extra.answer ? { answer: { ...extra.answer, read: false } } : {}), error: { kind: err?.status === 401 ? 'expired' : 'connection' } });
    } finally { syncing = false; }
  }

  const api = {
    open: () => {
      expanded = true;
      resize();
      send('open');
    },
    close: () => {
      expanded = false;
      resize();
      send('close');
    },
    reset: () => send('reset'),
    retry: () => void connect(),
  };

  instances[app] = api;
  addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('scroll', resize);
  addEventListener('pagehide', unlock);
  const languageObserver = new MutationObserver(() => {
    const next = detectLanguage();
    if (next === detectedLanguage) return;
    detectedLanguage = next;
    session?.setLanguage(next);
    send('language', { language: next });
  });
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  addEventListener('message', async event => {
    if (event.origin !== base || event.source !== frame.contentWindow || event.data?.soot_chat !== 1) return;
    const msg = event.data;

    if (msg.type === 'ready') {
      ready = true;
      void connect();
      return;
    }

    if (msg.nonce !== nonce) return;
    if (msg.type === 'retry-connect') { await connect(); return; }

    if(msg.type==='scope'){
      if(switching)return;
      if(submitting){send('sync',{error:{kind:'reset'}});return;}
      const chosen=scopeChoices.find(x=>x.value===msg.value);
      if(!chosen){send('sync',{error:{kind:'reset'}});return;}
      switching=true;
      const previousSelection=selection,oldSession=session;
      try{
        const old=await getSessionInstance();const state=old.readState();
        if(state.pendingMessage||state.pendingCreate)throw new Error('Reconcile before changing scope');
        const next={soot:chosen.soot,group:chosen.group,nonce:crypto.randomUUID()};
        localStorage.setItem(scopeStorage,JSON.stringify(next));epoch++;selection=next;session=null;initializedSession=null;
        if(!await connect())throw new Error('Scope connection failed');send('reset-done');
      }catch{selection=previousSelection;session=oldSession;try{if(selection)localStorage.setItem(scopeStorage,JSON.stringify(selection));else localStorage.removeItem(scopeStorage);}catch{}send('sync',{error:{kind:'reset'}});}finally{switching=false;}
      return;
    }
    if(switching && ['send','answer','draft','sync','reset'].includes(msg.type))return;
    if (msg.type === 'open') {
      expanded = true;
      resize();
    } else if (msg.type === 'close') {
      expanded = false;
      resize();
    } else if (msg.type === 'position' && ['left', 'right'].includes(msg.position)) {
      position = msg.position;
      resize();
    } else if (msg.type === 'sync') {
      await syncMessages(msg.after ?? 0, false, { refresh: msg.refresh });
    } else if (msg.type === 'draft') {
      if (typeof msg.text === 'string') {
        const s = await getSessionInstance().catch(() => null);
        s?.saveDraft(msg.text);
      }
    } else if (msg.type === 'send') {
      if(submitting)return;
      submitting=true;
      epoch++;
      try {
        const s = await getSessionInstance();
        if (initializedSession !== s) { await s.init(); initializedSession = s; }
        await s.sendMessage(msg.text);
        if(session!==s)return;
        await syncMessages(0, true);
      } catch (err) {
        const kind = err?.challenge ? 'challenge' : err?.status === 429 ? 'rate' : err?.status === 400 ? 'validation' : err?.status === 401 ? 'expired' : 'send';
        send('sync', { submission: true, error: { kind } });
      } finally {submitting=false;}
    } else if (msg.type === 'answer') {
      // A card's answer: the SDK keeps a durable receipt and retries it with the
      // same request ID; refusals come back as codes the frame words itself.
      const answer = { item: msg.item };
      // Every answer gets one reply, so the frame never waits on a card.
      if (submitting || typeof msg.item !== 'string' || !Array.isArray(msg.choices)) { send('sync', { answer: { ...answer, code: 'busy' } }); return; }
      submitting = true;
      epoch++;
      let s;
      try {
        s = await getSessionInstance();
        if (initializedSession !== s) { await s.init(); initializedSession = s; }
        await s.answer(msg.item, msg.choices);
        if (session !== s) return;
        await syncMessages(msg.after ?? 0, true, { refresh: msg.message, answer });
      } catch (err) {
        if (s && session !== s) return;
        // A definitive refusal admitted nothing and the SDK cleared its receipt,
        // so it is worded (refreshing the card), never offered as a Resend.
        const definitive = !err?.challenge && ([400, 403, 404, 409, 422].includes(err?.status) || err?.message === 'Invalid answer');
        const code = !definitive ? '' : sdkModule?.ANSWER_REFUSAL_CODES?.includes(err?.code) ? err.code : 'moved_on';
        if (code || err?.message === 'Another answer is pending') {
          await syncMessages(msg.after ?? 0, true, { refresh: msg.message, answer: { ...answer, code: code || 'busy' } });
        } else {
          const kind = err?.challenge ? 'challenge' : err?.status === 429 ? 'rate' : err?.status === 401 ? 'expired' : 'send';
          send('sync', { submission: true, answer, error: { kind } });
        }
      } finally { submitting = false; }
    } else if (msg.type === 'reset') {
      if (submitting || switching) { send('sync', { error: { kind: 'reset' } }); return; }
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
