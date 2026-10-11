/* Romzo website: language dropdown, relay node panel with latency, copy, highlighting. */
(function () {
  'use strict';

  /* ---------- relay nodes: edit this list to add or change public test nodes ---------- */
  var RELAY_NODES = [
    {
      label: 'romzo.net',
      origin: 'https://romzo.net',
      display: 'romzo.net',
      note: { en: 'No creation password · idle rooms are removed', zh: '免密建房 · 空闲房间会被清理' }
    }
  ];
  /* ------------------------------------------------------------------------------- */

  /* ---------- legal facts shown on terms.html: edit here, not in the HTML ---------- */
  var LEGAL = {
    region: { en: 'Singapore', zh: '新加坡' }
  };
  /* ------------------------------------------------------------------------------- */

  var root = document.documentElement;

  var T = {
    headLabel: { en: 'public test relay', zh: '公共测试节点' },
    wsPath: '/ws',
    copy: { en: 'copy', zh: '复制' },
    copied: { en: 'copied', zh: '已复制' },
    measuring: { en: 'pinging…', zh: '测速中…' },
    clickToPing: { en: 'click to ping', zh: '点击测速' },
    unreachable: { en: 'unreachable', zh: '不可达' },
    restTag: { en: 'REST', zh: 'REST' },
    wssTag: { en: 'WSS', zh: 'WSS' }
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
    var examples = document.querySelectorAll('pre');
    for (var n = 0; n < examples.length; n++) {
      examples[n].setAttribute('aria-label', langCode === 'zh' ? '代码示例' : 'Code example');
    }
    renderAll();
  }

  var langRoot = document.querySelector('.lang');
  var langBtn = document.querySelector('.lang > button');
  if (langBtn && langRoot) {
    langBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      langRoot.classList.toggle('open');
      langBtn.setAttribute('aria-expanded', String(langRoot.classList.contains('open')));
    });
    document.addEventListener('click', function (e) {
      if (!langRoot.contains(e.target)) {
        langRoot.classList.remove('open');
        langBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && langRoot.classList.contains('open')) {
        langRoot.classList.remove('open');
        langBtn.setAttribute('aria-expanded', 'false');
        langBtn.focus();
      }
    });
  }
  var langItems = document.querySelectorAll('.lang-menu button');
  for (var j = 0; j < langItems.length; j++) {
    langItems[j].addEventListener('click', function () {
      langRoot.classList.remove('open');
      langBtn.setAttribute('aria-expanded', 'false');
      langBtn.focus();
      setLang(this.dataset.setLang);
    });
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
        var note = document.createElement('span');
        note.textContent = pick(node.note);
        var terms = document.createElement('a');
        terms.href = 'terms.html';
        terms.textContent = pick({ zh: '服务条款', en: 'Terms' });
        foot.appendChild(note);
        foot.appendChild(terms);

        el.appendChild(head);
        el.appendChild(makeRow(pick(T.restTag), node.display || node.origin, node.display || node.origin));
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

  /* ---------- copy button on every code block ---------- */

  function addCopyButtons() {
    var blocks = document.querySelectorAll('pre');
    for (var k = 0; k < blocks.length; k++) {
      (function (pre) {
        if (pre.dataset.copyBtn) return;
        pre.dataset.copyBtn = '1';
        var code = pre.querySelector('code');
        if (!code) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-copy';
        btn.setAttribute('aria-label', pick(T.copy));
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg> ' + pick(T.copy);
        btn.addEventListener('click', function () { copyText(code.textContent, btn); });
        var head = pre.parentElement.querySelector('.code-head');
        if (head) head.appendChild(btn);
        else pre.before(btn);
        pre.tabIndex = 0;
        pre.setAttribute('aria-label', lang() === 'zh' ? '代码示例' : 'Code example');
      })(blocks[k]);
    }
  }

  function refreshCopyLabels() {
    var btns = document.querySelectorAll('.code-copy');
    for (var k = 0; k < btns.length; k++) {
      if (btns[k].classList.contains('done')) continue;
      btns[k].setAttribute('aria-label', pick(T.copy));
      btns[k].innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg> ' + pick(T.copy);
    }
  }

  /* ---------- background: drifting relay mesh ---------- */

  function startBgNet() {
    var reduced = false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (reduced) return;
    var canvas = document.createElement('canvas');
    if (!canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.id = 'bg-net';
    document.body.insertBefore(canvas, document.body.firstChild);

    var w = 0, h = 0, dpr = 1, nodes = [], packets = [], raf = null;
    var pointer = { x: -1e4, y: -1e4 };

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var count = Math.max(24, Math.min(64, Math.round(w * h / 30000)));
      while (nodes.length < count) nodes.push(spawn());
      nodes.length = count;
    }

    function spawn() {
      return {
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
        r: 1 + Math.random() * 1.4
      };
    }

    var LINK = 130;

    function step() {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.x += n.vx; n.y += n.vy;
        if (n.x < -20) n.x = w + 20; else if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20; else if (n.y > h + 20) n.y = -20;
        var dx = n.x - pointer.x, dy = n.y - pointer.y, d2 = dx * dx + dy * dy;
        if (d2 < 16000 && d2 > 1) {
          var d = Math.sqrt(d2), f = (1 - d / 126.5) * 0.35;
          n.x += dx / d * f; n.y += dy / d * f;
        }
      }
      // launch a packet along a random close pair every so often
      if (packets.length < 5 && Math.random() < 0.03) {
        for (var a = 0; a < nodes.length; a++) {
          for (var b = a + 1; b < nodes.length; b++) {
            var pdx = nodes[a].x - nodes[b].x, pdy = nodes[a].y - nodes[b].y;
            if (pdx * pdx + pdy * pdy < LINK * LINK && Math.random() < 0.02) {
              packets.push({ a: nodes[a], b: nodes[b], t: 0, speed: 0.008 + Math.random() * 0.012 });
              break;
            }
          }
          if (packets.length && packets[packets.length - 1].a === nodes[a]) break;
        }
      }
      for (var k = packets.length - 1; k >= 0; k--) {
        packets[k].t += packets[k].speed;
        if (packets[k].t >= 1) packets.splice(k, 1);
      }
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      var i, j;
      for (i = 0; i < nodes.length; i++) {
        for (j = i + 1; j < nodes.length; j++) {
          var dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          var d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            var alpha = (1 - Math.sqrt(d2) / LINK) * 0.07;
            ctx.strokeStyle = 'rgba(34,37,34,' + alpha.toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = 'rgba(34,37,34,0.14)';
      for (i = 0; i < nodes.length; i++) {
        ctx.beginPath();
        ctx.arc(nodes[i].x, nodes[i].y, nodes[i].r, 0, 6.2832);
        ctx.fill();
      }
      for (i = 0; i < packets.length; i++) {
        var p = packets[i], t = p.t;
        var x = p.a.x + (p.b.x - p.a.x) * t, y = p.a.y + (p.b.y - p.a.y) * t;
        ctx.fillStyle = 'rgba(189,66,28,0.55)';
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, 6.2832);
        ctx.fill();
      }
    }

    function loop() {
      step(); draw();
      raf = window.requestAnimationFrame(loop);
    }

    if (window.requestAnimationFrame) {
      resize();
      loop();
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          if (raf) window.cancelAnimationFrame(raf), raf = null;
        } else if (!raf) loop();
      });
      document.addEventListener('pointermove', function (e) {
        pointer.x = e.clientX; pointer.y = e.clientY;
      });
      document.addEventListener('pointerleave', function () {
        pointer.x = -1e4; pointer.y = -1e4;
      });
    }
  }

  /* ---------- legal facts (terms.html) ---------- */

  function renderLegal() {
    var els = document.querySelectorAll('[data-legal]');
    for (var i = 0; i < els.length; i++) {
      var v = LEGAL[els[i].dataset.legal];
      if (v) els[i].textContent = pick(v);
    }
  }

  /* ---------- render + init (order matters: everything above is defined) ---------- */

  function renderAll() {
    renderNodes();
    renderLegal();
    refreshCopyLabels();
  }

  var saved = null;
  try { saved = localStorage.getItem('romzo-lang'); } catch (e) {}
  if (!saved) saved = (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';

  highlightAll();
  addCopyButtons();
  startBgNet();
  setLang(saved);
})();
