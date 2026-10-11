/* Romzo website: language dropdown, relay node panel with latency, copy, highlighting. */
(function () {
  'use strict';

  /* ---------- relay nodes: edit this list to add or change public nodes ---------- */
  var RELAY_NODES = [
    {
      label: 'romzo.net',
      origin: 'https://romzo.net',
      note: { en: 'no creation password', zh: '免密钥建房' }
    }
  ];
  /* ------------------------------------------------------------------------------- */

  var root = document.documentElement;

  var T = {
    headLabel: { en: 'public relay', zh: '公共节点' },
    wsPath: '/ws',
    copy: { en: 'copy', zh: '复制' },
    copied: { en: 'copied', zh: '已复制' },
    measuring: { en: 'pinging…', zh: '测速中…' },
    clickToPing: { en: 'click to ping', zh: '点击测速' },
    unreachable: { en: 'unreachable', zh: '不可达' },
    restTag: { en: 'REST', zh: 'REST' },
    wssTag: { en: 'WSS', zh: 'WSS' },
    pill: {
      measuring: { en: 'pinging public relay…', zh: '正在测速…' },
      ok: { en: 'public relay online', zh: '公共节点在线' },
      warn: { en: 'public relay · high latency', zh: '公共节点 · 延迟偏高' },
      bad: { en: 'public relay unreachable', zh: '公共节点不可达' }
    }
  };

  function lang() { return root.dataset.lang || 'en'; }
  function pick(obj) { return obj[lang()] || obj.en; }

  /* ---------- language ---------- */

  function setLang(langCode) {
    root.dataset.lang = langCode;
    root.lang = langCode;
    try { localStorage.setItem('romzo-lang', langCode); } catch (e) {}
    var items = document.querySelectorAll('.lang-menu button');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('on', items[i].dataset.setLang === langCode);
    }
    renderAll();
  }

  var langRoot = document.querySelector('.lang');
  var langBtn = document.querySelector('.lang > button');
  if (langBtn && langRoot) {
    langBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      langRoot.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!langRoot.contains(e.target)) langRoot.classList.remove('open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') langRoot.classList.remove('open');
    });
  }
  var langItems = document.querySelectorAll('.lang-menu button');
  for (var j = 0; j < langItems.length; j++) {
    langItems[j].addEventListener('click', function () {
      langRoot.classList.remove('open');
      setLang(this.dataset.setLang);
    });
  }

  /* ---------- hero status pill ---------- */

  function setPill(state) {
    var dot = document.getElementById('hero-dot');
    var text = document.getElementById('hero-status');
    if (!dot || !text) return;
    dot.className = 'dot' + (state ? ' ' + state : '');
    text.textContent = pick(T.pill[state] || T.pill.measuring);
  }

  /* ---------- relay node panel ---------- */

  function copyText(text, btn) {
    function done() {
      var old = btn.innerHTML;
      btn.classList.add('done');
      btn.textContent = pick(T.copied);
      setTimeout(function () { btn.classList.remove('done'); btn.innerHTML = old; }, 1400);
    }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { if (document.execCommand('copy')) done(); } catch (e) {}
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, legacy);
    } else { legacy(); }
  }

  function ping(origin) {
    return new Promise(function (resolve) {
      var finished = false;
      var t0 = performance.now();
      var timer = setTimeout(function () {
        if (!finished) { finished = true; resolve(null); }
      }, 5000);
      fetch(origin + '/', { mode: 'no-cors', cache: 'no-store' }).then(function () {
        if (!finished) { finished = true; clearTimeout(timer); resolve(performance.now() - t0); }
      }, function () {
        if (!finished) { finished = true; clearTimeout(timer); resolve(null); }
      });
    });
  }

  function stateFor(ms) {
    return ms < 120 ? 'ok' : ms < 400 ? 'warn' : 'bad';
  }

  function measure(node, ui) {
    ui.setPing('measuring');
    var attempts = 3;
    var best = null;
    function round() {
      return ping(node.origin).then(function (ms) {
        if (ms !== null) {
          ms = Math.round(ms);
          if (best === null || ms < best) best = ms;
          ui.setPing(stateFor(best), best);
        } else if (best === null) {
          ui.setPing('bad');
        }
        if (--attempts > 0) return round();
      });
    }
    round();
  }

  function wsUrl(origin) {
    return origin.replace(/^http/, 'ws') + T.wsPath;
  }

  function makeRow(tag, address, copyValue) {
    var row = document.createElement('div');
    row.className = 'node-row';

    var left = document.createElement('div');
    left.className = 'node-addr';
    var chip = document.createElement('span');
    chip.className = 'proto';
    chip.textContent = tag;
    var code = document.createElement('code');
    code.textContent = address;
    left.appendChild(chip);
    left.appendChild(code);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg> ' + pick(T.copy);
    btn.addEventListener('click', function () { copyText(copyValue, btn); });

    row.appendChild(left);
    row.appendChild(btn);
    return row;
  }

  function renderNodes() {
    var holder = document.getElementById('node-panel');
    if (!holder) return;
    holder.innerHTML = '';
    for (var i = 0; i < RELAY_NODES.length; i++) {
      (function (node) {
        var el = document.createElement('div');
        el.className = 'node';

        var head = document.createElement('div');
        head.className = 'node-head';
        var dot = document.createElement('span');
        dot.className = 'dot';
        var label = document.createElement('span');
        label.textContent = node.label + ' · ' + pick(T.headLabel);
        var grow = document.createElement('span');
        grow.className = 'grow';
        var pingBtn = document.createElement('button');
        pingBtn.type = 'button';
        pingBtn.className = 'ping';
        pingBtn.textContent = pick(T.clickToPing);
        head.appendChild(dot);
        head.appendChild(label);
        head.appendChild(grow);
        head.appendChild(pingBtn);

        var foot = document.createElement('div');
        foot.className = 'node-foot';
        foot.textContent = pick(node.note);

        el.appendChild(head);
        el.appendChild(makeRow(pick(T.restTag), node.origin, node.origin));
        el.appendChild(makeRow(pick(T.wssTag), wsUrl(node.origin), wsUrl(node.origin)));
        el.appendChild(foot);
        holder.appendChild(el);

        var ui = {
          setPing: function (state, ms) {
            pingBtn.className = 'ping' + (state ? ' ' + state : '');
            dot.className = 'dot' + (state ? ' ' + state : '');
            if (state === 'measuring') pingBtn.textContent = pick(T.measuring);
            else if (state === 'bad') pingBtn.textContent = pick(T.unreachable);
            else pingBtn.textContent = ms + ' ms';
            if (i === 0) setPill(state);
          }
        };
        pingBtn.addEventListener('click', function () { measure(node, ui); });
        measure(node, ui);
      })(RELAY_NODES[i]);
    }
  }

  /* ---------- minimal syntax highlighting ---------- */

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightTS(src) {
    var re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|export|const|let|await|async|new|return|type|function|of)\b|\b(\d[\d_]*)\b/g;
    return escapeHtml(src).replace(re, function (m, c, s, k, n) {
      if (c) return '<span class="tok-c">' + c + '</span>';
      if (s) return '<span class="tok-s">' + s + '</span>';
      if (k) return '<span class="tok-k">' + k + '</span>';
      return '<span class="tok-n">' + n + '</span>';
    });
  }

  function highlightSH(src) {
    var re = /(#[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|\b(\d[\w.]*)\b/g;
    return escapeHtml(src).replace(re, function (m, c, s, n) {
      if (c) return '<span class="tok-c">' + c + '</span>';
      if (s) return '<span class="tok-s">' + s + '</span>';
      return '<span class="tok-n">' + n + '</span>';
    });
  }

  function highlightAll() {
    var blocks = document.querySelectorAll('pre code');
    for (var k = 0; k < blocks.length; k++) {
      var el = blocks[k];
      el.innerHTML = el.dataset.lang === 'sh' ? highlightSH(el.textContent) : highlightTS(el.textContent);
    }
  }

  /* ---------- render + init (order matters: everything above is defined) ---------- */

  function renderAll() {
    renderNodes();
  }

  var saved = null;
  try { saved = localStorage.getItem('romzo-lang'); } catch (e) {}
  if (!saved) saved = (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';

  highlightAll();
  setLang(saved);
})();
