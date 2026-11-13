/* Mesafe Kuşu: Arduino mesafe sensörü (Web Serial) ya da Boşluk tuşuyla kontrol edilen engel geçme oyunu.
   Bölümlü ve Sonsuz mod, puan, tam ekran, animasyonlu açılış. Tamamen özgün çizim ve kod. */
(function () {
    'use strict';
    var el = window.LabCore.el;
    var MOCK = /[?&]mock=1/.test(window.location.search);   // yalnızca test: sahte sensör verisi

    var W = 960, H = 540, GROUND = 56, BIRD_R = 15, BIRD_X = 190, OB_W = 74, LIVES = 3;
    var IDLE_MS = MOCK ? 1e9 : 90000;                       // vitrinde: boşta kalınca açılış ekranına dön
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function kmh(speed) { return Math.round(speed * 0.36); }

    // ------------------------------------------------------------ etkinlik takibi (boşta kalma)
    var lastActive = Date.now();
    var busyGame = false;
    function markActive() { lastActive = Date.now(); }
    ['pointerdown', 'pointermove', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, markActive, { passive: true }); });

    // ------------------------------------------------------------ ayarlar ve rekorlar
    var SET_KEY = 'mk:settings:v1', BEST_KEY = 'mk:best:v1';
    var supported = !!(navigator && navigator.serial);
    var defaults = { mode: supported || MOCK ? 'sensor' : 'space', dmin: 8, dmax: 40, invert: false, baud: 115200, sens: 3 };   // sens: 1 (çok yumuşak) .. 5 (çok hızlı)
    var settings = (function () {
        try { var raw = window.localStorage.getItem(SET_KEY); if (raw) return Object.assign({}, defaults, JSON.parse(raw)); } catch (e) { /* kayıt yok */ }
        return Object.assign({}, defaults);
    })();
    function saveSettings() { try { window.localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) { /* sessiz */ } }
    function getBest(kind) { try { var b = JSON.parse(window.localStorage.getItem(BEST_KEY) || '{}'); return Number(b[kind]) || 0; } catch (e) { return 0; } }
    function setBest(kind, v) { try { var b = JSON.parse(window.localStorage.getItem(BEST_KEY) || '{}'); b[kind] = v; window.localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch (e) { /* sessiz */ } }

    // ------------------------------------------------------------ Arduino seri bağlantısı (Web Serial)
    var STALE_MS = 3000;       // bu süre hiçbir satır gelmezse "veri durdu" sayılır (kart canlıyken el menzil dışında olsa bile -1 satırları akar)
    var serial = { port: null, reader: null, gen: 0, connected: false, status: '', last: null, lastAt: 0, beatAt: 0, openedAt: 0, noEcho: false, noEchoSince: 0, win: [], buf: '', skipFirst: false, wanted: false, opening: false, retries: 0, baud: 115200, onChange: null };
    function notify() { if (serial.onChange) { try { serial.onChange(); } catch (e) { /* arayüz kapanmış olabilir */ } } }
    // Hassasiyet kademeleri: win = ortanca penceresi, a0/a1 = yavaş/hızlı harekette yumuşatma katsayısı, dead = ölü bölge (cm)
    var SENS = [
        { win: 7, a0: 0.10, a1: 0.45, dead: 1.0 },
        { win: 5, a0: 0.18, a1: 0.60, dead: 0.6 },
        { win: 3, a0: 0.30, a1: 0.85, dead: 0.4 },
        { win: 3, a0: 0.45, a1: 0.95, dead: 0.25 },
        { win: 1, a0: 0.70, a1: 1.00, dead: 0.1 }
    ];
    function pushReading(cm) {
        var sp = SENS[clamp((Number(settings.sens) || 3) - 1, 0, 4)];
        serial.win.push(cm);
        while (serial.win.length > sp.win) serial.win.shift();
        var sorted = serial.win.slice().sort(function (a, b) { return a - b; });
        var med = sorted[Math.floor(sorted.length / 2)];            // ortanca: tek seferlik hatalı okumaları eler
        if (serial.last === null) serial.last = med;
        else {
            var d = med - serial.last, ad = Math.abs(d);
            // Ölü bölge: el duruyorsa küçük dalgalanmalar kuşu oynatmaz. Hızlı hareket: katsayı büyür, gecikme olmaz.
            if (ad >= sp.dead) serial.last += d * (sp.a0 + (sp.a1 - sp.a0) * Math.min(1, ad / 12));
        }
        serial.lastAt = performance.now();
        serial.beatAt = serial.lastAt;
        serial.noEcho = false;
        markActive();
    }
    function parseLine(line) {
        var t = String(line).trim();
        if (!/^-?\d+(?:[.,]\d+)?$/.test(t)) return;                  // yalnızca saf sayı satırı: başlık/çöp/yarım satırlar yok sayılır
        var v = parseFloat(t.replace(',', '.'));
        if (!isFinite(v)) return;
        if (v <= 0) {                                                // -1: kart canlı ama yankı yok (el menzil dışında)
            var now = performance.now();
            if (!serial.noEcho) serial.noEchoSince = now;
            serial.noEcho = true; serial.beatAt = now; markActive();
            return;
        }
        if (v > 400) return;
        pushReading(v);
    }
    // 'off' bağlı değil · 'wait' kart başlıyor · 'silent' bağlı ama hiç veri yok · 'stale' veri durdu · 'nohand' el yok · 'ok' çalışıyor
    function sensorState() {
        if (!serial.connected) return 'off';
        var now = performance.now();
        if (serial.beatAt === 0) return now - serial.openedAt > 5000 ? 'silent' : 'wait';
        if (now - serial.beatAt > STALE_MS) return 'stale';
        if (serial.last === null || serial.noEcho) return 'nohand';
        return 'ok';
    }
    function feed(text) {
        serial.buf += text;
        var i;
        while ((i = serial.buf.search(/[\r\n]/)) >= 0) {
            var line = serial.buf.slice(0, i);
            serial.buf = serial.buf.slice(i + 1);
            if (serial.skipFirst) { serial.skipFirst = false; continue; }   // bağlanma anında yarım kalmış ilk satırı at
            parseLine(line);
        }
        if (serial.buf.length > 256) serial.buf = '';
    }
    function openPort(port, baud) {
        // Zaten bağlıysak ya da açılış sürüyorsa ikinci kez açma: Arduino bir kez daha yeniden başlar ve
        // (otomatik bağlanma + elle bağlan düğmesi aynı anda çalışınca) çalışan okuma döngüsü etkisiz kalırdı.
        if (serial.connected || serial.opening) return Promise.resolve();
        serial.opening = true; serial.baud = baud;
        // Arduino Uno/Nano port açılınca kendini yeniden başlatır; büyük tampon, sayfa kısa süre takılsa da taşmayı önler (varsayılan yalnızca 255 bayt).
        return port.open({ baudRate: baud, bufferSize: 8192 }).then(function () {
            var gen = ++serial.gen;
            serial.opening = false;
            serial.port = port; serial.connected = true; serial.status = 'Bağlandı'; serial.wanted = true;
            serial.win = []; serial.last = null; serial.buf = ''; serial.skipFirst = true;
            serial.beatAt = 0; serial.noEcho = false; serial.openedAt = performance.now(); serial.retries = 0;
            readLoop(port, gen);
            notify();
        }, function (e) { serial.opening = false; throw e; });
    }
    function connectSerial(baud) {
        if (!supported) return Promise.reject(new Error('Bu tarayıcı USB seri bağlantıyı desteklemiyor.'));
        return navigator.serial.requestPort().then(function (p) { return openPort(p, baud); });
    }
    function readLoop(port, gen) {
        var dec = new window.TextDecoder();
        function alive() { return gen === serial.gen && serial.port === port; }
        (function outer() {
            if (!alive()) return;
            if (!port.readable) { lost(port, 'Bağlantı koptu'); return; }
            var reader;
            try { reader = port.readable.getReader(); } catch (e) { lost(port, 'Okuyucu açılamadı'); return; }
            serial.reader = reader;
            (function step() {
                reader.read().then(function (r) {
                    if (!alive()) { try { reader.releaseLock(); } catch (e) { /* zaten bırakıldı */ } return; }
                    if (r.done) { try { reader.releaseLock(); } catch (e) { /* zaten bırakıldı */ } serial.reader = null; lost(port, 'Bağlantı kapandı'); return; }
                    serial.retries = 0;
                    if (r.value && r.value.length) feed(dec.decode(r.value, { stream: true }));
                    step();
                }).catch(function (e) {
                    try { reader.releaseLock(); } catch (x) { /* zaten bırakıldı */ }
                    serial.reader = null;
                    if (!alive()) return;
                    // Tampon taşması / çerçeve / parite hataları ölümcül DEĞİL: port.readable durur, yeni okuyucuyla devam edilir.
                    if (port.readable && ++serial.retries <= 25) { setTimeout(outer, 20); return; }
                    lost(port, 'Bağlantı koptu' + (e && e.name ? ' (' + e.name + ')' : ''));
                });
            })();
        })();
    }
    function lost(port, why) {   // beklenmedik kopma: durumu yaz, portu temizle, otomatik yeniden bağlanmayı dene
        if (serial.port !== port) return;
        serial.status = why;
        closeSerial(true).then(function () { autoReconnect(port, 1); });
    }
    function autoReconnect(port, n) {
        if (!serial.wanted || serial.connected || !supported) return;
        if (n > 5) { serial.status = 'Bağlantı koptu: kabloyu kontrol edip yeniden bağla'; notify(); return; }
        serial.status = 'Yeniden bağlanıyor… (' + n + '/5)'; notify();
        setTimeout(function () {
            if (!serial.wanted || serial.connected) return;
            openPort(port, serial.baud).catch(function () { autoReconnect(port, n + 1); });
        }, 900 * n);
    }
    function closeSerial(userStop) {
        if (userStop === false) serial.wanted = false;               // kullanıcı kendisi kesti: otomatik yeniden bağlanma yok
        var reader = serial.reader, port = serial.port;
        serial.gen++;                                                // çalışan okuma döngüsünü etkisiz kıl
        serial.reader = null; serial.port = null; serial.connected = false; serial.last = null; serial.beatAt = 0; serial.noEcho = false;
        if (!port) { notify(); return Promise.resolve(); }
        return Promise.resolve()
            .then(function () { return reader ? reader.cancel() : null; }).catch(function () { })
            .then(function () { try { if (reader) reader.releaseLock(); } catch (e) { /* zaten bırakıldı */ } })
            .then(function () { return port.close(); }).catch(function () { })
            .then(function () { if (!serial.status || serial.status === 'Bağlandı') serial.status = 'Bağlantı kapandı'; notify(); });
    }
    if (supported) {
        navigator.serial.addEventListener('disconnect', function (e) {
            if (serial.port && e && e.target && e.target !== serial.port) return;
            serial.status = 'Kablo çıkarıldı'; closeSerial(true);
        });
        // Kablo geri takılınca (ya da kart yeniden başlayıp port yeniden görününce) kullanıcı bağlıydıysa kendiliğinden bağlan.
        navigator.serial.addEventListener('connect', function (e) {
            if (serial.wanted && !serial.connected && e && e.target) openPort(e.target, serial.baud).catch(function () { autoReconnect(e.target, 1); });
        });
        // Daha önce izin verilmiş tek bir kart varsa sayfa açılırken tekrar seçtirmeden bağlan.
        if (!MOCK && settings.mode === 'sensor' && navigator.serial.getPorts) {
            navigator.serial.getPorts().then(function (ports) {
                if (ports.length === 1 && !serial.connected) { serial.wanted = true; return openPort(ports[0], settings.baud || 115200); }
            }).catch(function () { serial.wanted = false; /* port meşgul olabilir: elle bağlan */ });
        }
    }
    if (MOCK) { window.__MK = { feed: function (cm) { serial.connected = true; serial.status = 'Sahte sensör'; pushReading(cm); }, state: null, settings: settings, serial: serial, parse: parseLine, openPort: openPort, sensorState: sensorState, closeSerial: closeSerial, idle: function (ms) { lastActive = Date.now() - ms; } }; }

    // ------------------------------------------------------------ eşleme: el mesafesi -> kuşun yüksekliği
    function handT() {   // 0 = en yakın (aşağı), 1 = en uzak (yukarı)
        var lo = settings.dmin, hi = Math.max(lo + 1, settings.dmax);
        var t = clamp(((serial.last === null ? lo : serial.last) - lo) / (hi - lo), 0, 1);
        return settings.invert ? 1 - t : t;
    }
    function handToY() {
        var top = BIRD_R + 6, bottom = H - GROUND - BIRD_R - 6;
        return bottom - handT() * (bottom - top);
    }

    // ------------------------------------------------------------ çizim yardımcıları
    function pill(ctx, x, y, w, h, fill) {
        var r = h / 2;
        ctx.fillStyle = fill; ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2); ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5); ctx.closePath(); ctx.fill();
    }
    function drawBackground(ctx, t) {
        var sky = ctx.createLinearGradient(0, 0, 0, H - GROUND);
        sky.addColorStop(0, '#7dd3fc'); sky.addColorStop(1, '#e0f2fe');
        ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        for (var i = 0; i < 5; i++) {
            var cx = ((i * 230 - t * (18 + i * 6)) % (W + 200) + (W + 200)) % (W + 200) - 100, cy = 70 + (i % 3) * 60;
            ctx.beginPath(); ctx.arc(cx, cy, 26, 0, 7); ctx.arc(cx + 28, cy + 6, 22, 0, 7); ctx.arc(cx - 28, cy + 8, 20, 0, 7); ctx.fill();
        }
        ctx.fillStyle = '#86efac';
        ctx.beginPath(); ctx.moveTo(0, H - GROUND);
        for (var x = 0; x <= W; x += 40) ctx.lineTo(x, H - GROUND - 40 - 22 * Math.sin((x + t * 12) / 90));
        ctx.lineTo(W, H - GROUND); ctx.fill();
        var g = ctx.createLinearGradient(0, H - GROUND, 0, H);
        g.addColorStop(0, '#65a30d'); g.addColorStop(0.18, '#92400e'); g.addColorStop(1, '#78350f');
        ctx.fillStyle = g; ctx.fillRect(0, H - GROUND, W, GROUND);
    }
    function drawPillar(ctx, x, y, w, h, capAtBottom) {
        if (h <= 0) return;
        var g = ctx.createLinearGradient(x, 0, x + w, 0);
        g.addColorStop(0, '#94a3b8'); g.addColorStop(0.5, '#cbd5e1'); g.addColorStop(1, '#64748b');
        ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(51,65,85,.45)'; ctx.lineWidth = 2;
        for (var yy = y + 26; yy < y + h; yy += 28) { ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke(); }
        var capY = capAtBottom ? y + h - 20 : y;   // başlık her zaman geçidin kenarında
        ctx.fillStyle = '#475569'; ctx.fillRect(x - 6, capY, w + 12, 20);
    }
    function drawBird(ctx, x, y, tilt, t, blink) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(tilt);
        if (blink) ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#0d9488';                                    // kuyruk
        ctx.beginPath(); ctx.moveTo(-14, -2); ctx.lineTo(-34, -10); ctx.lineTo(-30, 2); ctx.lineTo(-34, 12); ctx.lineTo(-14, 8); ctx.fill();
        var body = ctx.createRadialGradient(-4, -6, 3, 0, 0, 22);
        body.addColorStop(0, '#5eead4'); body.addColorStop(1, '#0f766e');
        ctx.fillStyle = body; ctx.beginPath(); ctx.arc(0, 0, 19, 0, 7); ctx.fill();
        ctx.fillStyle = '#ccfbf1'; ctx.beginPath(); ctx.ellipse(2, 9, 11, 7, 0, 0, 7); ctx.fill();   // karın
        ctx.fillStyle = '#f59e0b';                                    // tepelik
        for (var i = -1; i <= 1; i++) { ctx.beginPath(); ctx.ellipse(i * 6 - 2, -21, 3.2, 8, i * 0.4, 0, 7); ctx.fill(); }
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(7, -4, 6.5, 0, 7); ctx.fill();               // göz
        ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.arc(9, -3, 3.2, 0, 7); ctx.fill();
        ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 4; ctx.lineCap = 'round';                        // kızgın kaş
        ctx.beginPath(); ctx.moveTo(-1, -13); ctx.lineTo(14, -7); ctx.stroke();
        ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.moveTo(15, -3); ctx.lineTo(32, 3); ctx.lineTo(15, 9); ctx.closePath(); ctx.fill();   // gaga
        ctx.save(); ctx.translate(-7, 4); ctx.rotate(Math.sin(t * 18) * 0.5 - 0.3);                  // kanat
        ctx.fillStyle = '#115e59'; ctx.beginPath(); ctx.ellipse(-4, 0, 12, 6, 0, 0, 7); ctx.fill(); ctx.restore();
        ctx.restore();
    }
    function drawStar(ctx, x, y, r) {
        ctx.fillStyle = '#fbbf24'; ctx.strokeStyle = '#b45309'; ctx.lineWidth = 2; ctx.beginPath();
        for (var i = 0; i < 10; i++) { var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    function circleRect(cx, cy, r, rx, ry, rw, rh) {
        var nx = clamp(cx, rx, rx + rw), ny = clamp(cy, ry, ry + rh), dx = cx - nx, dy = cy - ny;
        return dx * dx + dy * dy < r * r;
    }

    // ------------------------------------------------------------ oyun ekranı (bölüm ya da sonsuz mod)
    function renderTask(host, task, api) {
        var endless = !!task.endless;
        var P = task.params;
        var kind = endless ? 'endless' : 'level';
        var canvas = el('canvas', { class: 'mk-canvas', width: W, height: H, role: 'img', 'aria-label': 'Mesafe Kuşu oyun alanı' });
        var ctx = canvas.getContext('2d');
        function fitCanvas() {
            var cssW = canvas.clientWidth || W;
            var scale = clamp(cssW * (window.devicePixelRatio || 1) / W, 1, 3);
            canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
        }
        var overlay = el('div', { class: 'mk-overlay' });
        var fsBtn = el('button', { class: 'mk-fs', type: 'button', 'aria-label': 'Tam ekran', title: 'Tam ekran (F)' }, '⛶');
        var stage = el('div', { class: 'mk-stage' }, canvas, overlay, fsBtn);

        function dyn(passed) {   // sonsuz mod: her engelde zorluk artar
            return { speed: Math.min(540, 175 + passed * 5.5), gap: Math.max(118, 240 - passed * 3.4), spacing: Math.max(250, 370 - passed * 2.6), jump: Math.min(230, 140 + passed * 3), osc: passed >= 15 ? Math.min(70, (passed - 14) * 5) : 0 };
        }
        var st;
        function cur() { return endless ? dyn(st.passed) : P; }
        function fresh() {
            return { status: 'ready', y: (H - GROUND) / 2, vy: 0, tilt: 0, obs: [], stars: 0, passed: 0, spawned: 0, lives: LIVES, invul: 0, count: 0, since: (P.spacing || 360) - 330, lastCenter: (H - GROUND) / 2, hold: false, t: 0, reason: '', score: 0, passPts: 0, starPts: 0, maxSpeed: 0, pops: [], banner: null, newBest: false, best: getBest(kind) };
        }
        st = fresh();
        if (MOCK) window.__MK.state = function () { return st; };

        // ---- kumanda paneli
        var chip = el('span', { class: 'mk-chip' });
        var reading = el('output', { class: 'mk-read', text: '— cm' });
        var marker = el('i', { class: 'mk-marker' });
        var gauge = el('div', { class: 'mk-gauge', title: 'Elinin konumu' }, el('span', { class: 'mk-gauge-top', text: 'uzak' }), el('div', { class: 'mk-gauge-bar' }, marker), el('span', { class: 'mk-gauge-bot', text: 'yakın' }));
        var connectBtn = el('button', { class: 'lab-btn primary', type: 'button' }, '🔌 Arduino\'yu bağla');
        var disconnectBtn = el('button', { class: 'lab-btn', type: 'button' }, 'Bağlantıyı kes');
        var baudSel = el('select', { class: 'mk-sel', 'aria-label': 'Baud hızı' });
        [9600, 57600, 115200].forEach(function (b) { var o = el('option', { value: b, text: b + ' baud' }); if (b === settings.baud) o.selected = true; baudSel.appendChild(o); });
        baudSel.addEventListener('change', function () { settings.baud = Number(baudSel.value); saveSettings(); });
        var minIn = el('input', { type: 'number', min: 2, max: 150, step: 1, value: settings.dmin, 'aria-label': 'En yakın mesafe (cm)' });
        var maxIn = el('input', { type: 'number', min: 5, max: 200, step: 1, value: settings.dmax, 'aria-label': 'En uzak mesafe (cm)' });
        function readCal() { settings.dmin = clamp(Number(minIn.value) || 8, 2, 150); settings.dmax = clamp(Number(maxIn.value) || 40, settings.dmin + 3, 200); saveSettings(); }
        minIn.addEventListener('change', function () { readCal(); minIn.value = settings.dmin; maxIn.value = settings.dmax; });
        maxIn.addEventListener('change', function () { readCal(); minIn.value = settings.dmin; maxIn.value = settings.dmax; });
        var takeMin = el('button', { class: 'lab-btn', type: 'button' }, 'Elim en yakında → al');
        var takeMax = el('button', { class: 'lab-btn', type: 'button' }, 'Elim en uzakta → al');
        takeMin.addEventListener('click', function () { if (serial.last === null) { api.toast('Önce sensörden veri gelmeli.'); return; } settings.dmin = Math.round(serial.last); minIn.value = settings.dmin; readCal(); maxIn.value = settings.dmax; });
        takeMax.addEventListener('click', function () { if (serial.last === null) { api.toast('Önce sensörden veri gelmeli.'); return; } settings.dmax = Math.round(serial.last); maxIn.value = settings.dmax; readCal(); minIn.value = settings.dmin; });
        var invertIn = el('input', { type: 'checkbox' });
        invertIn.checked = !!settings.invert;
        invertIn.addEventListener('change', function () { settings.invert = invertIn.checked; saveSettings(); });
        var msg = el('p', { class: 'mk-msg', role: 'status' });
        var sensIn = el('input', { type: 'range', min: 1, max: 5, step: 1, value: settings.sens, 'aria-label': 'Hassasiyet' });
        var sensVal = el('b', { text: '' });
        function sensLabel() { return ['Çok yumuşak', 'Yumuşak', 'Dengeli', 'Hızlı', 'Çok hızlı'][clamp((Number(settings.sens) || 3) - 1, 0, 4)]; }
        sensVal.textContent = sensLabel();
        sensIn.addEventListener('input', function () { settings.sens = clamp(Number(sensIn.value) || 3, 1, 5); saveSettings(); serial.win = []; sensVal.textContent = sensLabel(); });
        var sensRow = el('div', { class: 'mk-row mk-sens' }, el('label', { text: 'Hassasiyet:' }), sensIn, sensVal,
            el('small', { text: 'Sola: titreşim az, biraz geç tepki · Sağa: anında tepki, biraz titrek' }));

        var modeSensor = el('button', { class: 'mk-mode', type: 'button', role: 'radio' }, el('span', { class: 'ico', text: '🖐️' }), el('b', { text: 'Sensör (Arduino)' }), el('small', { text: 'Elinin mesafesi kuşu yönetir' }));
        var modeSpace = el('button', { class: 'mk-mode', type: 'button', role: 'radio' }, el('span', { class: 'ico', text: '⌨️' }), el('b', { text: 'Boşluk tuşu' }), el('small', { text: 'Basılı tut: yukarı · bırak: aşağı' }));
        var sensorPanel = el('div', { class: 'mk-panel' },
            el('div', { class: 'mk-row' }, connectBtn, disconnectBtn, baudSel, chip),
            el('div', { class: 'mk-live' }, gauge, el('div', { class: 'mk-live-txt' }, reading, el('small', { text: 'Sensörden gelen anlık mesafe' }))),
            el('div', { class: 'mk-cal' },
                el('label', { text: 'En yakın (cm)' }), minIn, el('label', { text: 'En uzak (cm)' }), maxIn),
            el('div', { class: 'mk-row' }, takeMin, takeMax, el('label', { class: 'mk-inv' }, invertIn, ' Yönü ters çevir')),
            sensRow,
            msg);
        var spacePanel = el('div', { class: 'mk-panel' }, el('p', { class: 'mk-help', html: '<b>Boşluk</b> tuşunu (ya da ekrana dokunarak) <b>basılı tut</b>: kuş yükselir. <b>Bırakınca</b> aşağı düşer.' }));
        var setup = el('details', { class: 'mk-setup' }, el('summary', { text: 'Arduino kurulum rehberi' }),
            el('ol', null,
                el('li', { html: 'HC-SR04: <b>VCC→5V</b>, <b>GND→GND</b>, <b>TRIG→D9</b>, <b>ECHO→D10</b>.' }),
                el('li', { html: 'Aşağıdaki kodu Arduino IDE ile karta yükle, sonra <b>Seri Monitörü kapat</b>.' }),
                el('li', { html: 'Bu sayfada <b>"Arduino\'yu bağla"</b>ya bas, listeden kartı seç. Baud: <b>115200</b>. Kart bağlanınca 1-2 sn yeniden başlar, bekle.' }),
                el('li', { html: 'Elini sensörün 8-40 cm önünde yukarı aşağı oynat; gerekirse mesafe aralığını ayarla.' }),
                el('li', { html: 'Yalnızca <b>masaüstü Chrome / Edge</b> destekler (USB seri bağlantı).' })),
            el('div', { class: 'mk-row' }, el('a', { class: 'lab-btn', href: './mesafe-kusu.ino?v=4', download: 'mesafe-kusu.ino' }, '⬇ Arduino kodunu indir')));
        var control = el('div', { class: 'mk-card' }, el('h3', { text: 'Kumanda' }), el('div', { class: 'mk-modes', role: 'radiogroup', 'aria-label': 'Kontrol yöntemi' }, modeSensor, modeSpace), sensorPanel, spacePanel, setup);

        host.appendChild(el('div', { class: 'mk-layout' }, el('div', { class: 'mk-main' }, stage, el('p', { class: 'mk-keys', text: 'Duraklat: P veya Esc · Tam ekran: F' })), control));

        function sensorFresh() { return sensorState() === 'ok'; }
        function sensorHelp(ss) {
            if (ss === 'off') return 'Önce Arduino\'yu USB ile bağla ve "Arduino\'yu bağla"ya bas.';
            if (ss === 'wait') return 'Arduino bağlandı, kart başlıyor. Birkaç saniye bekle.';
            if (ss === 'silent') return 'Arduino bağlı ama veri gelmiyor. Kodun karta yüklendiğini, Seri Monitörün kapalı olduğunu ve baud hızının 115200 olduğunu kontrol et.';
            if (ss === 'stale') return 'Veri durdu. USB kablosunu ve sensör bağlantılarını kontrol et.';
            if (ss === 'nohand') return 'Elini sensörün 5-40 cm önüne getir.';
            return '';
        }
        function refreshPanel() {
            var sensor = settings.mode === 'sensor';
            modeSensor.setAttribute('aria-checked', String(sensor)); modeSpace.setAttribute('aria-checked', String(!sensor));
            modeSensor.classList.toggle('on', sensor); modeSpace.classList.toggle('on', !sensor);
            sensorPanel.hidden = !sensor; spacePanel.hidden = sensor;
            connectBtn.hidden = serial.connected; disconnectBtn.hidden = !serial.connected; baudSel.disabled = serial.connected;
            connectBtn.disabled = !supported && !MOCK;
            var ss = sensorState();
            var chipTxt = { wait: 'Kart başlatılıyor…', silent: 'Bağlı ama veri gelmiyor', stale: 'Veri durdu', nohand: serial.last === null && !serial.noEcho ? 'Veri bekleniyor' : 'El algılanmadı', ok: 'Bağlı' };
            chip.textContent = serial.connected ? ('● ' + (chipTxt[ss] || serial.status || 'Bağlı')) : ('○ ' + (serial.status || (supported ? 'Bağlı değil' : 'Desteklenmiyor')));
            chip.className = 'mk-chip ' + (ss === 'ok' || ss === 'nohand' ? 'ok' : 'off');
            if (!supported && !MOCK) msg.textContent = 'Bu tarayıcı USB seri bağlantıyı desteklemiyor. Masaüstünde Chrome veya Edge kullan ya da Boşluk tuşu modunu seç.';
            else if (sensor) msg.textContent = sensorHelp(ss);
            else msg.textContent = '';
        }
        function setMode(m) { settings.mode = m; saveSettings(); refreshPanel(); if (st.status === 'play') pause('mode'); drawOverlay(); }
        modeSensor.addEventListener('click', function () { setMode('sensor'); });
        modeSpace.addEventListener('click', function () { setMode('space'); });
        serial.onChange = function () { refreshPanel(); drawOverlay(); };
        connectBtn.addEventListener('click', function () {
            connectBtn.disabled = true;
            connectSerial(Number(baudSel.value)).catch(function (e) {
                serial.status = (e && e.name === 'NotFoundError') ? 'Kart seçilmedi' : ((e && e.message) || 'Bağlanamadı');
                if (e && /busy|in use|Failed to open/i.test(String(e.message))) serial.status = 'Port meşgul: Seri Monitörü kapat';
            }).then(function () { connectBtn.disabled = !supported && !MOCK; refreshPanel(); drawOverlay(); });
        });
        disconnectBtn.addEventListener('click', function () { serial.status = 'Bağlantı kesildi'; closeSerial(false); if (st.status === 'play') pause('sensor'); });

        // ---- tam ekran (tarayıcı izin vermezse "tam sayfa" moduna düşer)
        var pfs = false;
        function fsOn() { return document.fullscreenElement === stage || document.webkitFullscreenElement === stage; }
        function syncFsUi() {
            var on = pfs || fsOn();
            stage.classList.toggle('is-fs', on); stage.classList.toggle('is-pfs', pfs);
            document.documentElement.classList.toggle('mk-noscroll', pfs);
            fsBtn.textContent = on ? '✕' : '⛶'; fsBtn.setAttribute('aria-label', on ? 'Tam ekrandan çık' : 'Tam ekran');
            window.setTimeout(fitCanvas, 80);
        }
        function setPfs(on) { pfs = on; syncFsUi(); }
        function toggleFs() {
            if (fsOn()) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) { /* yok say */ } return; }
            if (pfs) { setPfs(false); return; }
            var req = stage.requestFullscreen || stage.webkitRequestFullscreen;
            var fell = false;
            function fallback(err) {
                if (fell || fsOn()) return; fell = true;
                if (err && window.console) { window.console.warn('Tam ekran reddedildi:', err.name, err.message); }
                setPfs(true);
                api.toast('Tarayıcı tam ekrana izin vermedi; tam sayfa modu açıldı. Çıkmak için ✕ ya da Esc.');
            }
            if (!req) { fallback(); return; }
            try {
                var p = req.call(stage);
                if (p && p.catch) p.catch(fallback);   // reddedilirse hemen yedek moda geç
            } catch (e) { fallback(e); return; }
            // Bazı tarayıcılar isteği ne kabul eder ne reddeder (sessiz kalır): süre dolunca yedek moda geç.
            window.setTimeout(function () { if (!fsOn()) fallback(); }, 700);
        }
        fsBtn.addEventListener('click', toggleFs);
        function onFsChange() { if (fsOn()) pfs = false; syncFsUi(); }   // gerçek tam ekran açıldıysa yedek mod gereksiz
        document.addEventListener('fullscreenchange', onFsChange);
        document.addEventListener('webkitfullscreenchange', onFsChange);
        window.addEventListener('resize', fitCanvas);

        // ---- oyun akışı
        function drawOverlay() {
            overlay.innerHTML = '';
            var box = null;
            if (st.status === 'ready') {
                box = el('div', { class: 'mk-ov' }, el('h3', { text: task.title }), el('p', { text: task.brief }),
                    best() ? el('p', { class: 'mk-best', text: '🏆 En yüksek puan: ' + best() }) : null,
                    el('button', { class: 'lab-btn primary big', type: 'button', onclick: startGame }, '▶ Başla'));
            } else if (st.status === 'count') {
                box = el('div', { class: 'mk-ov count' }, el('b', { text: String(Math.max(1, Math.ceil(st.count))) }));
            } else if (st.status === 'paused') {
                box = el('div', { class: 'mk-ov' }, el('h3', { text: 'Duraklatıldı' }), el('p', { text: st.reason === 'sensor' ? (serial.connected ? 'Sensörden veri gelmiyor. Kabloyu ve sensör bağlantılarını kontrol et.' : 'Arduino bağlantısı koptu. Kendiliğinden yeniden bağlanmayı dener; olmazsa "Arduino\'yu bağla"ya bas.') : (st.reason === 'hand' ? 'Elini sensörün önüne getir, hazır olunca devam et.' : 'Devam etmeye hazır olunca bas.') }),
                    el('button', { class: 'lab-btn primary big', type: 'button', onclick: resume }, '▶ Devam'));
            } else if (st.status === 'lost') {
                box = el('div', { class: 'mk-ov burn' },
                    el('div', { class: 'mk-flame', 'aria-hidden': 'true', text: '🔥' }),
                    el('h3', { text: 'Kuş yandı!' }),
                    el('ul', { class: 'mk-score' },
                        el('li', null, el('span', { text: 'Geçilen engel' }), el('b', { text: String(st.passed) })),
                        el('li', null, el('span', { text: 'İlerleme puanı' }), el('b', { text: '+' + st.passPts })),
                        el('li', null, el('span', { text: 'Yıldız puanı (' + st.stars + ' ★)' }), el('b', { text: '+' + st.starPts })),
                        el('li', null, el('span', { text: 'En yüksek hız' }), el('b', { text: kmh(st.maxSpeed) + ' km/sa' }))),
                    el('div', { class: 'mk-total' }, el('small', { text: 'TOPLAM PUAN' }), el('b', { text: String(st.score) })),
                    el('p', { class: 'mk-best', text: st.newBest ? '🎉 Yeni rekor!' : '🏆 En yüksek puan: ' + st.best }),
                    el('div', { class: 'mk-row center' },
                        el('button', { class: 'lab-btn primary big', type: 'button', onclick: restart }, '↻ Tekrar oyna'),
                        el('button', { class: 'lab-btn big', type: 'button', onclick: function () { api.exit(); } }, 'Mod seç')));
            } else if (st.status === 'won') {
                box = el('div', { class: 'mk-ov' }, el('h3', { text: 'Bölüm tamam!' }), el('p', { class: 'mk-best', text: 'Puan: ' + st.score + (st.newBest ? ' · 🎉 Yeni rekor!' : '') }));
            }
            overlay.hidden = !box;
            if (box) overlay.appendChild(box);
        }
        function best() { return st.best; }
        function canStart() {
            if (settings.mode === 'sensor' && !sensorFresh()) {
                var ss = sensorState();
                if (ss === 'off') api.toast(supported || MOCK ? 'Önce Arduino\'yu bağla (ya da Boşluk tuşu modunu seç).' : 'Bu tarayıcı sensörü desteklemiyor; Boşluk tuşu modunu seç.');
                else api.toast(sensorHelp(ss));   // bağlı ama veri/el yok: doğru nedeni söyle ("önce bağlan" deme)
                return false;
            }
            return true;
        }
        function startGame() { if (!canStart()) return; st = fresh(); if (MOCK) window.__MK.state = function () { return st; }; st.status = 'count'; st.count = 3; drawOverlay(); api.setProgress(0, endless ? 0 : P.target); blurButtons(); }
        function restart() { startGame(); }
        function pause(reason) { if (st.status === 'play' || st.status === 'count') { st.status = 'paused'; st.reason = reason || ''; st.hold = false; drawOverlay(); } }
        function resume() { if (st.status !== 'paused') return; if (!canStart()) return; st.status = 'count'; st.count = 2; drawOverlay(); blurButtons(); }
        function blurButtons() { try { if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur(); } catch (e) { /* yok say */ } }
        function finishScore() {
            var b = getBest(kind);
            st.best = Math.max(b, st.score);
            if (st.score > b && st.score > 0) { st.newBest = true; setBest(kind, st.score); }
        }

        // ---- girdi
        function typing(e) { var t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'); }
        function onKeyDown(e) {
            if (!host.isConnected) return;
            if (e.code === 'Space' && !typing(e)) { e.preventDefault(); st.hold = true; }
            else if (e.code === 'KeyF' && !typing(e)) { toggleFs(); }
            else if (e.code === 'Escape' && pfs) { setPfs(false); }
            else if ((e.code === 'KeyP' || e.code === 'Escape') && !typing(e)) { if (st.status === 'play' || st.status === 'count') pause('user'); else if (st.status === 'paused') resume(); }
        }
        function onKeyUp(e) { if (e.code === 'Space') { st.hold = false; } }
        function onPtrDown(e) { if (settings.mode === 'space') { st.hold = true; try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* yok say */ } } }
        function onPtrUp() { st.hold = false; }
        window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);
        canvas.addEventListener('pointerdown', onPtrDown); canvas.addEventListener('pointerup', onPtrUp); canvas.addEventListener('pointercancel', onPtrUp);
        function onVis() { if (document.hidden) pause('user'); }
        document.addEventListener('visibilitychange', onVis);

        // ---- güncelleme
        function pop(text, x, y, color) { st.pops.push({ text: text, x: x, y: y, life: 1, color: color || '#0f172a' }); }
        function spawn() {
            var c = cur(), gap = c.gap, lo = 70 + gap / 2, hi = H - GROUND - 70 - gap / 2;
            var center = clamp(st.lastCenter + rnd(-(c.jump || 150), (c.jump || 150)), lo, hi);
            st.lastCenter = center;
            st.obs.push({ x: W + OB_W, center: center, cy: center, gap: gap, amp: c.osc || 0, ph: rnd(0, 6.28), lo: lo, hi: hi, passed: false, hit: false, star: true });
            st.spawned += 1;
        }
        function update(dt) {
            st.t += dt;
            if (st.invul > 0) st.invul = Math.max(0, st.invul - dt);
            st.pops.forEach(function (p) { p.life -= dt * 0.9; p.y -= 38 * dt; });
            st.pops = st.pops.filter(function (p) { return p.life > 0; });
            if (st.banner) { st.banner.life -= dt; if (st.banner.life <= 0) st.banner = null; }
            busyGame = st.status === 'play' || st.status === 'count';
            if (st.status === 'count') {
                st.count -= dt;
                if (st.count <= 0) { st.status = 'play'; drawOverlay(); } else { var n = Math.ceil(st.count); if (overlay.firstChild && overlay.firstChild.textContent !== String(n)) drawOverlay(); }
                return;
            }
            if (st.status !== 'play') return;
            var c = cur();
            st.maxSpeed = Math.max(st.maxSpeed, c.speed);
            var prevY = st.y;
            if (settings.mode === 'sensor') {
                var ss = sensorState();
                if (ss === 'off' || ss === 'wait' || ss === 'silent' || ss === 'stale') { pause('sensor'); return; }
                if (serial.noEcho && performance.now() - serial.noEchoSince > 4000) { pause('hand'); return; }   // el uzun süre menzil dışında
                var ty = handToY();
                st.y += clamp((ty - st.y) * Math.min(1, dt * 11), -950 * dt, 950 * dt);
                st.vy = (st.y - prevY) / Math.max(dt, 0.001);
            } else {
                var tv = st.hold ? -330 : 380;   // basılı tut: yukarı, bırak: aşağı (yön hızla değişir)
                st.vy += clamp(tv - st.vy, -3800 * dt, 3800 * dt);
                st.y += st.vy * dt;
            }
            var minY = BIRD_R, maxY = H - GROUND - BIRD_R;
            if (st.y < minY) { st.y = minY; if (st.vy < 0) st.vy = 0; }
            if (st.y > maxY) { st.y = maxY; if (st.vy > 0) st.vy = 0; }
            st.tilt += (clamp(st.vy / 900, -0.5, 0.5) - st.tilt) * Math.min(1, dt * 10);

            st.since += c.speed * dt;
            if ((endless || st.spawned < P.target) && st.since >= c.spacing) { st.since -= c.spacing; spawn(); }
            for (var i = 0; i < st.obs.length; i++) {
                var o = st.obs[i];
                o.x -= c.speed * dt;
                o.cy = o.amp ? clamp(o.center + o.amp * Math.sin(st.t * 1.6 + o.ph), o.lo, o.hi) : o.center;
                var topH = o.cy - o.gap / 2, botY = o.cy + o.gap / 2;
                if (st.invul <= 0 && !o.hit && (circleRect(BIRD_X, st.y, BIRD_R, o.x, 0, OB_W, topH) || circleRect(BIRD_X, st.y, BIRD_R, o.x, botY, OB_W, H - GROUND - botY))) {
                    o.hit = true; st.lives -= 1; st.invul = 1.3;
                    if (st.lives <= 0) { st.status = 'lost'; st.hold = false; busyGame = false; finishScore(); drawOverlay(); if (!endless) api.setProgress(st.passed, P.target); return; }
                }
                if (o.star) {
                    var dx = BIRD_X - (o.x + OB_W / 2), dy = st.y - o.cy;
                    if (dx * dx + dy * dy < (BIRD_R + 14) * (BIRD_R + 14)) { o.star = false; st.stars += 1; st.score += 25; st.starPts += 25; pop('+25 ★', BIRD_X + 24, st.y - 18, '#b45309'); }
                }
                if (!o.passed && o.x + OB_W < BIRD_X - BIRD_R) {
                    o.passed = true; st.passed += 1;
                    var pts = 10 + Math.max(0, Math.floor((c.speed - 170) / 25));   // hızlandıkça her engel daha çok puan
                    st.score += pts; st.passPts += pts; pop('+' + pts, BIRD_X + 24, st.y - 18);
                    if (!endless) api.setProgress(st.passed, P.target);
                    if (endless && st.passed % 10 === 0) st.banner = { text: '⚡ Hız arttı! ' + kmh(dyn(st.passed).speed) + ' km/sa', life: 1.8 };
                    if (!endless && st.passed >= P.target) { st.status = 'won'; busyGame = false; finishScore(); drawOverlay(); api.complete(st.lives >= 3 ? 3 : (st.lives === 2 ? 2 : 1)); return; }
                }
            }
            st.obs = st.obs.filter(function (o) { return o.x > -OB_W - 20; });
        }

        var lastPanelAt = 0;
        function updateGauge() {
            var t = handT();
            marker.style.bottom = (t * 100) + '%';
            reading.textContent = serial.last === null ? '— cm' : serial.last.toFixed(1) + ' cm';
            gauge.classList.toggle('dead', sensorState() !== 'ok');
            var tnow = performance.now();
            if (tnow - lastPanelAt > 500) { lastPanelAt = tnow; refreshPanel(); }   // durum metni zamanla değişir (veri durdu vb.)
        }

        // ---- çizim
        function draw() {
            var c = cur();
            drawBackground(ctx, st.t);
            st.obs.forEach(function (o) {
                drawPillar(ctx, o.x, 0, OB_W, o.cy - o.gap / 2, true);
                var by = o.cy + o.gap / 2;
                drawPillar(ctx, o.x, by, OB_W, H - GROUND - by, false);
                if (o.star) drawStar(ctx, o.x + OB_W / 2, o.cy, 14);
            });
            drawBird(ctx, BIRD_X, st.y, st.tilt, st.t, st.invul > 0 && Math.floor(st.t * 12) % 2 === 0);
            st.pops.forEach(function (p) {
                ctx.globalAlpha = clamp(p.life, 0, 1); ctx.font = '800 22px Poppins, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y); ctx.globalAlpha = 1;
            });
            // üst bilgi şeridi
            ctx.textBaseline = 'middle';
            pill(ctx, 10, 8, 150, 34, 'rgba(255,255,255,.82)');
            ctx.font = '800 22px Poppins, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#be123c';
            var hearts = ''; for (var i = 0; i < LIVES; i++) hearts += i < st.lives ? '♥ ' : '♡ ';
            ctx.fillText(hearts, 22, 26);
            pill(ctx, 10, 48, 190, 30, 'rgba(255,255,255,.82)');
            ctx.font = '800 17px Poppins, system-ui, sans-serif'; ctx.fillStyle = '#0f766e';
            ctx.fillText('Hız: ' + kmh(c.speed) + ' km/sa', 22, 63);
            pill(ctx, W / 2 - 95, 8, 190, 34, 'rgba(255,255,255,.82)');
            ctx.font = '800 20px Poppins, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#0f172a';
            ctx.fillText(endless ? 'Engel: ' + st.passed : st.passed + ' / ' + P.target, W / 2, 26);
            pill(ctx, W - 210, 8, 200, 34, 'rgba(255,255,255,.82)');
            ctx.font = '800 22px Poppins, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = '#1d4ed8';
            ctx.fillText('Puan: ' + st.score, W - 22, 26);
            pill(ctx, W - 130, 48, 120, 30, 'rgba(255,255,255,.82)');
            ctx.font = '800 17px Poppins, system-ui, sans-serif'; ctx.fillStyle = '#b45309';
            ctx.fillText('★ ' + st.stars, W - 22, 63);
            if (st.banner) {
                ctx.globalAlpha = clamp(st.banner.life, 0, 1); ctx.font = '800 30px Poppins, system-ui, sans-serif'; ctx.textAlign = 'center';
                ctx.fillStyle = '#c2410c'; ctx.fillText(st.banner.text, W / 2, 120); ctx.globalAlpha = 1;
            }
            if (settings.mode === 'sensor') {   // sağ kenarda el konumu işareti
                var yy = handToY(); ctx.fillStyle = 'rgba(15,118,110,.55)'; ctx.fillRect(W - 10, yy - 12, 6, 24);
            }
        }

        var last = performance.now(), raf = 0;
        function frame(now) {
            if (!host.isConnected) {   // görev kapatıldı: temizle
                window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
                window.removeEventListener('resize', fitCanvas);
                document.removeEventListener('visibilitychange', onVis); document.removeEventListener('fullscreenchange', onFsChange); document.removeEventListener('webkitfullscreenchange', onFsChange);
                if (pfs) { pfs = false; document.documentElement.classList.remove('mk-noscroll'); }
                if (document.fullscreenElement === stage) { try { document.exitFullscreen(); } catch (e) { /* yok say */ } }
                if (serial.onChange) serial.onChange = null;
                busyGame = false;
                return;
            }
            var dt = Math.min(0.033, (now - last) / 1000); last = now;
            update(dt); draw(); updateGauge();
            raf = window.requestAnimationFrame(frame);
        }
        refreshPanel(); drawOverlay(); if (!endless) api.setProgress(0, P.target);
        window.setTimeout(fitCanvas, 30);
        if (MOCK) {   // yalnızca test: oyunu gerçek zamansız, adım adım ilerlet
            window.__MK.step = function (n, dt) { dt = dt || 1 / 60; for (var i = 0; i < n; i++) { update(dt); } draw(); updateGauge(); };
        }
        raf = window.requestAnimationFrame(frame);
    }

    // ------------------------------------------------------------ açılış ekranı (animasyonlu) ve mod seçimi
    var BANNER = 'BİLİŞİM TEKNOLOJİLERİ DERSİNDE ORTAOKUL ÖĞRENCİLERİ TARAFINDAN YAPILMIŞTIR.';
    var TOPICS = [
        { tag: 'ARDUİNONUN ÖNEMİ', cls: 'a', lines: [
            'Arduino, sensörlerle dünyayı ölçüp karar veren küçük bir beyindir.',
            'Robotlardan akıllı evlere kadar birçok teknolojinin ilk adımıdır.',
            'Bu oyunda mesafe sensörü, elinin konumunu kuşun kanadına çevirir.'] },
        { tag: 'YAZILIMIN ÖNEMİ', cls: 'b', lines: [
            'Yazılım, donanıma ne yapacağını söyleyen akıldır.',
            'Telefon, araba, oyun… günlük hayatın her yerinde yazılım var.',
            'Kod yazan teknolojiyi yalnızca kullanmaz, onu üretir.'] },
        { tag: 'KODLAMA İLE EĞLENCENİN BİRLEŞMESİ', cls: 'c', lines: [
            'Eğlenerek öğrenmek, öğrenileni unutulmaz kılar.',
            'Bir fikri koda dökmek, oyun oynamak kadar heyecanlıdır.',
            'Hadi, kodun gücünü elinle hisset!'] }
    ];
    var ICONS = { a: '🔌', b: '💻', c: '🎮' };
    function flyingChips() {
        var chips = [];
        TOPICS.forEach(function (t) { t.lines.forEach(function (line) { chips.push({ tag: t.tag, cls: t.cls, text: line }); }); });
        var wrap = el('div', { class: 'mk-flies', 'aria-hidden': 'true' });
        var TRACKS = 6;
        for (var tr = 0; tr < TRACKS; tr++) {
            var dur = 34 + (tr % 3) * 8;                       // her yol farklı hızda
            var dir = tr % 2 ? 'r' : 'l';
            for (var k = 0; k < 2; k++) {
                var c = chips[(tr * 2 + k) % chips.length];
                var chip = el('div', { class: 'mk-fly ' + c.cls + ' ' + dir },
                    el('i', { class: 'ico', text: ICONS[c.cls] }),
                    el('div', { class: 'tx' }, el('b', { text: c.tag }), el('span', { text: c.text })));
                chip.style.top = (15 + tr * 11.5) + '%';
                chip.style.animationDuration = dur + 's';
                chip.style.animationDelay = '-' + (k * dur / 2 + tr * 3.7) + 's';
                wrap.appendChild(chip);
            }
        }
        return wrap;
    }
    var HILL_D = 'M0 160 C 100 100 200 100 300 150 S 500 210 600 160 S 700 110 800 160 C 900 100 1000 100 1100 150 S 1300 210 1400 160 S 1500 110 1600 160 V300 H0 Z';
    var SNIPPETS = ['digitalWrite(LED, HIGH);', 'if (mesafe < 20) { kus.yukari(); }', 'Serial.println(cm);', 'for (int i = 0; i < 10; i++)', 'float cm = olcCm();', 'kus.hiz += 0.5;', 'pinMode(TRIG, OUTPUT);', 'while (oyunDevam) { ucur(); }', 'puan += 10 + hiz / 25;'];
    var BIRD_SVG = '<svg viewBox="0 0 120 100" width="150" height="125" aria-hidden="true"><path d="M30 46l-24-12 4 14-6 14 26-6z" fill="#0d9488"/><circle cx="58" cy="52" r="34" fill="#0f766e"/><ellipse cx="62" cy="68" rx="20" ry="13" fill="#ccfbf1"/><g fill="#f59e0b"><ellipse cx="50" cy="16" rx="5" ry="13" transform="rotate(-18 50 16)"/><ellipse cx="62" cy="14" rx="5" ry="13"/><ellipse cx="74" cy="17" rx="5" ry="13" transform="rotate(18 74 17)"/></g><circle cx="72" cy="46" r="11" fill="#fff"/><circle cx="75" cy="48" r="5.5" fill="#0f172a"/><path d="M56 31l26 11" stroke="#0f172a" stroke-width="6" stroke-linecap="round"/><path d="M88 50l28 8-28 11z" fill="#f59e0b"/><path class="wing" d="M42 60c-10 2-14 12-10 18 10 0 18-6 20-14z" fill="#115e59"/></svg>';
    var MINI_BIRD = '<svg viewBox="0 0 120 100" width="64" height="54" aria-hidden="true"><path d="M30 46l-24-12 4 14-6 14 26-6z" fill="#0d9488"/><circle cx="58" cy="52" r="34" fill="#14b8a6"/><ellipse cx="62" cy="68" rx="20" ry="13" fill="#ccfbf1"/><circle cx="72" cy="46" r="11" fill="#fff"/><circle cx="75" cy="48" r="5.5" fill="#0f172a"/><path d="M56 31l26 11" stroke="#0f172a" stroke-width="6" stroke-linecap="round"/><path d="M88 50l28 8-28 11z" fill="#f59e0b"/></svg>';
    var SENSOR_SVG = '<svg viewBox="0 0 120 64" width="96" height="52" aria-hidden="true"><rect x="2" y="6" width="116" height="52" rx="8" fill="#0e7490" stroke="#67e8f9" stroke-width="2"/><circle cx="34" cy="30" r="17" fill="#cbd5e1" stroke="#0f172a" stroke-width="3"/><circle cx="34" cy="30" r="9" fill="#475569"/><circle cx="86" cy="30" r="17" fill="#cbd5e1" stroke="#0f172a" stroke-width="3"/><circle cx="86" cy="30" r="9" fill="#475569"/><g fill="#fbbf24"><rect x="30" y="52" width="6" height="10"/><rect x="48" y="52" width="6" height="10"/><rect x="66" y="52" width="6" height="10"/><rect x="84" y="52" width="6" height="10"/></g></svg>';
    var CIRCUIT = '<svg viewBox="0 0 1200 420" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><g fill="none" stroke="#5eead4" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path class="tr" d="M0 360 H170 L214 316 H430 L462 348 H700"/><path class="tr t2" d="M1200 330 H990 L946 372 H770 L738 332 H560"/><path class="tr" d="M110 420 V384 L152 342 H330"/><path class="tr t2" d="M1090 420 V380 L1046 336 H900"/><path class="tr" d="M600 420 V380 H640 L664 356"/></g><g fill="#99f6e4"><circle class="node" cx="700" cy="348" r="6"/><circle class="node" cx="560" cy="332" r="6"/><circle class="node" cx="330" cy="342" r="6"/><circle class="node" cx="900" cy="336" r="6"/><circle class="node" cx="664" cy="356" r="6"/></g></svg>';
    var BIRD_FLOCK = '<svg viewBox="0 0 40 24" aria-hidden="true"><path d="M2 12 Q11 0 20 12 Q29 0 38 12 Q29 7 20 17 Q11 7 2 12Z"/></svg>';

    function scene() {
        var s = el('div', { class: 'mk-scene', 'aria-hidden': 'true' }, el('div', { class: 'mk-stars' }), el('div', { class: 'mk-sun' }));
        [['a', 12, 80], ['b', 38, 110], ['c', 64, 95]].forEach(function (c) { var cl = el('i', { class: 'mk-cloud ' + c[0] }); cl.style.top = c[1] + '%'; cl.style.animationDuration = c[2] + 's'; s.appendChild(cl); });
        [['h1', 95], ['h2', 62], ['h3', 38]].forEach(function (h) { s.appendChild(el('div', { class: 'mk-hills ' + h[0], html: '<svg viewBox="0 0 1600 300" preserveAspectRatio="none" style="animation-duration:' + h[1] + 's"><path d="' + HILL_D + '"/></svg>' })); });
        s.appendChild(el('div', { class: 'mk-circuit', html: CIRCUIT }));
        for (var i = 0; i < 5; i++) { var b = el('i', { class: 'mk-bird', html: BIRD_FLOCK }); b.style.top = (10 + i * 13) + '%'; b.style.animationDuration = (20 + i * 4) + 's'; b.style.animationDelay = '-' + (i * 5.3) + 's'; b.style.width = (22 + (i % 3) * 8) + 'px'; s.appendChild(b); }
        SNIPPETS.forEach(function (code, i) { var sn = el('code', { class: 'mk-snip', text: code }); sn.style.left = (4 + i * 10.4) + '%'; sn.style.animationDuration = (15 + (i % 4) * 4) + 's'; sn.style.animationDelay = '-' + (i * 2.7) + 's'; s.appendChild(sn); });
        return s;
    }
    function demo() {
        return el('div', { class: 'mk-demo', 'aria-hidden': 'true' },
            el('div', { class: 'col' }, el('div', { class: 'zone' }, el('span', { class: 'hand-ico', text: '🖐️' }), el('i', { class: 'wv w1' }), el('i', { class: 'wv w2' }), el('i', { class: 'wv w3' })), el('div', { class: 'sensor', html: SENSOR_SVG }), el('small', { text: 'El + mesafe sensörü' })),
            el('div', { class: 'arrow' }, el('b', { text: '➜' }), el('small', { text: 'Arduino okur' })),
            el('div', { class: 'col' }, el('div', { class: 'zone fly' }, el('span', { class: 'bird-mini', html: MINI_BIRD })), el('small', { text: 'Kuş aynı anda yükselir' })));
    }

    var nav = {};

    function startApp(core) {
        function isIntro() { return !!core.stage.querySelector('.mk-intro'); }
        nav.intro = function () { showIntro(); };
        nav.modes = function () { showModes(); };

        function showIntro() {
            core.chrome(false);
            core.closeModal();
            core.stage.innerHTML = '';
            var guide = el('div', { class: 'mk-guide', hidden: true, role: 'dialog', 'aria-label': 'Görevli rehberi' },
                el('h3', { text: 'Görevli rehberi' }),
                el('ol', null,
                    el('li', { html: 'Arduino kartını <b>USB</b> ile bilgisayara tak (sensör bağlı olsun).' }),
                    el('li', { html: '<b>OYUNA BAŞLA</b> → oyun modunu seç → oyun ekranında <b>"Arduino\'yu bağla"</b>ya bas, kartı seç.' }),
                    el('li', { html: 'Ziyaretçi elini sensörün <b>8-40 cm</b> önünde yukarı aşağı oynatır.' }),
                    el('li', { html: 'Sensör çalışmazsa <b>Boşluk tuşu</b> moduna geç. Tam ekran için <b>F</b> tuşu.' }),
                    el('li', { html: 'Ekran 90 saniye boşta kalırsa bu açılış ekranına döner.' })),
                el('button', { class: 'lab-btn primary', type: 'button', onclick: function () { guide.hidden = true; } }, 'Tamam'));
            var start = el('button', { class: 'mk-cta', type: 'button', onclick: showModes }, el('span', { class: 'play', 'aria-hidden': 'true', text: '▶' }), el('span', { text: 'OYUNA BAŞLA' }));
            var sr = el('div', { class: 'sr-only' }, el('p', { text: BANNER }));
            TOPICS.forEach(function (t) { sr.appendChild(el('h2', { text: t.tag })); t.lines.forEach(function (l) { sr.appendChild(el('p', { text: l })); }); });
            var title = el('h1', { class: 'mk-title', 'aria-label': 'MESAFE KUŞU' });
            'MESAFE KUŞU'.split('').forEach(function (ch, i) {
                var sp = el('span', { 'aria-hidden': 'true', text: ch === ' ' ? ' ' : ch });
                sp.style.setProperty('--i', String(i));
                if (i > 6) sp.className = 'y';
                if (ch === ' ') sp.className = 'gap';
                title.appendChild(sp);
            });
            var intro = el('section', { class: 'mk-intro', 'aria-label': 'Mesafe Kuşu açılış ekranı' },
                scene(),
                el('div', { class: 'mk-banner' }, el('div', { class: 'ribbon' }, el('i', { class: 'spark', 'aria-hidden': 'true', text: '✦' }), el('span', { text: BANNER }), el('i', { class: 'spark', 'aria-hidden': 'true', text: '✦' }))),
                flyingChips(),
                el('div', { class: 'mk-hero' },
                    el('div', { class: 'mk-logo', html: BIRD_SVG }),
                    title,
                    el('p', { class: 'mk-sub', text: 'Arduino ile uçan kuş · Kodlamayla eğlenceyi birleştir' }),
                    demo(),
                    start),
                el('button', { class: 'mk-guide-btn', type: 'button', onclick: function () { guide.hidden = !guide.hidden; } }, '🛠 Görevli rehberi'),
                guide, sr);
            core.stage.appendChild(intro);
            markActive();
        }

        function showModes() {
            core.chrome(true);
            core.closeModal();
            core.setLabel('Mod seç');
            core.stage.innerHTML = '';
            var card = function (icon, title, text, cls, handler) {
                return el('button', { class: 'mk-mcard ' + cls, type: 'button', onclick: handler }, el('span', { class: 'ico', 'aria-hidden': 'true', text: icon }), el('b', { text: title }), el('small', { text: text }));
            };
            core.stage.appendChild(el('div', { class: 'mk-modes-screen' },
                el('div', { class: 'lab-hero' }, el('h2', { text: 'Nasıl oynamak istersin?' }), el('p', { text: 'Bir oyun modu seç; kumandayı (sensör ya da Boşluk tuşu) oyun ekranında seçebilirsin.' })),
                el('div', { class: 'mk-mgrid' },
                    card('🏁', 'Bölümlü Oyun', '10 bölümde adım adım ilerle, can kaybetmeden geç, yıldız topla.', 'lv', function () { core.showPicker(); }),
                    card('♾️', 'Sonsuz Oyun', 'Engeller bitmez, kuş her engelde hızlanır. Yanana kadar uç, rekor kır!', 'en', function () { core.openTask('mk-endless'); }))));
            markActive();
        }

        // vitrin: boşta kalınca açılış ekranına dön
        window.setInterval(function () {
            if (isIntro() || busyGame) return;
            if (Date.now() - lastActive > IDLE_MS) showIntro();
        }, 4000);

        if (MOCK) { window.__MK.showIntro = showIntro; window.__MK.showModes = showModes; window.__MK.tick = function () { if (!isIntro() && !busyGame && Date.now() - lastActive > 90000) showIntro(); }; }
        showIntro();
    }

    window.LabCore.start({
        slug: 'mesafe-kusu-runner',
        title: 'Mesafe Kuşu',
        tagline: 'Elinle ya da Boşluk tuşuyla kuşu engellerden geçir',
        tasks: window.MK_TASKS,
        words: { section: 'Arduino Oyunu', pick: 'Bölüm seç', ord: '. bölüm', card: '. bölüm · ', picked: 'bölüm tamamlandı', done: 'Bölüm tamam!', next: 'Sonraki bölüm →', back: 'Bölümlere dön', tasksBtn: 'Bölümler', perfect: 'Hiç can kaybetmeden geçtin, harika!', better: 'Daha az can kaybederek daha çok yıldız kazanabilirsin.', denied: 'Bu oyun sana atanmamış' },
        extraButtons: [
            { label: 'Ana ekran', glyph: '⌂', onclick: function () { if (nav.intro) nav.intro(); } },
            { label: 'Mod seç', glyph: '◧', onclick: function () { if (nav.modes) nav.modes(); } }
        ],
        onReady: function (core) { startApp(core); },
        renderTask: function (host, task, api) {
            api.exit = function () { if (nav.modes) nav.modes(); };
            renderTask(host, task, api);
        }
    });
})();
