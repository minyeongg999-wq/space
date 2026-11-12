/* ROCKET SIM — 비행 물리·판정 코어
 * 교육용 개념 모델입니다. 실제 발사체의 형상·궤적·성능을 재현하지 않습니다.
 * 2차원 평면(지표면을 따른 수평축 + 고도) 운동 + 구 형태 지구의 중력/원심 효과를 계산합니다.
 */
(function (root) {
    'use strict';

    const RE = 6371;            // 지구 반지름 (km)
    const MU = 398600.4418;     // 지구 중력상수 (km^3/s^2)
    const G0 = 9.80665;         // 표준 중력가속도 (m/s^2)

    const DEFAULTS = {
        target: 300,                                         // 목표 궤도 고도 (km)
        s1: { dry: 20, prop: 230, thrust: 4800, isp: 310 },  // 질량 t, 추력 kN, 비추력 s
        s2: { dry: 6, prop: 76, thrust: 1000, isp: 360 },
        fairing: 3,
        payload: 8,
        qLimit: 45,                                          // 동압 한계 (kPa)
        pitchStart: 8,                                       // 피치 프로그램 시작 (s)
        pitchT: 130,
        aMax: 45,                                            // 가속도 상한 (m/s^2, 약 4.6 g)
        gKp: 0.04,                                           // 2단 유도 게인
        gKv: 0.5,
        gVmax: 1.0,
        pitchP: 1.25,
    };

    const EVENT_DEFS = [
        ['ignition', '1단 점화'],
        ['liftoff', '이륙'],
        ['maxq', 'Max-Q'],
        ['meco', '1단 연소 종료'],
        ['sep1', '1단 분리'],
        ['ign2', '2단 점화'],
        ['fairing', '페어링 분리'],
        ['seco', '2단 연소 종료'],
        ['sep2', '2단 분리'],
        ['orbit', '궤도 진입'],
    ];

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    class RocketSim {
        constructor(opts) {
            opts = opts || {};
            this.cfg = Object.assign({}, DEFAULTS, opts.cfg || {});
            this.mode = opts.mode || 'auto';          // auto | manual
            this.scenario = opts.scenario || 'none';  // none | sep1 | engine2 | fuel
            this.listeners = [];
            this.reset();
        }

        on(fn) { this.listeners.push(fn); }
        emit(type, data) { for (const f of this.listeners) f(type, data || {}); }

        /* ---------- 초기화 / 리셋 ---------- */
        reset() {
            const c = this.cfg;
            this.phase = 'STANDBY';   // STANDBY COUNTDOWN ASCENT COAST STAGE2 COAST2 ORBIT FAILURE
            this.t = -10;
            this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
            this.theta = 0;            // 수직 기준 기울기 (deg)
            this.accel = 0;            // 현재 추력 가속도 (km/s^2)
            this.q = 0;                // 동압 (kPa)
            this.s1 = { attached: true, burning: false, prop: c.s1.prop };
            this.s2 = { attached: true, burning: false, prop: c.s2.prop };
            this.fairing = { attached: true };
            this.tMeco = null; this.tSep1 = null; this.tSeco = null; this.ign2At = null;
            this.ignited = false;
            this.events = EVENT_DEFS.map(([id, label]) => ({ id, label, status: 'pending', t: null, note: '' }));
            this.stats = { maxSpeed: 0, maxAlt: 0, maxQ: 0, maxG: 0 };
            this.qMax = 0; this.maxqDone = false;
            this.result = null; this.failReason = '';
            this.lastCount = null;
            this.emit('reset');
        }

        get speed() { return Math.hypot(this.vx, this.vy); }
        get gload() { return this.accel * 1000 / G0; }

        launch() {
            if (this.phase !== 'STANDBY') return false;
            this.phase = 'COUNTDOWN';
            this.emit('launch');
            return true;
        }

        /* ---------- 유틸 ---------- */
        ev(id) { return this.events.find(e => e.id === id); }

        mark(id, status, note) {
            const e = this.ev(id);
            if (!e) return;
            e.status = status; e.t = this.t; e.note = note || '';
            this.emit('event', { ev: e });
        }

        fail(id, reason) {
            this.mark(id, 'fail', reason);
            this.phase = 'FAILURE';
            this.s1.burning = false; this.s2.burning = false;
            this.accel = 0;
            this.failReason = reason;
            this.result = this.buildResult(false, reason);
            this.emit('fail', { id, reason });
        }

        buildResult(success, reason) {
            const warns = this.events.filter(e => e.status === 'warn').length;
            const o = this.orbitElements();
            return {
                success, warn: success && warns > 0, reason: reason || '',
                duration: this.t,
                stats: Object.assign({}, this.stats),
                orbit: success ? { peri: o.peri, apo: o.apo } : null,
                sepOk: ['sep1', 'fairing', 'sep2'].filter(k => this.ev(k).status === 'ok').length,
                sepTotal: 3,
            };
        }

        mass() {
            const c = this.cfg;
            let m = c.payload;
            if (this.fairing.attached) m += c.fairing;
            if (this.s2.attached) m += c.s2.dry + this.s2.prop;
            if (this.s1.attached) m += c.s1.dry + this.s1.prop;
            return m;
        }

        orbitElements() {
            const r = RE + this.y;
            const E = 0.5 * (this.vx * this.vx + this.vy * this.vy) - MU / r;
            const h = r * this.vx;
            if (E >= 0) return { peri: -RE, apo: Infinity, ecc: 1, energy: E };
            const a = -MU / (2 * E);
            const e = Math.sqrt(Math.max(0, 1 + 2 * E * h * h / (MU * MU)));
            return { peri: a * (1 - e) - RE, apo: a * (1 + e) - RE, ecc: e, energy: E };
        }

        pitchProgram(t) {
            const c = this.cfg;
            const u = Math.max(0, t - c.pitchStart) / c.pitchT;
            return clamp(90 * (1 - Math.exp(-Math.pow(u, c.pitchP))), 0, 88);
        }

        guide(a) {
            const r = RE + this.y;
            const g = MU / (r * r) - this.vx * this.vx / r;
            const c = this.cfg;
            const vyd = clamp((c.target - this.y) * c.gKp, -0.5, c.gVmax);
            const need = (vyd - this.vy) * c.gKv + g;
            const cos = clamp(need / Math.max(a, 1e-6), -0.35, 1);
            return Math.acos(cos) * 180 / Math.PI;
        }

        /* ---------- 분리 ---------- */
        separate(which) {
            const p = this.phase;
            if (p === 'STANDBY' || p === 'COUNTDOWN' || p === 'FAILURE' || p === 'ORBIT') return false;
            const c = this.cfg;

            if (which === 'first') {
                if (!this.s1.attached) return false;
                const early = this.s1.burning && this.s1.prop / c.s1.prop > 0.02;
                if (this.scenario === 'sep1') {
                    this.emit('sepAttempt', { which });
                    this.fail('sep1', '분리 볼트 점화 불량 — 1단이 분리되지 않았습니다');
                    return true;
                }
                this.s1.attached = false; this.s1.burning = false;
                this.tSep1 = this.t;
                this.emit('separate', { which, status: early ? 'fail' : 'ok' });
                if (early) {
                    this.fail('sep1', '추진 중 조기 분리 (잔여 추진제 ' + Math.round(this.s1.prop / c.s1.prop * 100) + '%)');
                    return true;
                }
                const delay = this.t - this.tMeco;
                if (delay <= 8) this.mark('sep1', 'ok', 'MECO+' + delay.toFixed(1) + 's');
                else this.mark('sep1', 'warn', '지연 분리 (MECO+' + delay.toFixed(1) + 's)');
                this.ign2At = this.t + 3;
                return true;
            }

            if (which === 'fairing') {
                if (!this.fairing.attached) return false;
                this.fairing.attached = false;
                const alt = this.y;
                this.emit('separate', { which, status: alt < 80 ? 'fail' : alt < 100 ? 'warn' : 'ok' });
                if (alt < 80) {
                    this.fail('fairing', '대기 밀도가 높은 구간(' + alt.toFixed(0) + ' km)에서 페어링 분리 — 탑재체 손상');
                } else if (alt < 100) {
                    this.mark('fairing', 'warn', '다소 이른 분리 (' + alt.toFixed(0) + ' km)');
                } else {
                    this.mark('fairing', 'ok', alt.toFixed(0) + ' km');
                }
                return true;
            }

            if (which === 'second') {
                if (!this.s2.attached) return false;
                if (this.s2.burning || this.tSeco == null) {
                    this.s2.attached = false; this.s2.burning = false;
                    this.emit('separate', { which, status: 'fail' });
                    this.fail('sep2', '2단 연소 중 탑재체 분리');
                    return true;
                }
                if (this.fairing.attached) {
                    this.fail('sep2', '페어링이 분리되지 않아 탑재체를 전개할 수 없습니다');
                    return true;
                }
                this.s2.attached = false;
                this.emit('separate', { which, status: 'ok' });
                this.mark('sep2', 'ok', '탑재체 전개');
                const o = this.orbitElements();
                const orb = Math.round(o.peri) + ' × ' + Math.round(o.apo) + ' km';
                if (o.peri >= 160) {
                    this.mark('orbit', o.peri >= c.target - 20 ? 'ok' : 'warn',
                        orb + (o.peri >= c.target - 20 ? '' : ' (목표보다 낮은 궤도)'));
                    this.phase = 'ORBIT';
                    this.result = this.buildResult(true, orb);
                    this.emit('complete', { result: this.result });
                } else {
                    this.fail('orbit', '근지점 ' + Math.round(o.peri) + ' km — 궤도 유지 불가');
                }
                return true;
            }
            return false;
        }

        /* ---------- 시뮬레이션 진행 ---------- */
        advance(dt) {
            if (this.phase === 'STANDBY' || this.phase === 'ORBIT' || this.phase === 'FAILURE') return;
            const H = 0.05;
            let left = dt;
            while (left > 1e-9) {
                const h = Math.min(H, left);
                this.step(h);
                left -= h;
                if (this.phase === 'ORBIT' || this.phase === 'FAILURE') break;
            }
        }

        step(h) {
            const c = this.cfg;
            this.t += h;

            /* 카운트다운 */
            if (this.phase === 'COUNTDOWN') {
                const n = Math.ceil(-this.t);
                if (this.t < 0 && n !== this.lastCount) { this.lastCount = n; this.emit('countdown', { n }); }
                if (!this.ignited && this.t >= -3) {
                    this.ignited = true; this.s1.burning = true;
                    this.mark('ignition', 'ok', '엔진 점화');
                    this.emit('ignite');
                }
                if (this.t >= 0) {
                    this.t = 0;
                    this.phase = 'ASCENT';
                    this.mark('liftoff', 'ok', '');
                    this.emit('liftoff');
                }
                return;
            }

            /* 2단 점화 */
            if (this.ign2At != null && this.t >= this.ign2At) {
                this.ign2At = null;
                this.s2.burning = true;
                this.phase = 'STAGE2';
                this.mark('ign2', 'ok', '');
                this.emit('ignite2');
            }

            /* 추력·질량 */
            const mass = this.mass();
            let thrust = 0, mdot = 0;
            if (this.s1.attached && this.s1.burning) {
                thrust = c.s1.thrust;
                mdot = thrust / (c.s1.isp * G0) * (this.scenario === 'fuel' ? 1.3 : 1);
            } else if (this.s2.attached && this.s2.burning) {
                thrust = c.s2.thrust;
                mdot = thrust / (c.s2.isp * G0);
            }
            if (thrust > 0) {                       // 가속도 상한(스로틀링)
                const tf = Math.min(1, c.aMax * mass / thrust);
                thrust *= tf; mdot *= tf;
            }
            const a = thrust > 0 ? thrust / mass / 1000 : 0;
            this.accel = a;

            /* 자세 */
            if (this.s2.burning && !this.s1.attached) this.theta = this.guide(a);
            else if (this.s1.attached) this.theta = this.pitchProgram(this.t);

            /* 운동 방정식 */
            const r = RE + this.y;
            const g = MU / (r * r);
            const th = this.theta * Math.PI / 180;
            let ay = a * Math.cos(th) - g + this.vx * this.vx / r;
            const ax = a * Math.sin(th) - this.vx * this.vy / r;
            if (this.y <= 0 && ay < 0) { ay = 0; if (this.vy < 0) this.vy = 0; }
            this.vy += ay * h; this.vx += ax * h;
            this.y += this.vy * h; this.x += this.vx * h * RE / r;
            if (this.y < 0) {
                this.y = 0;
                if (this.vy < 0) {
                    if (this.t > 5) { this.fail('liftoff', '추락 — 고도를 잃었습니다'); return; }
                    this.vy = 0;
                }
            }

            /* 추진제 소모 */
            if (this.s1.attached && this.s1.burning) {
                this.s1.prop -= mdot * h;
                if (this.s1.prop <= 0) {
                    this.s1.prop = 0; this.s1.burning = false; this.accel = 0;
                    this.tMeco = this.t; this.phase = 'COAST';
                    this.mark('meco', 'ok', '');
                    this.emit('meco');
                }
            } else if (this.s2.attached && this.s2.burning) {
                this.s2.prop -= mdot * h;
                if (this.scenario === 'engine2' && this.s2.prop / c.s2.prop < 0.55) {
                    this.s2.burning = false; this.accel = 0; this.tSeco = this.t;
                    this.fail('seco', '2단 터보펌프 이상 — 엔진 조기 정지');
                    return;
                }
                const o = this.orbitElements();
                if (o.peri >= c.target - 12 || this.s2.prop <= 0) {
                    this.s2.prop = Math.max(0, this.s2.prop);
                    this.s2.burning = false; this.accel = 0; this.tSeco = this.t; this.phase = 'COAST2';
                    this.emit('seco');
                    if (o.peri < 160) {
                        this.fail('seco', (this.s2.prop <= 0 ? '추진제 소진' : '연소 종료') + ' — 근지점 ' + Math.round(o.peri) + ' km (궤도 속도 미달)');
                        return;
                    }
                    this.mark('seco', o.peri >= c.target - 20 ? 'ok' : 'warn',
                        '근지점 ' + Math.round(o.peri) + ' km' + (o.peri >= c.target - 20 ? '' : ' (목표 미달)'));
                }
            }

            /* 동압 / 통계 */
            const v = this.speed * 1000;
            const rho = 1.225 * Math.exp(-this.y / 8.4);
            this.q = 0.5 * rho * v * v / 1000;
            const st = this.stats;
            st.maxSpeed = Math.max(st.maxSpeed, this.speed);
            st.maxAlt = Math.max(st.maxAlt, this.y);
            st.maxQ = Math.max(st.maxQ, this.q);
            st.maxG = Math.max(st.maxG, this.gload);
            if (this.q > c.qLimit) { this.fail('maxq', '동압 한계 초과 (' + this.q.toFixed(0) + ' kPa)'); return; }
            if (this.q > this.qMax) this.qMax = this.q;
            if (!this.maxqDone && this.t > 10 && this.q < this.qMax * 0.97) {
                this.maxqDone = true;
                this.mark('maxq', 'ok', this.qMax.toFixed(1) + ' kPa');
                this.emit('maxq');
            }

            /* 자동 분리 / 수동 모드 타임아웃 */
            if (this.mode === 'auto') {
                if (this.s1.attached && this.tMeco != null && this.t >= this.tMeco + 2) this.separate('first');
                if (this.phase !== 'FAILURE' && this.fairing.attached && this.s2.burning && this.y >= 110) this.separate('fairing');
                if (this.phase === 'COAST2' && this.s2.attached && this.t >= this.tSeco + 3) this.separate('second');
            } else {
                if (this.s1.attached && this.tMeco != null && this.t > this.tMeco + 30) {
                    this.fail('sep1', '분리 명령 없음 (MECO+30s 초과)');
                }
            }
        }
    }

    RocketSim.EVENT_DEFS = EVENT_DEFS;
    RocketSim.RE = RE;
    if (typeof module !== 'undefined' && module.exports) module.exports = RocketSim;
    else root.RocketSim = RocketSim;
})(typeof window !== 'undefined' ? window : globalThis);