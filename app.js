/* ROCKET SIM — 화면 / 연출 / UI
 * 교육용 개념 모델입니다. 실제 발사체의 형상·궤적·성능을 재현하지 않습니다.
 */
(() => {
    'use strict';

    const sim = new RocketSim({ mode: 'auto', scenario: 'none' });
    const $ = (id) => document.getElementById(id);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const rand = (a, b) => a + Math.random() * (b - a);

    /* ====================================================== 캔버스 ====== */
    const cv = $('scene');
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, DPR = 1;
    function resize() {
        const r = cv.getBoundingClientRect();
        DPR = Math.min(2, window.devicePixelRatio || 1);
        W = Math.max(1, r.width); H = Math.max(1, r.height);
        cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    }
    new ResizeObserver(resize).observe(cv);
    resize();

    /* ====================================================== 상태 ======== */
    let paused = false;
    let timeScale = 1;
    let debris = [];
    let particles = [];
    let history = [];
    let lastHist = -1;
    let destroyed = false;
    let satOnly = false;
    let satAge = 0;
    let shake = 0;
    let flash = 0;
    let clockT = 0;                 // 애니메이션용 실시간 (s)
    let prevShift = 0;
    let resultTimer = null;
    let emitAcc = 0;

    const stars = Array.from({ length: 200 }, () => ({ x: Math.random(), y: Math.random(), r: rand(0.3, 1.5), p: rand(0, 6.28) }));
    const clouds = Array.from({ length: 16 }, () => ({ x: Math.random(), alt: rand(1.5, 11), w: rand(130, 260), k: rand(0.6, 1.1) }));
    const streaks = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), l: rand(24, 70) }));

    const shiftOf = (a) => 1100 * (1 - Math.exp(-a / 4));       // 고도 → 배경 이동량(px)

    /* ====================================================== 색상 ======== */
    const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const mix = (a, b, t) => { const A = hex(a), B = hex(b); return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`; };
    const SKY = [
        [0, '#4aa3f0', '#cfeaff'], [12, '#2b6cc0', '#8cc4f0'], [40, '#12306b', '#3f78c4'],
        [90, '#040b1f', '#133a82'], [160, '#01030a', '#07204d'], [300, '#000000', '#031030'],
    ];
    function skyAt(alt) {
        for (let i = 0; i < SKY.length - 1; i++) {
            const a = SKY[i], b = SKY[i + 1];
            if (alt <= b[0]) { const t = clamp((alt - a[0]) / (b[0] - a[0]), 0, 1); return [mix(a[1], b[1], t), mix(a[2], b[2], t)]; }
        }
        const l = SKY[SKY.length - 1]; return [l[1], l[2]];
    }

    /* ====================================================== 오디오 ====== */
    const audio = {
        ctx: null, muted: false, noise: null, gain: null, filt: null,
        init() {
            if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                this.ctx = new AC();
                const len = this.ctx.sampleRate * 2;
                const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
                const d = buf.getChannelData(0);
                let last = 0;
                for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
                this.noise = this.ctx.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true;
                this.filt = this.ctx.createBiquadFilter(); this.filt.type = 'lowpass'; this.filt.frequency.value = 320;
                this.gain = this.ctx.createGain(); this.gain.gain.value = 0;
                this.noise.connect(this.filt); this.filt.connect(this.gain); this.gain.connect(this.ctx.destination);
                this.noise.start();
            } catch (e) { this.ctx = null; }
        },
        tone(f, d, type, vol) {
            if (!this.ctx || this.muted) return;
            const o = this.ctx.createOscillator(), g = this.ctx.createGain();
            o.type = type || 'sine'; o.frequency.value = f;
            g.gain.value = vol || 0.08;
            g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + d);
            o.connect(g); g.connect(this.ctx.destination);
            o.start(); o.stop(this.ctx.currentTime + d + 0.02);
        },
        beep() { this.tone(660, 0.1, 'square', 0.04); },
        ping(status) { this.tone(status === 'fail' ? 140 : status === 'warn' ? 420 : 880, status === 'fail' ? 0.5 : 0.18, status === 'fail' ? 'sawtooth' : 'sine', 0.06); },
        clunk() { this.tone(90, 0.25, 'square', 0.12); },
        setRumble(level) {
            if (!this.ctx) return;
            const v = this.muted ? 0 : level;
            this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.12);
        },
    };

    /* ====================================================== 로켓 형상 === */
    // 로컬 좌표: 원점=스택 중앙, y 아래(+) 방향이 엔진, 위(−)가 머리
    const COL = { white1: '#f6f8fb', white2: '#b3bccb', dark: '#2a3040', accent: '#ff6a3d', metal: '#454c5c' };

    function bodyGrad(c, x0, x1) {
        const g = c.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, COL.white1); g.addColorStop(0.55, '#dfe4ec'); g.addColorStop(1, COL.white2);
        return g;
    }
    function drawS1(c) {
        // 핀
        c.fillStyle = COL.dark;
        c.beginPath(); c.moveTo(-18, 98); c.lineTo(-31, 128); c.lineTo(-18, 122); c.closePath(); c.fill();
        c.beginPath(); c.moveTo(18, 98); c.lineTo(31, 128); c.lineTo(18, 122); c.closePath(); c.fill();
        // 엔진 노즐
        c.fillStyle = COL.metal;
        for (const nx of [-11, 0, 11]) {
            c.beginPath(); c.moveTo(nx - 4, 122); c.lineTo(nx + 4, 122); c.lineTo(nx + 6.5, 134); c.lineTo(nx - 6.5, 134); c.closePath(); c.fill();
        }
        // 본체
        c.fillStyle = bodyGrad(c, -18, 18); c.fillRect(-18, 6, 36, 116);
        c.fillStyle = COL.dark; c.fillRect(-18, 30, 36, 9);
        c.fillStyle = COL.accent; c.fillRect(-18, 92, 36, 5);
        c.fillStyle = 'rgba(0,0,0,.08)'; c.fillRect(-18, 6, 36, 2);
        // 인터스테이지
        c.fillStyle = '#3a4152'; c.fillRect(-17, -2, 34, 9);
        c.fillStyle = '#586079'; c.fillRect(-17, -2, 34, 2);
    }
    function drawS2(c, withBell) {
        if (withBell) {
            c.fillStyle = COL.metal;
            c.beginPath(); c.moveTo(-5, -2); c.lineTo(5, -2); c.lineTo(8, 9); c.lineTo(-8, 9); c.closePath(); c.fill();
        }
        c.fillStyle = bodyGrad(c, -16, 16); c.fillRect(-16, -64, 32, 62);
        c.fillStyle = COL.dark; c.fillRect(-16, -40, 32, 7);
        c.fillStyle = COL.accent; c.fillRect(-16, -18, 32, 3);
    }
    function fairingPath(c) {
        c.beginPath();
        c.moveTo(-16, -64); c.quadraticCurveTo(-17, -106, 0, -126); c.quadraticCurveTo(17, -106, 16, -64); c.closePath();
    }
    function drawFairing(c, side) {
        c.save();
        if (side === 'L') { c.beginPath(); c.rect(-40, -140, 40, 100); c.clip(); }
        if (side === 'R') { c.beginPath(); c.rect(0, -140, 40, 100); c.clip(); }
        fairingPath(c);
        const g = c.createLinearGradient(-16, 0, 16, 0);
        g.addColorStop(0, '#fbfcfe'); g.addColorStop(0.6, '#e1e6ee'); g.addColorStop(1, '#aab4c5');
        c.fillStyle = g; c.fill();
        c.strokeStyle = 'rgba(40,50,70,.5)'; c.lineWidth = 0.8; c.stroke();
        if (!side) { c.beginPath(); c.moveTo(0, -126); c.lineTo(0, -64); c.strokeStyle = 'rgba(40,50,70,.25)'; c.stroke(); }
        c.fillStyle = COL.accent; c.fillRect(-17, -72, 34, 3);
        c.restore();
    }
    function drawPayloadStack(c) {
        c.fillStyle = '#5b6379'; c.fillRect(-8, -72, 16, 9);
        const g = c.createLinearGradient(-9, 0, 9, 0);
        g.addColorStop(0, '#f1d58a'); g.addColorStop(1, '#b58a2e');
        c.fillStyle = g; c.fillRect(-9, -90, 18, 19);
        c.fillStyle = '#2a4f9e'; c.fillRect(-14, -86, 5, 12); c.fillRect(9, -86, 5, 12);
        c.strokeStyle = '#d8dde8'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, -90); c.lineTo(0, -99); c.stroke();
        c.fillStyle = '#d8dde8'; c.beginPath(); c.arc(0, -100, 2, 0, 6.28); c.fill();
    }
    function drawSat(c, unfold) {
        const g = c.createLinearGradient(-9, 0, 9, 0);
        g.addColorStop(0, '#f1d58a'); g.addColorStop(1, '#b58a2e');
        const pw = 8 + unfold * 38;
        for (const sd of [-1, 1]) {
            c.save(); c.scale(sd, 1);
            c.fillStyle = '#1f3f86'; c.fillRect(9, -7, pw, 14);
            c.strokeStyle = 'rgba(160,190,255,.6)'; c.lineWidth = 0.7;
            for (let x = 9 + 6; x < 9 + pw; x += 6) { c.beginPath(); c.moveTo(x, -7); c.lineTo(x, 7); c.stroke(); }
            c.beginPath(); c.moveTo(9, 0); c.lineTo(9 + pw, 0); c.stroke();
            c.restore();
        }
        c.fillStyle = g; c.fillRect(-9, -10, 18, 20);
        c.strokeStyle = '#d8dde8'; c.lineWidth = 1; c.beginPath(); c.moveTo(0, -10); c.lineTo(0, -19); c.stroke();
        c.fillStyle = '#e8ecf4'; c.beginPath(); c.ellipse(0, -21, 6, 2.4, 0, 0, 6.28); c.fill();
    }

    function drawFlame(c, y0, w0, len, k) {
        const flick = 0.88 + Math.random() * 0.24;
        const L = len * flick * k;
        const g = c.createLinearGradient(0, y0, 0, y0 + L);
        g.addColorStop(0, 'rgba(255,255,255,.95)');
        g.addColorStop(0.18, 'rgba(255,232,150,.95)');
        g.addColorStop(0.5, 'rgba(255,130,40,.7)');
        g.addColorStop(1, 'rgba(255,70,20,0)');
        c.fillStyle = g;
        c.beginPath(); c.moveTo(-w0 / 2, y0); c.quadraticCurveTo(-w0 * 0.75, y0 + L * 0.5, 0, y0 + L);
        c.quadraticCurveTo(w0 * 0.75, y0 + L * 0.5, w0 / 2, y0); c.closePath(); c.fill();
        c.fillStyle = 'rgba(255,255,255,.55)';
        c.beginPath(); c.moveTo(-w0 / 5, y0); c.quadraticCurveTo(0, y0 + L * 0.55, w0 / 5, y0); c.closePath(); c.fill();
    }

    /* ====================================================== 기하/좌표 ==== */
    let S = 1, AX = 0, AY = 0, visTheta = 0;
    function frameGeom() {
        S = clamp(H / 640, 0.6, 1.15);
        AX = W * 0.5; AY = H * 0.5;
        visTheta = Math.min(sim.theta, 98) * Math.PI / 180;
    }
    const rot = (lx, ly) => ({ x: AX + (lx * Math.cos(visTheta) - ly * Math.sin(visTheta)) * S, y: AY + (lx * Math.sin(visTheta) + ly * Math.cos(visTheta)) * S });
    const axisDir = () => ({ x: Math.sin(visTheta), y: -Math.cos(visTheta) });

    /* ====================================================== 파편/입자 ==== */
    const PART_CENTER = { first: [0, 64], second: [0, -33], fairL: [-8, -95], fairR: [8, -95], sat: [0, -80] };

    function spawnDebris(kind, opts) {
        opts = opts || {};
        const [cx, cy] = PART_CENTER[kind];
        const p = rot(cx, cy);
        const ax = axisDir();
        const perp = { x: Math.cos(visTheta), y: Math.sin(visTheta) };
        let vx = -ax.x * (opts.back != null ? opts.back : 34) * S;
        let vy = -ax.y * (opts.back != null ? opts.back : 34) * S;
        if (opts.side) { vx += perp.x * opts.side * S; vy += perp.y * opts.side * S; }
        if (opts.rand) { vx += rand(-opts.rand, opts.rand) * S; vy += rand(-opts.rand, opts.rand) * S; }
        debris.push({ kind, cx, cy, x: p.x, y: p.y, rot: visTheta, vr: opts.vr != null ? opts.vr : rand(-0.5, 0.5), vx, vy, age: 0, s: S, free: !!opts.free });
    }

    function burst(x, y, n, speed, life, hue) {
        for (let i = 0; i < n; i++) {
            const a = rand(0, 6.283), v = rand(0.2, 1) * speed;
            particles.push({ k: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.3, 1) * life, max: life, size: rand(1.5, 4), hue: hue || 30 });
        }
    }

    function breakApart() {
        destroyed = true;
        const p = rot(0, 0);
        flash = 1; shake = 18;
        burst(p.x, p.y, 120, 360 * S, 1.4, 25);
        for (let i = 0; i < 26; i++) particles.push({ k: 'smoke', x: p.x + rand(-20, 20) * S, y: p.y + rand(-40, 40) * S, vx: rand(-60, 60), vy: rand(-60, 60), life: rand(1, 2.4), max: 2.4, size: rand(16, 40) * S, tone: 60 });
        if (satOnly) { spawnDebris('sat', { free: true, back: 0, rand: 120, vr: rand(-2, 2) }); return; }
        if (sim.s1.attached) spawnDebris('first', { free: true, back: 0, rand: 130, vr: rand(-2.2, 2.2) });
        if (sim.s2.attached) spawnDebris('second', { free: true, back: 0, rand: 150, vr: rand(-2.5, 2.5) });
        if (sim.fairing.attached) {
            spawnDebris('fairL', { free: true, back: 0, rand: 150, side: -70, vr: -2 });
            spawnDebris('fairR', { free: true, back: 0, rand: 150, side: 70, vr: 2 });
        }
        if (sim.s2.attached && !sim.fairing.attached) spawnDebris('sat', { free: true, back: 0, rand: 160, vr: rand(-3, 3) });
    }

    function onSeparate(d) {
        const p = rot(0, d.which === 'first' ? 6 : d.which === 'fairing' ? -64 : -66);
        burst(p.x, p.y, 26, 150 * S, 0.7, 45);
        flash = Math.max(flash, 0.35); shake = Math.max(shake, 7);
        audio.clunk();
        if (d.which === 'first') {
            spawnDebris('first', { back: 46, rand: 6 });
        } else if (d.which === 'fairing') {
            spawnDebris('fairL', { back: 22, side: -58, vr: -0.9 });
            spawnDebris('fairR', { back: 22, side: 58, vr: 0.9 });
        } else if (d.which === 'second') {
            spawnDebris('second', { back: 40, rand: 5 });
            satOnly = true; satAge = 0;
        }
    }

    function emitExhaust(dt, groundY) {
        if (destroyed) return;
        let ny = 0, burning = false, base = 1;
        if (sim.s1.attached && sim.s1.burning) { burning = true; ny = 134; }
        else if (sim.s2.attached && sim.s2.burning) { burning = true; ny = 9; base = 0.55; }
        if (!burning) return;
        const fs = flameScale();
        const alt = sim.y;
        const n = p0(260 * base * fs * dt);
        const ax = axisDir();
        const nz = rot(0, ny);
        for (let i = 0; i < n; i++) {
            const sp = (150 + sim.speed * 55) * S * rand(0.7, 1.2);
            const spread = 30 + clamp(alt / 80, 0, 1) * 110;
            particles.push({
                k: 'fire', x: nz.x + rand(-5, 5) * S, y: nz.y + rand(-5, 5) * S,
                vx: -ax.x * sp + rand(-spread, spread) * 0.5 * S, vy: -ax.y * sp + rand(-spread, spread) * 0.5 * S,
                life: rand(0.2, 0.5), max: 0.5, size: rand(5, 12) * S * (alt > 60 ? 1.6 : 1),
            });
        }
        if (alt < 28) {
            const ns = p0(70 * fs * dt);
            for (let i = 0; i < ns; i++) {
                particles.push({ k: 'smoke', x: nz.x + rand(-10, 10) * S, y: nz.y + rand(-6, 6) * S, vx: -ax.x * rand(40, 120) * S + rand(-40, 40), vy: -ax.y * rand(40, 120) * S + rand(-20, 20), life: rand(1.2, 2.8), max: 2.8, size: rand(10, 24) * S, tone: 190, fixed: true });
            }
        }
        if (alt < 0.6 && groundY < H + 40) {
            const nst = p0(90 * fs * dt);
            for (let i = 0; i < nst; i++) {
                const dir = Math.random() < 0.5 ? -1 : 1;
                particles.push({ k: 'smoke', x: AX + dir * rand(10, 40) * S, y: groundY - rand(2, 14) * S, vx: dir * rand(60, 240) * S, vy: rand(-30, 6), life: rand(1.6, 3.4), max: 3.4, size: rand(26, 56) * S, tone: 232, fixed: true });
            }
        }
    }
    // 확률적 정수 개수
    function p0(x) { emitAcc += x; const n = Math.floor(emitAcc); emitAcc -= n; return n; }

    function flameScale() {
        if (sim.t < 0) return clamp((sim.t + 3) / 3, 0, 1);
        return 1;
    }

    function updateFx(dt, dShift) {
        for (const p of particles) {
            p.life -= dt;
            p.x += p.vx * dt; p.y += p.vy * dt;
            if (p.fixed) p.y += dShift;
            if (p.k === 'smoke') { p.vx *= (1 - 0.7 * dt); p.vy *= (1 - 0.7 * dt); p.size += 14 * dt * S; }
            else if (p.k === 'spark') { p.vx *= (1 - 1.4 * dt); p.vy *= (1 - 1.4 * dt); }
        }
        particles = particles.filter((p) => p.life > 0 && p.y < H + 200 && p.y > -300 && p.x > -300 && p.x < W + 300);
        if (particles.length > 1600) particles.splice(0, particles.length - 1600);

        const ax = axisDir();
        for (const d of debris) {
            d.age += dt;
            if (!d.free && sim.accel > 0) {
                const ar = sim.accel * 5600 * S;
                d.vx += -ax.x * ar * dt; d.vy += -ax.y * ar * dt;
            }
            if (d.free) { d.vy += 40 * dt; d.vx *= (1 - 0.15 * dt); d.vy *= (1 - 0.15 * dt); }
            d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vr * dt;
        }
        debris = debris.filter((d) => d.age < 40 && d.x > -500 && d.x < W + 500 && d.y > -500 && d.y < H + 500);
        if (satOnly && !destroyed) satAge += dt;
    }

    /* ====================================================== 렌더링 ====== */
    function drawSky(alt) {
        const [top, bot] = skyAt(alt);
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, top); g.addColorStop(1, bot);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    function drawStars(alt) {
        const a = clamp((alt - 30) / 80, 0, 1);
        if (a <= 0) return;
        for (const s of stars) {
            const tw = 0.6 + 0.4 * Math.sin(clockT * 2 + s.p);
            ctx.fillStyle = `rgba(255,255,255,${a * tw})`;
            ctx.beginPath(); ctx.arc(s.x * W, s.y * H * 0.9, s.r, 0, 6.283); ctx.fill();
        }
    }
    function drawEarth(alt) {
        if (alt < 5) return;
        const apex = H + 60 - clamp(alt / 80, 0, 1) * H * 0.22 - clamp((alt - 80) / 220, 0, 1) * H * 0.07;
        const R = W * 1.9;
        const cy = apex + R;
        ctx.save();
        // 대기 광휘
        ctx.shadowColor = 'rgba(110,185,255,.9)'; ctx.shadowBlur = 36;
        ctx.fillStyle = '#0b2a5c';
        ctx.beginPath(); ctx.arc(W / 2, cy, R, 0, 6.283); ctx.fill();
        ctx.restore();
        const g = ctx.createLinearGradient(0, apex, 0, apex + H * 0.4);
        g.addColorStop(0, '#2c78d0'); g.addColorStop(0.08, '#1a5aa8'); g.addColorStop(1, '#06193c');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(W / 2, cy, R - 2, 0, 6.283); ctx.fill();
        // 림 라이트
        ctx.strokeStyle = 'rgba(140,200,255,.65)'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(W / 2, cy, R - 1, Math.PI * 1.4, Math.PI * 1.6); ctx.stroke();
        // 구름 띠
        ctx.save();
        ctx.beginPath(); ctx.arc(W / 2, cy, R - 3, 0, 6.283); ctx.clip();
        ctx.fillStyle = 'rgba(255,255,255,.10)';
        const drift = (clockT * 6 + sim.x * 0.4) % W;
        for (let i = 0; i < 7; i++) {
            const x = ((i * 173 + drift) % (W + 200)) - 100;
            ctx.beginPath(); ctx.ellipse(x, apex + 24 + (i % 3) * 22, 110 + (i % 4) * 30, 6 + (i % 2) * 3, 0, 0, 6.283); ctx.fill();
        }
        ctx.restore();
    }
    function drawClouds(alt, baseY) {
        if (alt > 40) return;
        const sh = shiftOf(alt);
        ctx.save();
        for (const c of clouds) {
            const y = baseY - (shiftOf(c.alt) - sh);
            if (y < -120 || y > H + 120) continue;
            const x = c.x * W;
            ctx.fillStyle = `rgba(255,255,255,${0.82 * clamp(1 - alt / 40, 0, 1)})`;
            for (let i = 0; i < 4; i++) {
                ctx.beginPath(); ctx.ellipse(x + (i - 1.5) * c.w * 0.22, y + (i % 2) * 6, c.w * 0.26 * c.k, c.w * 0.1 * c.k, 0, 0, 6.283); ctx.fill();
            }
        }
        ctx.restore();
    }
    function drawGround(alt, groundY) {
        if (groundY >= H + 4) return;
        const g = ctx.createLinearGradient(0, groundY, 0, H);
        g.addColorStop(0, '#4a6a45'); g.addColorStop(0.25, '#2f4a33'); g.addColorStop(1, '#16231a');
        ctx.fillStyle = g; ctx.fillRect(0, groundY, W, H - groundY + 4);
        // 해안선/바다 띠
        ctx.fillStyle = '#2a5f8f'; ctx.fillRect(0, groundY + 30 * S, W, 8 * S);
        // 발사대
        ctx.fillStyle = '#7d8696'; ctx.fillRect(AX - 120 * S, groundY - 2 * S, 240 * S, 12 * S);
        ctx.fillStyle = '#566074'; ctx.fillRect(AX - 120 * S, groundY + 8 * S, 240 * S, 4 * S);
        // 타워
        const tx = AX - 70 * S, th = 300 * S;
        ctx.strokeStyle = '#6b7488'; ctx.lineWidth = 2 * S;
        ctx.strokeRect(tx - 9 * S, groundY - th, 18 * S, th);
        ctx.beginPath();
        for (let y = groundY; y > groundY - th; y -= 22 * S) {
            ctx.moveTo(tx - 9 * S, y); ctx.lineTo(tx + 9 * S, y - 22 * S);
            ctx.moveTo(tx + 9 * S, y); ctx.lineTo(tx - 9 * S, y - 22 * S);
        }
        ctx.stroke();
        // 서비스 암
        if (sim.phase === 'STANDBY' || sim.phase === 'COUNTDOWN') {
            ctx.fillStyle = '#6b7488';
            ctx.fillRect(tx + 9 * S, groundY - 190 * S, 44 * S, 5 * S);
            ctx.fillRect(tx + 9 * S, groundY - 120 * S, 44 * S, 5 * S);
        }
        // 조명 / 점화 글로우
        const fl = flameScale();
        if (sim.s1.burning && sim.y < 2 && fl > 0) {
            const rg = ctx.createRadialGradient(AX, groundY, 0, AX, groundY, 220 * S);
            rg.addColorStop(0, `rgba(255,190,110,${0.55 * fl})`); rg.addColorStop(1, 'rgba(255,150,60,0)');
            ctx.fillStyle = rg; ctx.fillRect(AX - 240 * S, groundY - 220 * S, 480 * S, 240 * S);
        }
    }
    function drawStreaks(alt) {
        const sp = sim.speed;
        if (sp < 0.15 || alt < 1.2 || sim.phase === 'ORBIT' || destroyed || sim.phase === 'FAILURE') return;
        const ax = axisDir();
        const v = (120 + sp * 120) * S;
        ctx.lineWidth = 1.2;
        for (const s of streaks) {
            s.x -= ax.x * v / W * dtReal; s.y -= ax.y * v / H * dtReal;
            s.x = (s.x + 1) % 1; s.y = (s.y + 1) % 1;
            const a = clamp(sp / 3, 0, 1) * 0.22;
            const x = s.x * W, y = s.y * H, len = s.l * S * (0.6 + sp / 5);
            ctx.strokeStyle = `rgba(220,235,255,${a})`;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + ax.x * len, y + ax.y * len); ctx.stroke();
        }
    }
    function drawParticles(layer) {
        for (const p of particles) {
            const t = p.life / p.max;
            if (layer === 'smoke' && p.k === 'smoke') {
                ctx.fillStyle = `rgba(${p.tone},${p.tone + 4},${p.tone + 12},${0.5 * t})`;
                ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.283); ctx.fill();
            } else if (layer === 'fire' && (p.k === 'fire' || p.k === 'spark')) {
                ctx.globalCompositeOperation = 'lighter';
                const r = p.size * (p.k === 'fire' ? (0.4 + t) : 1);
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2);
                const hue = p.k === 'fire' ? 28 + t * 20 : p.hue;
                g.addColorStop(0, `hsla(${hue},100%,${p.k === 'fire' ? 70 : 75}%,${0.85 * t})`);
                g.addColorStop(1, `hsla(${hue},100%,50%,0)`);
                ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 2, 0, 6.283); ctx.fill();
                ctx.globalCompositeOperation = 'source-over';
            }
        }
    }
    function drawDebris() {
        for (const d of debris) {
            ctx.save();
            ctx.globalAlpha = d.age > 22 ? clamp(1 - (d.age - 22) / 18, 0, 1) : 1;
            ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.s, d.s); ctx.translate(-d.cx, -d.cy);
            if (d.kind === 'first') drawS1(ctx);
            else if (d.kind === 'second') drawS2(ctx, true);
            else if (d.kind === 'fairL') drawFairing(ctx, 'L');
            else if (d.kind === 'fairR') drawFairing(ctx, 'R');
            else if (d.kind === 'sat') { ctx.translate(0, d.cy); drawSat(ctx, 0.2); }
            ctx.restore();
        }
    }
    function drawRocket() {
        if (destroyed) return;
        if (satOnly) {
            const k = clamp(satAge / 4, 0, 1);
            const drift = Math.min(60, 9 * Math.pow(satAge, 0.7));
            const base = rot(0, -80), ax = axisDir();
            ctx.save();
            ctx.translate(base.x + ax.x * drift * S, base.y + ax.y * drift * S);
            ctx.rotate(visTheta); ctx.scale(S * 1.25, S * 1.25);
            drawSat(ctx, k);
            ctx.restore();
            return;
        }
        ctx.save();
        ctx.translate(AX, AY); ctx.rotate(visTheta); ctx.scale(S, S);
        const fs = flameScale();
        const expand = clamp(sim.y / 80, 0, 1);
        ctx.globalCompositeOperation = 'lighter';
        if (sim.s1.attached && sim.s1.burning && fs > 0) {
            drawFlame(ctx, 134, 18 + expand * 14, 110 + expand * 40, fs);
            ctx.save(); ctx.translate(-11, 0); drawFlame(ctx, 134, 9 + expand * 9, 70 + expand * 30, fs); ctx.restore();
            ctx.save(); ctx.translate(11, 0); drawFlame(ctx, 134, 9 + expand * 9, 70 + expand * 30, fs); ctx.restore();
        } else if (!sim.s1.attached && sim.s2.attached && sim.s2.burning) {
            drawFlame(ctx, 9, 10 + expand * 10, 54 + expand * 30, 1);
        }
        ctx.globalCompositeOperation = 'source-over';
        if (sim.s1.attached) drawS1(ctx);
        if (sim.s2.attached) drawS2(ctx, !sim.s1.attached);
        if (sim.fairing.attached) drawFairing(ctx, null);
        else if (sim.s2.attached) drawPayloadStack(ctx);
        ctx.restore();
    }

    let dtReal = 0.016;
    function render() {
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        frameGeom();
        const alt = sim.y;
        const sh = shiftOf(alt);
        const baseY = AY + 138 * S;
        const groundY = baseY + sh;

        ctx.save();
        if (shake > 0.2) ctx.translate(rand(-shake, shake) * 0.5, rand(-shake, shake) * 0.5);
        drawSky(alt);
        drawStars(alt);
        drawEarth(alt);
        drawClouds(alt, baseY);
        drawGround(alt, groundY);
        drawStreaks(alt);
        drawParticles('smoke');
        drawDebris();
        drawRocket();
        drawParticles('fire');
        ctx.restore();

        if (flash > 0.01) {
            ctx.fillStyle = `rgba(255,235,210,${flash * 0.45})`;
            ctx.fillRect(0, 0, W, H);
        }
        return { groundY, sh };
    }

    /* ====================================================== UI ========== */
    const el = {
        clock: $('clock'), speed: $('tSpeed'), alt: $('tAlt'), range: $('tRange'), g: $('tG'), q: $('tQ'), orbit: $('tOrbit'),
        fuelLabel: $('fuelLabel'), fuelPct: $('fuelPct'), fuelBar: $('fuelBar'),
        state: $('stateText'), chip: $('phaseChip'), count: $('count'),
        launch: $('btnLaunch'), pause: $('btnPause'), reset: $('btnReset'),
        timeline: $('timeline'), log: $('log'), chart: $('chart'),
        result: $('result'), resultCard: $('resultCard'), resultTag: $('resultTag'), resultTitle: $('resultTitle'), resultReason: $('resultReason'), resultStats: $('resultStats'),
        mode: $('mode'), rate: $('rate'), scenario: $('scenario'), manualHint: $('manualHint'),
    };

    const fmtClock = (t) => {
        if (t < 0) { const s = Math.ceil(-t); return 'T− ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
        const s = Math.floor(t); return 'T+ ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    };
    const fmtT = (t) => {
        const s = Math.floor(Math.abs(t));
        return (t < 0 ? 'T−' : 'T+') + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    };

    const STATUS_ICON = { ok: '✓', warn: '!', fail: '✕', pending: '' };
    const STATUS_TXT = { ok: 'NOMINAL', warn: 'WARNING', fail: 'FAILURE' };

    function buildTimeline() {
        el.timeline.innerHTML = '';
        sim.events.forEach((e, i) => {
            const li = document.createElement('li');
            li.id = 'ev-' + e.id;
            li.innerHTML = `<div class="dot">${i + 1}</div><div class="lb">${e.label}</div><div class="tm">—</div><div class="nt"></div>`;
            el.timeline.appendChild(li);
        });
        el.log.innerHTML = '';
    }
    function updateTimelineItem(e) {
        const li = $('ev-' + e.id);
        if (!li) return;
        li.className = e.status === 'pending' ? '' : e.status;
        li.querySelector('.dot').textContent = STATUS_ICON[e.status] || '';
        li.querySelector('.tm').textContent = e.t == null ? '—' : fmtT(e.t);
        li.querySelector('.nt').textContent = e.note || '';
    }
    function refreshTimelineStates() {
        let nextMarked = false;
        for (const e of sim.events) {
            const li = $('ev-' + e.id);
            if (!li) continue;
            const base = e.status === 'pending' ? '' : e.status;
            let cls = base;
            if (e.status === 'pending') {
                if (sim.phase === 'FAILURE' || sim.phase === 'ORBIT') cls = 'skip';
                else if (!nextMarked && sim.phase !== 'STANDBY') { cls = 'next'; nextMarked = true; }
            }
            if (li.className !== cls) li.className = cls;
        }
    }
    function logEvent(e) {
        const li = document.createElement('li');
        li.className = e.status;
        li.innerHTML = `<b>${fmtT(e.t)}</b>${e.label} <span class="s">${STATUS_TXT[e.status] || ''}</span>${e.note ? ' · ' + e.note : ''}`;
        el.log.appendChild(li);
        el.log.scrollTop = el.log.scrollHeight;
    }

    function showCount(txt) {
        el.count.className = 'count';
        void el.count.offsetWidth;
        el.count.textContent = typeof txt === 'number' ? String(txt) : txt;
        el.count.className = 'count pop' + (typeof txt === 'number' ? '' : ' small');
    }

    function showResult() {
        const r = sim.result;
        if (!r) return;
        const kind = r.success ? (r.warn ? 'warn' : 'ok') : 'fail';
        el.resultCard.dataset.r = kind;
        el.resultTag.textContent = 'MISSION REPORT';
        el.resultTitle.textContent = r.success ? (r.warn ? 'MISSION SUCCESS · 경고 있음' : 'MISSION SUCCESS') : 'MISSION FAILED';
        el.resultReason.textContent = r.success ? '궤도 진입에 성공했습니다. 최종 궤도: ' + r.reason : r.reason;
        const s = r.stats;
        const items = [
            ['최고 속력', s.maxSpeed.toFixed(2) + ' km/s'],
            ['최고 고도', s.maxAlt.toFixed(0) + ' km'],
            ['Max-Q', s.maxQ.toFixed(1) + ' kPa'],
            ['최대 가속', s.maxG.toFixed(1) + ' g'],
            ['분리 성공', r.sepOk + ' / ' + r.sepTotal],
            ['총 비행 시간', fmtClock(r.duration).replace('T+ ', '')],
        ];
        el.resultStats.innerHTML = items.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
        el.result.hidden = false;
    }

    /* --- 단 분리 패널 --- */
    const STAGE_DEF = [
        { key: 'first', ev: 'sep1', att: () => sim.s1.attached, call: 'first' },
        { key: 'fairing', ev: 'fairing', att: () => sim.fairing.attached, call: 'fairing' },
        { key: 'second', ev: 'sep2', att: () => sim.s2.attached, call: 'second' },
    ];
    function isReady(key) {
        if (key === 'first') return sim.s1.attached && !sim.s1.burning && sim.tMeco != null;
        if (key === 'fairing') return sim.fairing.attached && sim.y >= 100 && !sim.s1.attached;
        if (key === 'second') return sim.s2.attached && !sim.s2.burning && sim.tSeco != null && !sim.fairing.attached;
        return false;
    }
    function updateStages() {
        const inFlight = ['ASCENT', 'COAST', 'STAGE2', 'COAST2'].includes(sim.phase);
        for (const d of STAGE_DEF) {
            const badge = $('b-' + d.key), btn = $('s-' + d.key);
            const e = sim.ev(d.ev);
            const attached = d.att();
            let txt = attached ? 'ATTACHED' : 'SEPARATED', cls = 'badge' + (attached ? '' : ' sep');
            if (e.status === 'fail') { txt = attached ? 'STUCK' : 'FAILED'; cls = 'badge fail'; }
            else if (e.status === 'warn') cls = 'badge warn';
            if (badge.textContent !== txt) badge.textContent = txt;
            if (badge.className !== cls) badge.className = cls;
            const enabled = sim.mode === 'manual' && inFlight && attached;
            btn.disabled = !enabled;
            btn.classList.toggle('ready', enabled && isReady(d.key));
        }
        el.manualHint.textContent = sim.mode === 'manual' ? 'MANUAL OVERRIDE' : '자동 모드';
    }

    /* --- 그래프 --- */
    const chartCtx = el.chart.getContext('2d');
    function drawChart() {
        const c = el.chart, r = c.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(10, Math.round(r.width * dpr)), h = Math.max(10, Math.round(r.height * dpr));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const g = chartCtx;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const cw = r.width, ch = r.height;
        g.clearRect(0, 0, cw, ch);
        const TMAX = 480, pad = 6;
        const X = (t) => pad + (t / TMAX) * (cw - pad * 2);
        const Y = (v, vmax) => ch - pad - (v / vmax) * (ch - pad * 2);
        g.strokeStyle = 'rgba(80,110,170,.18)'; g.lineWidth = 1;
        for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(pad, (ch / 4) * i); g.lineTo(cw - pad, (ch / 4) * i); g.stroke(); }
        for (const e of sim.events) {
            if (e.t == null || e.t < 0 || e.status === 'pending') continue;
            g.strokeStyle = e.status === 'fail' ? 'rgba(255,77,94,.7)' : e.status === 'warn' ? 'rgba(255,194,71,.6)' : 'rgba(61,220,151,.35)';
            g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(e.t), pad); g.lineTo(X(e.t), ch - pad); g.stroke(); g.setLineDash([]);
        }
        const line = (key, vmax, color) => {
            if (history.length < 2) return;
            g.strokeStyle = color; g.lineWidth = 2; g.beginPath();
            history.forEach((p, i) => { const x = X(p.t), y = Y(p[key], vmax); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
            g.stroke();
        };
        line('alt', 330, '#4cc9f0');
        line('spd', 8.2, '#ff7a45');
    }

    /* --- 패널 갱신 --- */
    function updatePanel() {
        el.clock.textContent = fmtClock(sim.t);
        el.speed.textContent = sim.speed.toFixed(2);
        el.alt.textContent = sim.y.toFixed(1);
        el.range.textContent = Math.round(sim.x);
        el.g.textContent = (sim.phase === 'ASCENT' || sim.phase === 'STAGE2') ? sim.gload.toFixed(1) : (sim.phase === 'COUNTDOWN' || sim.phase === 'STANDBY' ? '1.0' : '0.0');
        el.q.textContent = sim.q.toFixed(1);
        const o = sim.orbitElements();
        el.orbit.textContent = (!sim.s1.attached && o.peri > 0 && isFinite(o.apo)) ? Math.round(o.peri) + ' / ' + Math.round(o.apo) : '—';
        const useS1 = sim.s1.attached;
        const pct = clamp((useS1 ? sim.s1.prop / sim.cfg.s1.prop : sim.s2.prop / sim.cfg.s2.prop) * 100, 0, 100);
        const lbl = !sim.s2.attached ? '탑재체 분리 완료' : useS1 ? '1단 추진제' : '2단 추진제';
        if (el.fuelLabel.textContent !== lbl) el.fuelLabel.textContent = lbl;
        el.fuelPct.textContent = Math.round(pct) + '%';
        el.fuelBar.style.width = pct + '%';
        el.fuelBar.classList.toggle('low', pct < 15);

        let chip = 'STANDBY · PAD READY', st = 'standby', stt = 'STANDBY';
        switch (sim.phase) {
            case 'COUNTDOWN': chip = 'COUNTDOWN'; st = 'countdown'; stt = 'COUNTDOWN'; break;
            case 'ASCENT': case 'COAST': case 'STAGE2': case 'COAST2': chip = 'LIVE · ' + ({ ASCENT: 'STAGE 1 BURN', COAST: 'COAST', STAGE2: 'STAGE 2 BURN', COAST2: 'COAST' })[sim.phase]; st = 'live'; stt = 'LIVE'; break;
            case 'ORBIT': chip = 'ORBIT · COMPLETE'; st = 'orbit'; stt = 'COMPLETE'; break;
            case 'FAILURE': chip = 'ANOMALY · MISSION FAILED'; st = 'fail'; stt = 'FAILED'; break;
        }
        if (paused && ['ASCENT', 'COAST', 'STAGE2', 'COAST2', 'COUNTDOWN'].includes(sim.phase)) { chip = 'PAUSED'; stt = 'PAUSED'; }
        if (el.chip.textContent !== chip) el.chip.textContent = chip;
        el.chip.dataset.state = st;
        el.state.textContent = stt;

        const flying = ['COUNTDOWN', 'ASCENT', 'COAST', 'STAGE2', 'COAST2'].includes(sim.phase);
        el.launch.disabled = sim.phase !== 'STANDBY';
        el.pause.disabled = !flying;
        el.pause.textContent = paused ? '▶ 계속' : 'Ⅱ 일시정지';
        const locked = sim.phase !== 'STANDBY';
        el.scenario.disabled = locked;
        el.mode.querySelectorAll('button').forEach((b) => (b.disabled = locked));
    }

    /* ====================================================== 이벤트 ====== */
    sim.on((type, d) => {
        switch (type) {
            case 'reset': buildTimeline(); break;
            case 'launch': audio.init(); break;
            case 'countdown': showCount(d.n); audio.beep(); break;
            case 'ignite': showCount('IGNITION'); audio.tone(300, 0.4, 'sawtooth', 0.05); break;
            case 'liftoff': showCount('LIFTOFF'); audio.tone(990, 0.3, 'sine', 0.07); break;
            case 'separate': onSeparate(d); break;
            case 'sepAttempt': shake = 9; flash = 0.3; audio.clunk(); burst(rot(0, 6).x, rot(0, 6).y, 20, 120 * S, 0.6, 45); break;
            case 'event': updateTimelineItem(d.ev); logEvent(d.ev); audio.ping(d.ev.status); break;
            case 'fail':
                breakApart();
                audio.setRumble(0);
                showCount('ANOMALY');
                clearTimeout(resultTimer); resultTimer = setTimeout(showResult, 1800);
                break;
            case 'complete':
                audio.setRumble(0);
                showCount('ORBIT');
                clearTimeout(resultTimer); resultTimer = setTimeout(showResult, 5200);
                break;
        }
    });

    /* ====================================================== 조작 ======== */
    function doReset() {
        clearTimeout(resultTimer);
        sim.reset();
        paused = false;
        debris = []; particles = []; history = []; lastHist = -1;
        destroyed = false; satOnly = false; satAge = 0; shake = 0; flash = 0; prevShift = 0;
        el.result.hidden = true;
        el.count.className = 'count'; el.count.textContent = '';
        audio.setRumble(0);
    }
    function doLaunch() { if (sim.phase === 'STANDBY') { audio.init(); sim.launch(); } }
    function doPause() {
        if (!['COUNTDOWN', 'ASCENT', 'COAST', 'STAGE2', 'COAST2'].includes(sim.phase)) return;
        paused = !paused;
        if (paused) audio.setRumble(0);
    }

    el.launch.addEventListener('click', doLaunch);
    el.pause.addEventListener('click', doPause);
    el.reset.addEventListener('click', doReset);
    $('btnResultReset').addEventListener('click', doReset);
    $('btnAgain').addEventListener('click', () => { doReset(); doLaunch(); });
    $('btnMute').addEventListener('click', () => {
        audio.muted = !audio.muted;
        $('btnMute').textContent = audio.muted ? '🔇' : '🔊';
        if (audio.muted) audio.setRumble(0);
    });
    el.rate.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        timeScale = Number(b.dataset.r);
        el.rate.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
    el.mode.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || b.disabled) return;
        sim.mode = b.dataset.m;
        el.mode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
    el.scenario.addEventListener('change', () => { sim.scenario = el.scenario.value; });
    for (const d of STAGE_DEF) $('s-' + d.key).addEventListener('click', () => sim.separate(d.call));

    window.addEventListener('keydown', (e) => {
        if (e.target && /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        if (e.code === 'Space') { e.preventDefault(); if (sim.phase === 'STANDBY') doLaunch(); else doPause(); }
        else if (e.key === 'r' || e.key === 'R') doReset();
        else if (e.key === 'm' || e.key === 'M') $('btnMute').click();
    });

    /* ====================================================== 메인 루프 === */
    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now; dtReal = dt; clockT += dt;

        if (!paused) sim.advance(dt * timeScale);
        const fxDt = paused ? 0 : dt * Math.min(timeScale, 2);

        // 배경 이동량 변화 → 지면 고정 입자 보정
        const sh = shiftOf(sim.y);
        const dShift = sh - prevShift; prevShift = sh;

        frameGeom();
        const groundY = AY + 138 * S + sh;
        if (fxDt > 0) {
            emitExhaust(fxDt, groundY);
            updateFx(fxDt, dShift);
            shake *= Math.exp(-5 * fxDt);
            flash *= Math.exp(-6 * fxDt);
            if (sim.s1.burning && sim.y < 25 && !destroyed) shake = Math.max(shake, 1.6 * flameScale() * Math.exp(-sim.y / 14));
        }

        // 엔진 소리
        if (!paused && !destroyed) {
            const burning = (sim.s1.attached && sim.s1.burning) || (sim.s2.attached && sim.s2.burning);
            audio.setRumble(burning ? 0.05 + 0.22 * Math.exp(-sim.y / 70) * flameScale() : 0);
        }

        // 그래프 기록
        if (sim.t >= 0 && sim.t - lastHist >= 1 && !['STANDBY'].includes(sim.phase)) {
            lastHist = sim.t; history.push({ t: sim.t, alt: sim.y, spd: sim.speed });
        }

        render();
        updatePanel();
        updateStages();
        refreshTimelineStates();
        drawChart();
        requestAnimationFrame(frame);
    }

    buildTimeline();
    requestAnimationFrame(frame);

    // 디버그/테스트용
    window.__sim = sim;
})();