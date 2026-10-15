import { createWidgetComposer } from "./widget-composer.js";
import { isAgentTranscriptAtEnd } from "./agent-behavior.js";

(() => {
  const params = new URLSearchParams(location.search);
  const parentOrigin = params.get('parent');
  const $ = id => document.getElementById(id);

  let nonce = '';
  let cursor = 0;
  let timer = null;
  let closed = false;
  let opened = false;
  let pending = null;
  let sending = false;
  let resetting = false;
  let errorKind = '';
  let follow = true;
  let configuredPosition = 'right';
  let language = 'vi';
  let scopes=[],scopeValue='',scopeName='',scopeRequired=false;
  let removeThemeListener = () => {};
  const sharedFiles = new Map();
  const holding = new Map();
  // Runs whose holding message has given way; a later read of the same
  // history must not bring it back.
  const settled = new Set();
  // Conversation states in which no run is working, so no holding message holds.
  const idleStates = new Set(['active', 'idle', 'completed', 'failed', 'stopped']);
  function dropHolding(run) {
    holding.get(run)?.remove(); holding.delete(run); settled.add(run);
  }
  // The visitor's latest question, so a run that ended without a reply can be
  // asked again in one tap.
  let lastAsked = '';

  const dict = {
    vi: {
      connecting: 'Đang kết nối…',
      connected: 'Sẵn sàng hỗ trợ',
      queued: 'Đã nhận · Đang chờ',
      working: 'Đang trả lời…',
      running: 'Đang trả lời…',
      active: 'Sẵn sàng hỗ trợ',
      idle: 'Sẵn sàng hỗ trợ',
      waiting_input: 'Đang chờ bạn trả lời',
      waiting_human: 'Đang chờ nhân viên',
      blocked: 'Cần nhân viên hỗ trợ',
      completed: 'Sẵn sàng hỗ trợ',
      failed: 'Chưa thể trả lời',
      stopped: 'Đã dừng',
      reconnecting: 'Đang kết nối lại…',
      sending: 'Đang gửi…',
      pending_send: 'Tin nhắn đang chờ gửi',
      cannot_connect: 'Chưa thể kết nối',
      new_conversation: 'Cuộc trò chuyện mới',
      reset_title: 'Bắt đầu cuộc trò chuyện mới?',
      reset_desc: 'Cuộc trò chuyện hiện tại sẽ đóng. Nội dung chưa gửi sẽ được xóa.',
      keep_chat: 'Tiếp tục chat',
      confirm_reset: 'Bắt đầu mới',
      new_messages: 'Tin mới',
      retry: 'Thử lại',
      resend: 'Gửi lại',
      reconnect: 'Kết nối lại',
      validation_error: 'Tin nhắn quá dài hoặc có ký tự không hợp lệ. Hãy rút ngắn rồi gửi lại.',
      send_validation_error: 'Tin chưa hợp lệ. Hãy sửa nội dung rồi gửi lại.',
      rate_error: 'Bạn đang gửi quá nhanh. Chờ một chút rồi thử lại.',
      send_error: 'Chưa xác nhận tin đã gửi. Nội dung vẫn được giữ lại.',
      challenge_error: 'Chưa xác minh được trình duyệt nên tin chưa được gửi. Nội dung vẫn được giữ lại.',
      reply_error: 'Mình chưa trả lời được tin vừa rồi. Bạn bấm Gửi lại, hoặc hỏi theo cách khác nhé.',
      expired_error: 'Phiên chat đã hết hạn. Bắt đầu cuộc trò chuyện mới để tiếp tục.',
      connect_error: 'Hỗ trợ đang mất kết nối. Bạn có thể thử lại sau.',
      reset_error: 'Chưa xác nhận đã đóng phiên. Thử lại để tránh tạo hai phiên.',
      placeholder: 'Nhắn tin…',
      send_label: 'Gửi tin nhắn',
      sending_label: 'Đang gửi tin nhắn',
      you: 'Bạn',
      staff: 'Nhân viên',
      powered_by: 'Được hỗ trợ bởi Soot',
      open_label: 'Mở chat với ',
      options_label: 'Tùy chọn cuộc trò chuyện',
      close_label: 'Thu gọn chat',
      transcript: 'Lịch sử trò chuyện', message: 'Tin nhắn', suggestions: 'Gợi ý bắt đầu',
      composer_hint: 'Enter để gửi · Shift + Enter để xuống dòng · Esc hai lần xóa text',
      copy: 'Sao chép', copied: 'Đã chép', copy_select: 'Đã chọn — nhấn Ctrl/⌘ + C',
    },
    en: {
      connecting: 'Connecting…',
      connected: 'Ready to help',
      queued: 'Received · Queued',
      working: 'Replying…',
      running: 'Replying…',
      active: 'Ready to help',
      idle: 'Ready to help',
      waiting_input: 'Waiting for your reply',
      waiting_human: 'Waiting for staff',
      blocked: 'Staff assistance needed',
      completed: 'Ready to help',
      failed: 'Unable to reply',
      stopped: 'Stopped',
      reconnecting: 'Reconnecting…',
      sending: 'Sending…',
      pending_send: 'Message queued to send',
      cannot_connect: 'Unable to connect',
      new_conversation: 'New conversation',
      reset_title: 'Start a new conversation?',
      reset_desc: 'Current conversation will close. Unsent messages will be cleared.',
      keep_chat: 'Continue chat',
      confirm_reset: 'Start new',
      new_messages: 'New messages',
      retry: 'Retry',
      resend: 'Resend',
      reconnect: 'Reconnect',
      validation_error: 'Message is too long or contains invalid characters. Please shorten and resend.',
      send_validation_error: 'Message invalid. Please adjust and resend.',
      rate_error: 'You are sending too quickly. Please wait a moment.',
      send_error: 'Message receipt unconfirmed. Draft preserved.',
      challenge_error: 'This browser could not be verified, so nothing was sent. Your message is kept.',
      reply_error: 'I couldn\'t answer your last message. Tap Resend, or ask it another way.',
      expired_error: 'Chat session expired. Start a new conversation to continue.',
      connect_error: 'Live chat is currently unavailable. Please try again later.',
      reset_error: 'Failed to confirm session closure. Retry to avoid duplicate sessions.',
      placeholder: 'Type a message…',
      send_label: 'Send message',
      sending_label: 'Sending message',
      you: 'You',
      staff: 'Staff',
      powered_by: 'Powered by Soot',
      open_label: 'Open chat with ',
      options_label: 'Conversation options',
      close_label: 'Close chat',
      transcript: 'Conversation history', message: 'Message', suggestions: 'Suggested messages',
      composer_hint: 'Enter to send · Shift + Enter for a new line · Double Esc to clear',
      copy: 'Copy', copied: 'Copied', copy_select: 'Selected — press Ctrl/⌘ + C',
    },
  };

  const t = key => (dict[language] && dict[language][key]) || dict.vi[key] || key;

  const post = (type, extra = {}) => {
    if (parentOrigin) {
      parent.postMessage({ soot_chat: 1, type, nonce, ...extra }, parentOrigin);
    }
  };

  const composer = createWidgetComposer($('composer'), submit, text => {
    if (errorKind === 'validation' && valid(text)) error();
    controls();
    if (follow) bottom();
    post('draft', {text});
  });

  function expanded(value) {
    const changed = opened !== value;
    opened = value;
    $('chat').hidden = !value;
    $('launcher').hidden = value;
    $('launcher').setAttribute('aria-expanded', String(value));
    if (!value) {
      clearTimeout(timer);
      $('options').open = false;
      $('reset-confirm').hidden = true;
    }
    post(value ? 'open' : 'close');
    if (changed) (value ? $('chat') : $('launcher')).focus({ preventScroll: true });
    if (value && follow) bottom();
    if (changed && value) requestSync();
  }

  function error(value = '', kind = '', retry = '') {
    errorKind = kind;
    $('error').textContent = value;
    $('error-bar').hidden = !value;
    $('retry').hidden = !retry;
    $('retry').textContent = retry || t('retry');
    // A reply that never came is not the draft's fault, so the composer is not marked.
    composer.update({invalid:kind === 'validation',error:!!value && kind !== 'reply'});
  }

  function controls() {
    const locked = !!pending || resetting;
    composer.update({disabled:resetting,readOnly:!!pending,sending,canSend:!locked&&!scopeRequired,scopes,scopeValue,scopeName,scopeDisabled:locked||sending,scopeLabel:'Soot',scopePlaceholder:language==='vi'?'Chọn Soot':'Choose Soot',onScope:value=>{if(locked||sending)return;resetting=true;controls();post('scope',{value});},
      sendLabel:sending?t('sending_label'):t('send_label'),message:t('message'),placeholder:t('placeholder'),
      name:$('name').textContent,hint:t('composer_hint'),files:[...sharedFiles.values()].slice(-256),
      skillLabel:language==='vi'?'Kỹ năng':'Skills',fileLabel:language==='vi'?'Tệp đã chia sẻ':'Shared files',
      emptyLabel:language==='vi'?'Chưa có mục phù hợp trong phiên này.':'No matching items in this conversation.',
      mobile:document.documentElement.dataset.layout==='mobile'});
    $('retry').disabled = sending || resetting;
    $('reset').disabled = resetting || sending;
    $('confirm-reset').disabled = resetting || sending;
    $('keep').disabled = resetting;
    for (const b of $('quick').children) {
      b.disabled = locked || !!$('text').value.trim();
    }
  }

  function bottom() {
    $('transcript').scrollTop = $('transcript').scrollHeight;
    follow = true;
    $('jump').hidden = true;
  }

  // Soot answers in light markdown. It is built from DOM nodes only, so model or
  // staff text never becomes markup, and a link must be an absolute https URL.
  function inline(parent, text) {
    let at = 0;
    for (const m of text.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|https:\/\/[^\s<>()]*[^\s<>().,;:!?'"*]/g)) {
      if (m.index > at) parent.append(text.slice(at, m.index));
      at = m.index + m[0].length;
      let node, url = null;
      if (m[1] || m[2]) {
        node = document.createElement(m[1] ? 'strong' : 'code');
        node.textContent = m[1] || m[2];
      } else {
        try { url = new URL(m[4] || m[0]); } catch {}
        if (!url || url.protocol !== 'https:' || url.username || url.password) { parent.append(m[0]); continue; }
        node = document.createElement('a');
        node.href = url.href;
        node.target = '_blank';
        node.rel = 'noopener noreferrer nofollow';
        node.textContent = m[3] || m[0];
      }
      parent.append(node);
    }
    if (at < text.length) parent.append(text.slice(at));
  }

  function codeBlock() {
    const figure = document.createElement('div');
    figure.className = 'code-block';
    const pre = document.createElement('pre'), code = document.createElement('code');
    pre.append(code);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-code';
    copy.textContent = t('copy');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.textContent = t('copied');
      } catch {
        // No clipboard permission: select the text so the visitor can copy it.
        const range = document.createRange();
        range.selectNodeContents(code);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        copy.textContent = t('copy_select');
      }
      setTimeout(() => { copy.textContent = t('copy'); }, 2000);
    };
    figure.append(pre, copy);
    return { figure, code };
  }

  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
  const tableRow = line => /^\s*\|.*\|\s*$/.test(line);
  const tableRule = line => line.includes('---') && cells(line).every(c => /^:?-{3,}:?$/.test(c));

  // A chat is too narrow for columns, so a markdown table is read row by row:
  // the first cell names the row, every other cell is labelled by its header.
  function table(head, rows) {
    const out = document.createElement('div');
    out.className = 'table';
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'row';
      const title = document.createElement('strong');
      inline(title, row[0] || '');
      const pairs = document.createElement('dl');
      for (let i = 1; i < row.length; i++) {
        if (!row[i]) continue;
        const dt = document.createElement('dt'), dd = document.createElement('dd');
        inline(dt, head[i] || '');
        inline(dd, row[i]);
        pairs.append(dt, dd);
      }
      item.append(title, pairs);
      out.append(item);
    }
    return out;
  }

  function prose(text) {
    const body = document.createElement('div');
    body.className = 'prose';
    let block = null, kind = '', code = null;
    const lines = text.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];
      // A fenced block is a command or config to copy: keep it verbatim, never as markup.
      if (/^\s*```/.test(line)) {
        if (code) { code = null; kind = ''; continue; }
        const fenced = codeBlock(); code = fenced.code; body.append(fenced.figure); kind = 'code';
        continue;
      }
      if (code) { code.textContent += (code.textContent ? '\n' : '') + line; continue; }
      if (tableRow(line) && tableRule(lines[n + 1] || '')) {
        const head = cells(line), rows = [];
        for (n += 2; n < lines.length && tableRow(lines[n]); n++) rows.push(cells(lines[n]));
        n--;
        body.append(table(head, rows));
        kind = '';
        continue;
      }
      const item = /^\s*(?:[-*\u2022]|(\d{1,3})[.)])\s+(.*)$/.exec(line), heading = /^#{1,4}\s+(.*)$/.exec(line);
      if (!line.trim()) {
        kind = '';
      } else if (item) {
        const list = item[1] ? 'ol' : 'ul';
        if (kind !== list) {
          block = document.createElement(list);
          if (item[1] && item[1] !== '1') block.start = Number(item[1]);
          body.append(block);
          kind = list;
        }
        const li = document.createElement('li');
        inline(li, item[2]);
        block.append(li);
      } else if (heading) {
        block = document.createElement('p');
        const strong = document.createElement('strong');
        inline(strong, heading[1]);
        block.append(strong);
        body.append(block);
        kind = '';
      } else {
        if (kind === 'p') block.append('\n');
        else { block = document.createElement('p'); body.append(block); kind = 'p'; }
        inline(block, line);
      }
    }
    return body;
  }

  function render(message) {
    const role = message.role === 'user' ? (message.actor_role === 'member' ? 'member' : 'customer') : message.role;
    if (
      !['customer', 'assistant', 'member'].includes(role) ||
      (message.intent === 'acknowledgement' && settled.has(message.run)) ||
      document.querySelector('[data-message="' + CSS.escape(String(message.id)) + '"]')
    ) {
      return false;
    }
    for (const match of String(message.text || '').matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
      try { const url=new URL(match[2]); if(!url.username&&!url.password&&/\.[a-z0-9]{1,8}$/i.test(url.pathname)) sharedFiles.set(url.href,{value:url.href,label:match[1]}); } catch {}
      if(sharedFiles.size>256)sharedFiles.delete(sharedFiles.keys().next().value);
    }
    const article = document.createElement('article');
    article.className = 'message ui-agent-message ' + role;
    article.dataset.agentRole = role === 'customer' ? 'user' : 'assistant';
    article.dataset.message = String(message.id);
    // A visitor's own words stay verbatim; replies from Soot or staff are prose.
    let body;
    if (role === 'customer') {
      body = document.createElement('p');
      body.textContent = message.text;
      lastAsked = String(message.text || '');
    } else {
      body = prose(String(message.text || ''));
    }
    const meta = document.createElement('small');
    meta.className = 'ui-agent-message-label';
    meta.id = 'message-label-' + String(message.id);
    article.setAttribute('aria-labelledby', meta.id);
    meta.textContent =
      role === 'customer' ? t('you') : role === 'member' ? t('staff') : $('name').textContent;
    const date = new Date(message.created);
    if (Number.isFinite(date.getTime())) {
      const time = document.createElement('time');
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString(language === 'vi' ? 'vi' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
      meta.append(' · ', time);
    }
    article.append(meta, body);
    // "Checking, one moment" only covers the wait: the run's reply replaces it,
    // so a long chat is not a column of holding messages.
    if (role === 'assistant' && message.run) {
      if (message.intent === 'acknowledgement') holding.set(message.run, article);
      else dropHolding(message.run);
    }
    $('transcript').append(article);
    return true;
  }

  function valid(value) {
    return new TextEncoder().encode(value).length <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  }

  function submit() {
    if (sending || resetting) return;
    const value = $('text').value.trim();
    if (!value && !pending) return;

    if (!pending) {
      if (!valid(value)) {
        error(t('validation_error'), 'validation');
        return;
      }
      pending = { id: crypto.randomUUID(), text: value };
    }

    // The loader drops every frame message whose nonce does not match its own,
    // so a send posted before 'init' arrives is silently discarded while
    // 'sending' would stay stuck. Hold the input as pending and flush it once
    // init supplies the nonce.
    if (!nonce) {
      $('activity').textContent = t('connecting');
      controls();
      return;
    }

    sending = true;
    controls();
    error();
    $('activity').textContent = t('sending');
    post('send', { id: pending.id, text: pending.text });
  }

  function reset() {
    if (resetting || sending) return;
    resetting = true;
    controls();
    $('activity').textContent = t('connecting');
    post('reset');
  }

  function applyLanguage(lang) {
    if (lang === 'en' || lang === 'vi') {
      language = lang;
      document.documentElement.lang = lang;
    }
    $('transcript').setAttribute('aria-label', t('transcript'));
    $('quick').setAttribute('aria-label', t('suggestions'));
    $('close').setAttribute('aria-label', t('close_label'));
    $('options').querySelector('summary').setAttribute('aria-label', t('options_label'));
    $('reset').textContent = t('new_conversation');
    $('reset-title').textContent = t('reset_title');
    const resetP = $('reset-confirm').querySelector('p');
    if (resetP) resetP.textContent = t('reset_desc');
    $('keep').textContent = t('keep_chat');
    $('confirm-reset').textContent = t('confirm_reset');
    const footer = $('chat').querySelector('footer');
    if (footer) footer.textContent = t('powered_by');
    const jump = $('jump');
    if (jump) {
      const svg = jump.querySelector('svg');
      jump.replaceChildren(svg || '', t('new_messages'));
    }
  }

  // The page's language picks the greeting and suggestions; the chrome follows it too.
  let lastConfig = null;
  const localized = cfg => ({ ...cfg, ...Object.fromEntries(Object.entries(cfg.translations?.[language] || {}).filter(([, v]) => v && v.length)) });

  function applyConfig(raw) {
    if (!raw) return;
    lastConfig = raw;
    const cfg = localized(raw);
    $('name').textContent = cfg.name || 'Soot';
    $('launcher').setAttribute('aria-label', t('open_label') + (cfg.name || 'Soot'));
    $('greeting').textContent = cfg.greeting || '';
    removeThemeListener();
    const appearance = matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      document.documentElement.dataset.appearance =
        cfg.theme === 'auto' || cfg.theme === 'system'
          ? appearance.matches
            ? 'dark'
            : 'light'
          : cfg.theme || 'light';
    };
    applyTheme();
    if (cfg.theme === 'auto' || cfg.theme === 'system') {
      appearance.addEventListener('change', applyTheme);
      removeThemeListener = () => appearance.removeEventListener('change', applyTheme);
    }
    if (cfg.logo) {
      const image = document.createElement('img');
      image.src = cfg.logo;
      image.alt = '';
      $('logo').replaceChildren(image);
    } else {
      $('logo').textContent = (cfg.name || 'Soot').slice(0, 1);
    }
    $('quick').replaceChildren();
    if (Array.isArray(cfg.quick_replies)) {
      for (const title of cfg.quick_replies) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = title;
        // A suggestion is a question the visitor picked: ask it. A draft they
        // are typing is never replaced (the chips are disabled meanwhile).
        b.onclick = () => {
          if (pending || resetting || sending || $('text').value.trim()) return;
          composer.setValue(title);
          submit();
        };
        $('quick').append(b);
      }
    }
    configuredPosition = cfg.position || 'right';
    post('position', { position: configuredPosition });
    controls();
  }

  function requestSync() {
    clearTimeout(timer);
    if (closed || !opened || resetting || sending || document.visibilityState === 'hidden') return;
    post('sync', { after: cursor });
    // Schedule independently of the response: a dropped read must not stop
    // recovery. Collapsed and background documents never drain this API.
    timer = setTimeout(requestSync, 3000);
  }

  // DOM Event Handlers
  $('launcher').onclick = () => expanded(true);
  $('close').onclick = () => expanded(false);
  $('transcript').onscroll = () => {
    const log = $('transcript');
    follow = isAgentTranscriptAtEnd(log);
    if (follow) $('jump').hidden = true;
  };
  $('jump').onclick = () => { bottom(); $('transcript').focus({ preventScroll: true }); };
  const transcriptResize = new ResizeObserver(() => { if (follow) bottom(); });
  transcriptResize.observe($('transcript'));
  transcriptResize.observe($('composer'));
  $('retry').onclick = () => {
    if (errorKind === 'reset') reset();
    else if (errorKind === 'expired') $('reset').click();
    else if (errorKind === 'connection') post('retry-connect');
    else if (errorKind === 'reply' && !pending && lastAsked) { pending = { id: crypto.randomUUID(), text: lastAsked, resend: true }; submit(); }
    else if (pending) submit();
    else requestSync();
  };
  $('reset').onclick = () => {
    $('options').open = false;
    $('reset-confirm').hidden = false;
    $('keep').focus();
  };
  $('keep').onclick = () => {
    $('reset-confirm').hidden = true;
    $('options').querySelector('summary').focus();
  };
  $('confirm-reset').onclick = () => reset();

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!$('reset-confirm').hidden) {
      if (!resetting) $('keep').click();
    } else if ($('options').open) {
      $('options').open = false;
      $('options').querySelector('summary').focus();
    } else {
      expanded(false);
    }
  });

  document.addEventListener('click', e => {
    if (!$('options').contains(e.target)) $('options').open = false;
  });
  document.addEventListener('visibilitychange', requestSync);

  // RPC Message Listener from Parent
  addEventListener('message', event => {
    if (event.source !== parent || (parentOrigin && event.origin !== parentOrigin) || event.data?.soot_chat !== 1) {
      return;
    }
    const msg = event.data;

    if (msg.type === 'init' && typeof msg.nonce === 'string') {
      nonce = msg.nonce;
      if (msg.language) applyLanguage(msg.language);
      if (msg.config) applyConfig(msg.config);
      if(Array.isArray(msg.scopes))scopes=msg.scopes;
      scopeValue=msg.scopeValue||'';scopeName=msg.scopeName||'';scopeRequired=!!msg.scopeRequired;
      if (typeof msg.draft === 'string' && !$('text').value) {
        composer.setValue(msg.draft);
      }
      if (msg.pendingMessage) pending = msg.pendingMessage;
      if (errorKind === 'connection') error();
      $('activity').textContent = t('connected');
      controls();
      requestSync();
      // Flush a send the user queued before the nonce arrived (submit() held
      // it as pending rather than posting a message the loader would drop).
      if (pending && !sending) submit();
    } else if (msg.type === 'sync' && msg.nonce === nonce) {
      // Only a submission response can settle the foreground send. An older
      // background read contains no evidence that its message was accepted.
      if (sending && !msg.submission) return;
      sending = false;
      let added = false;
      if (Array.isArray(msg.messages)) {
        for (const m of msg.messages) {
          added = render(m) || added;
        }
      }
      if (typeof msg.next_after === 'number') {
        cursor = Math.max(cursor, msg.next_after);
      }
      // The run behind a holding message ended without replying (or the page
      // was reloaded long after): when nothing is working, nothing is "checking".
      if (idleStates.has(msg.activity)) for (const run of [...holding.keys()]) dropHolding(run);
      if (added) {
        $('welcome').hidden = true;
        if (follow) bottom();
        else $('jump').hidden = false;
      }
      if (msg.pendingMessage) {
        pending = msg.pendingMessage;
        $('activity').textContent = t('pending_send');
      } else {
        if (pending && !msg.error) {
          // Successfully completed previous pending send. A resend never came
          // from the composer, so whatever the visitor is typing stays.
          if (!pending.resend) composer.setValue('');
          pending = null;
          bottom();
        }
        $('activity').textContent = t(dict[language]?.[msg.activity] ? msg.activity : 'connected');
      }

      if (msg.error) {
        if (msg.error.kind === 'reset') {
          resetting = false;
          error(t('reset_error'), 'reset', t('retry'));
        } else if (msg.error.kind === 'rate') {
          error(t('rate_error'), 'rate', t('retry'));
        } else if (msg.error.kind === 'expired') {
          error(t('expired_error'), 'expired', t('new_conversation'));
        } else if (msg.error.kind === 'connection') {
          $('activity').textContent = t('reconnecting');
          error(t('connect_error'), 'connection', t('reconnect'));
        } else if (msg.error.kind === 'challenge') {
          error(t('challenge_error'), 'send', t('resend'));
        } else if (msg.error.kind === 'validation') {
          pending = null;
          error(t('send_validation_error'), 'validation');
        } else {
          error(t('send_error'), 'send', t('resend'));
        }
      } else if (msg.pendingMessage) {
        error(t('send_error'), 'send', t('resend'));
      } else if (msg.activity === 'failed' && !sending && lastAsked) {
        // The run ended without an answer. Its "checking, one moment" no longer
        // holds, and the visitor gets a way forward instead of a silent stop.
        error(t('reply_error'), 'reply', t('resend'));
      } else if (errorKind === 'send' || errorKind === 'rate' || errorKind === 'connection' || errorKind === 'reply') {
        error();
      }

      controls();
      if (!closed && opened && !resetting && document.visibilityState !== 'hidden') {
        clearTimeout(timer);
        timer = setTimeout(requestSync, 3000);
      }
    } else if (msg.type === 'reset-done' && msg.nonce === nonce) {
      resetting = false;
      sending = false;
      pending = null;
      cursor = 0;
      sharedFiles.clear();
      composer.setValue('');
      $('transcript').querySelectorAll('.message').forEach(x => x.remove());
      holding.clear();
      settled.clear();
      $('welcome').hidden = false;
      $('reset-confirm').hidden = true;
      $('activity').textContent = t('connected');
      bottom();
      error();
      controls();
      requestSync();
    } else if (msg.type === 'unavailable' && typeof msg.nonce === 'string' && (!nonce || msg.nonce === nonce)) {
      nonce = msg.nonce;
      applyLanguage(msg.language);
      if (typeof msg.draft === 'string' && !$('text').value) composer.setValue(msg.draft);
      $('activity').textContent = t('cannot_connect');
      error(msg.error?.kind === 'expired' ? t('expired_error') : t('connect_error'),
        msg.error?.kind === 'expired' ? 'expired' : 'connection',
        msg.error?.kind === 'expired' ? t('new_conversation') : t('reconnect'));
      controls();
    } else if (msg.nonce === nonce) {
      if (msg.type === 'language') { applyLanguage(msg.language); applyConfig(lastConfig); controls(); }
      if (msg.type === 'open') expanded(true);
      if (msg.type === 'close') expanded(false);
      if (msg.type === 'reset') reset();
      if (msg.type === 'layout') {
        document.documentElement.dataset.layout = msg.mobile ? 'mobile' : 'desktop';
        controls();
        if (follow) bottom();
      }
    }
  });

  addEventListener('pagehide', () => {
    composer.destroy();
    closed = true;
    transcriptResize.disconnect();
    removeThemeListener();
    clearTimeout(timer);
  });

  // Handshake to parent on load
  if (parentOrigin) {
    parent.postMessage({ soot_chat: 1, type: 'ready' }, parentOrigin);
  }
})();
