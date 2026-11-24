'use strict';
/**
 * HCPToolKit — Motor de STRESS TEST real (CPU + GPU)
 *
 * · CPU: worker_threads con cargas matemáticas reales (matrices, enteros, coma flotante, memoria).
 *   Cada iteración se VERIFICA contra un resultado de referencia determinista: si el procesador
 *   o la RAM calculan mal, se registra un error de cálculo real. Nada está simulado.
 * · GPU: el renderizado 3D (WebGL2) lo ejecuta la interfaz (stress.js) sobre la GPU física; este motor
 *   recibe sus eventos (artefactos, pérdida de contexto, bloqueos) y su telemetría.
 * · Telemetría: utilización (os.cpus), frecuencia/temperatura (contadores de Windows, /sys en Linux)
 *   y GPU (nvidia-smi / contadores GPU Engine). Si un sensor no existe se informa como N/D, nunca se inventa.
 * · Persistencia: la sesión se guarda en disco (con fsync) cada segundo; si el equipo se reinicia,
 *   al abrir la aplicación `recover()` determina qué ocurrió consultando el arranque y el visor de eventos.
 * · Seguridad: límites térmicos configurables, parada de emergencia, prioridad de proceso reducida.
 *   No toca voltajes, BIOS, frecuencias ni provoca apagados.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { spawn, execFile } = require('child_process');
const { runWevtutilQuery, parseSystemEventsXml } = require('./event-parser');

const WORKER_SRC = String.raw`
const { parentPort, workerData } = require('worker_threads');
const { duty, flag, id, fault } = workerData;
const stopFlag = new Int32Array(flag);
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

// Matrices deterministas (solo +,-,* IEEE: resultado idéntico bit a bit en un procesador sano)
const N = 56;
const A = new Float64Array(N * N), B = new Float64Array(N * N), C = new Float64Array(N * N);
let seed = 123456789;
function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
for (let i = 0; i < N * N; i++) { A[i] = rnd() - 0.5; B[i] = rnd() - 0.5; }
function kMatrix() {
  let s = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    let a = 0; for (let k = 0; k < N; k++) a += A[i * N + k] * B[k * N + j];
    C[i * N + j] = a; s += a;
  }
  return s;
}
function kInt() {
  let x = 0x9E3779B9 | 0, h = 0;
  for (let i = 0; i < 1500000; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    h = (Math.imul(h ^ x, 0x01000193) + (i | 0)) | 0;
  }
  return h;
}
function kFloat() {
  let x = 1.2345;
  for (let i = 0; i < 1200000; i++) { x = (x * 1.0000013 + Math.sqrt(x + 1.5)) % 1000.5; }
  return x;
}
const MEM = new Int32Array(1 << 21); // 8 MB: estrés de caché/RAM
function kMem() {
  let s = 0, m = MEM.length - 1, v = 0x2545F491 | 0;
  for (let i = 0; i <= m; i++) { v = (Math.imul(v, 1103515245) + 12345) | 0; MEM[i] = v; }
  for (let i = 0; i <= m; i++) { const j = (Math.imul(i, 7919) + 13) & m; s = (s + (MEM[j] ^ i)) | 0; MEM[j] = s; }
  return s;
}
function iteration() { return kMatrix().toString() + '|' + kInt() + '|' + kFloat().toString() + '|' + kMem(); }

let ref = null, iters = 0, errors = 0, firstErr = '', lastPost = Date.now(), lastIters = 0;
const WINDOW = 100;
function post(final) {
  parentPort.postMessage({ type: final ? 'done' : 'hb', id, iters, errors, firstErr, ts: Date.now() });
}
ref = iteration();
while (Atomics.load(stopFlag, 0) === 0) {
  const t0 = Date.now(), busyMs = Math.max(1, Math.round(WINDOW * duty));
  do {
    let r = iteration();
    if (fault && id === 0 && iters === 5) r = r + 'X'; // solo para pruebas del propio motor
    iters++;
    if (r !== ref) { errors++; if (!firstErr) firstErr = 'Resultado distinto del esperado en la iteración ' + iters; }
    const now = Date.now();
    if (now - lastPost >= 500) { lastPost = now; post(false); }
    if (Atomics.load(stopFlag, 0) !== 0) break;
  } while (Date.now() - t0 < busyMs);
  if (duty < 1) { const rest = WINDOW - (Date.now() - t0); if (rest > 0) Atomics.wait(sleepBuf, 0, 0, rest); }
}
post(true);
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function maxOf(a) { return a.length ? Math.max(...a) : null; }
function round(v, d = 1) { return v == null ? null : Math.round(v * 10 ** d) / 10 ** d; }
function execP(cmd, args, timeout = 4000) {
  return new Promise(res => execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, so) => res(e ? null : String(so))));
}

// ─────────────────────────────── Sensores ───────────────────────────────
class Sensors {
  constructor() { this.latest = { cpuFreq: null, cpuTemp: null, cpuTempSource: null, gpuUtil: null, gpuTemp: null, gpuClock: null, gpuPower: null }; this.ps = null; this.timer = null; this.nvidia = false; }

  async start() {
    this.nvidia = !!(await execP('nvidia-smi', ['-L'], 3000));
    if (process.platform === 'win32') this._startWindows();
    this.timer = setInterval(() => this._poll(), 1000);
    this._poll();
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.ps) { try { this.ps.kill(); } catch (_) { /* */ } this.ps = null; }
  }
  _startWindows() {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$max=(Get-CimInstance Win32_Processor | Measure-Object -Property MaxClockSpeed -Maximum).Maximum
$cand=@('\\Processor Information(_Total)\\% Processor Performance','\\Thermal Zone Information(*)\\Temperature','\\GPU Engine(*)\\Utilization Percentage')
$ok=@(); foreach($p in $cand){ $t=Get-Counter -Counter $p -MaxSamples 1 -ErrorAction SilentlyContinue; if($t){$ok+=$p} }
while($true){
  $o=[ordered]@{freq=$null;temp=$null;src=$null;gpu=$null}
  if($ok.Count -gt 0){
    $s=Get-Counter -Counter $ok -SampleInterval 1 -ErrorAction SilentlyContinue
    $cs=$s.CounterSamples
    $pf=($cs|Where-Object{$_.Path -like '*% processor performance'}|Select-Object -First 1).CookedValue
    if($pf -and $max){$o.freq=[math]::Round($pf/100*$max)}
    $tz=@($cs|Where-Object{$_.Path -like '*thermal zone information*temperature'}|ForEach-Object{$_.CookedValue-273.15}|Where-Object{$_ -gt 10 -and $_ -lt 125})
    if($tz.Count -gt 0){$o.temp=[math]::Round(($tz|Measure-Object -Maximum).Maximum,1);$o.src='ACPI Thermal Zone'}
    $g=($cs|Where-Object{$_.Path -like '*gpu engine*' -and $_.Path -like '*engtype_3d*'}|Measure-Object -Property CookedValue -Sum).Sum
    if($g -ne $null){$o.gpu=[math]::Min(100,[math]::Round($g,1))}
  } else { Start-Sleep -Seconds 1 }
  if($o.temp -eq $null){
    $z=Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature
    if($z){$tt=@($z|ForEach-Object{$_.CurrentTemperature/10-273.15}|Where-Object{$_ -gt 10 -and $_ -lt 125}); if($tt.Count -gt 0){$o.temp=[math]::Round(($tt|Measure-Object -Maximum).Maximum,1);$o.src='ACPI (WMI)'}}
  }
  [Console]::Out.WriteLine(($o|ConvertTo-Json -Compress))
}`;
    try {
      this.ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
      let buf = '';
      this.ps.stdout.on('data', d => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          try {
            const o = JSON.parse(line);
            if (o.freq != null) this.latest.cpuFreq = o.freq;
            if (o.temp != null) { this.latest.cpuTemp = o.temp; this.latest.cpuTempSource = o.src; }
            if (o.gpu != null && !this.nvidia) this.latest.gpuUtil = o.gpu;
          } catch (_) { /* línea parcial */ }
        }
      });
      this.ps.on('error', () => { this.ps = null; });
    } catch (_) { this.ps = null; }
  }
  async _poll() {
    if (process.platform === 'linux') this._pollLinux();
    if (this.nvidia && !this._busy) {
      this._busy = true;
      const out = await execP('nvidia-smi', ['--query-gpu=temperature.gpu,utilization.gpu,clocks.gr,power.draw', '--format=csv,noheader,nounits'], 3000);
      this._busy = false;
      if (out) {
        const p = out.trim().split('\n')[0].split(',').map(s => parseFloat(s));
        if (!isNaN(p[0])) this.latest.gpuTemp = p[0];
        if (!isNaN(p[1])) this.latest.gpuUtil = p[1];
        if (!isNaN(p[2])) this.latest.gpuClock = p[2];
        if (!isNaN(p[3])) this.latest.gpuPower = p[3];
      }
    }
  }
  _pollLinux() {
    try {
      let temps = [];
      const tz = '/sys/class/thermal';
      if (fs.existsSync(tz)) for (const d of fs.readdirSync(tz)) {
        if (!d.startsWith('thermal_zone')) continue;
        const type = (fs.readFileSync(`${tz}/${d}/type`, 'utf8') || '').trim();
        if (/pkg|cpu|core|x86|acpitz/i.test(type)) { const v = parseInt(fs.readFileSync(`${tz}/${d}/temp`, 'utf8'), 10) / 1000; if (v > 10 && v < 125) temps.push(v); }
      }
      const hw = '/sys/class/hwmon';
      if (!temps.length && fs.existsSync(hw)) for (const d of fs.readdirSync(hw)) {
        const name = (fs.readFileSync(`${hw}/${d}/name`, 'utf8') || '').trim();
        if (/coretemp|k10temp|zenpower|cpu/i.test(name)) for (const f of fs.readdirSync(`${hw}/${d}`)) {
          if (/^temp\d+_input$/.test(f)) { const v = parseInt(fs.readFileSync(`${hw}/${d}/${f}`, 'utf8'), 10) / 1000; if (v > 10 && v < 125) temps.push(v); }
        }
      }
      if (temps.length) { this.latest.cpuTemp = round(Math.max(...temps)); this.latest.cpuTempSource = 'sysfs thermal/hwmon'; }
      const mhz = [];
      const cf = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/cpu MHz\s*:\s*([\d.]+)/g);
      if (cf) cf.forEach(l => mhz.push(parseFloat(l.split(':')[1])));
      if (mhz.length) this.latest.cpuFreq = Math.round(avg(mhz));
    } catch (_) { /* sin sensores */ }
  }
}

// ─────────────────────────────── Motor ───────────────────────────────
class StressEngine {
  /**
   * @param {{dir:string, emit:(ev:string,data:any)=>void, log?:Function, getGpuInfo?:()=>Promise<any[]>}} opts
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.emit = opts.emit || (() => {});
    this.log = opts.log || (() => {});
    this.getGpuInfo = opts.getGpuInfo;
    this.hist = path.join(this.dir, 'history');
    fs.mkdirSync(this.hist, { recursive: true });
    this.activeFile = path.join(this.dir, 'active.json');
    this.samplesFile = path.join(this.dir, 'active.samples.jsonl');
    this.s = null;
  }

  // ── API pública ──
  isRunning() { return !!this.s; }

  status() {
    if (!this.s) return { running: false };
    const s = this.s;
    return { running: true, id: s.id, config: s.config, elapsed: Math.round((Date.now() - s.t0) / 1000), counters: s.counters, samples: s.samples.slice(-600), events: s.events, hw: s.hw, sensors: s.sensorInfo };
  }

  async start(cfg = {}) {
    if (this.s) throw new Error('Ya hay una prueba en curso.');
    const cores = os.cpus().length;
    const mode = ['cpu', 'gpu', 'combined'].includes(cfg.mode) ? cfg.mode : 'cpu';
    const config = {
      mode,
      intensity: Math.min(100, Math.max(25, parseInt(cfg.intensity, 10) || 100)),
      durationSec: Math.min(4 * 3600, Math.max(5, parseInt(cfg.durationSec, 10) || 120)),
      threads: Math.min(cores, Math.max(1, parseInt(cfg.threads, 10) || cores)),
      preset: cfg.preset || 'custom',
      limits: { cpu: Math.min(105, Math.max(60, Number(cfg.limitCpu) || 90)), gpu: Math.min(105, Math.max(60, Number(cfg.limitGpu) || 85)) },
      gpuRenderer: cfg.gpuRenderer || null,
    };
    const sensors = new Sensors();
    await sensors.start();
    const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + mode;
    const hw = await this._hardwareInfo(config);
    const s = this.s = {
      id, config, hw, sensors, t0: Date.now(), samples: [], events: [], workers: [],
      counters: { calcErrors: 0, gpuArtifacts: 0, gpuContextLost: 0, gpuStalls: 0, cpuStalls: 0, workerCrashes: 0, displayRecoveries: 0, iterations: 0 },
      stop: null, hot: { cpu: 0, gpu: 0 }, warned: {}, prevCpu: os.cpus(), gpuStats: {}, lastIters: 0, tickN: 0, status: 'running',
      pre: { startedAt: new Date().toISOString(), bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(), uptimeSec: Math.round(os.uptime()), freeMemMB: Math.round(os.freemem() / 1048576) },
      sensorInfo: {},
    };
    this.s.bootMs = Date.now() - os.uptime() * 1000;
    this._event('info', `Inicio de prueba ${mode.toUpperCase()} · intensidad ${config.intensity}% · ${config.durationSec}s` + (mode !== 'gpu' ? ` · ${config.threads} hilos` : ''));
    try { fs.writeFileSync(this.samplesFile, ''); this.sfd = fs.openSync(this.samplesFile, 'a'); } catch (_) { this.sfd = null; }
    this._persist(true);
    try { os.setPriority(process.pid, 10); } catch (_) { /* sin permiso */ }

    if (mode !== 'gpu') this._startWorkers();
    s.timer = setInterval(() => this._tick(), 1000);
    return { id, config, hw };
  }

  async stop(reason = 'user') {
    if (!this.s) return null;
    return this._finish(reason === 'emergency' ? 'emergency' : reason);
  }

  /** La interfaz comunica eventos/estadísticas de la prueba de GPU */
  gpuReport(ev = {}) {
    const s = this.s; if (!s) return;
    const c = s.counters;
    switch (ev.type) {
      case 'stats': s.gpuStats = { fps: ev.fps, passes: ev.passes, frameMs: ev.frameMs, res: ev.res }; break;
      case 'artifact': c.gpuArtifacts++; this._event('error', `Artefacto gráfico: ${ev.detail || 'el render de comprobación no coincide con la referencia'}`); break;
      case 'context-lost': c.gpuContextLost++; this._event('critical', 'Fallo del controlador gráfico: contexto de GPU perdido (posible TDR/reset del driver)'); break;
      case 'context-restored': this._event('info', 'Contexto de GPU restaurado por el controlador'); break;
      case 'stall': c.gpuStalls++; this._event('warn', `Bloqueo de GPU: fotograma de ${ev.detail || '>2 s'}`); break;
      case 'error': this._event('error', `Error gráfico: ${ev.detail || 'desconocido'}`); c.gpuArtifacts++; break;
      default: break;
    }
  }

  history() {
    try {
      return fs.readdirSync(this.hist).filter(f => f.endsWith('.json')).map(f => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(this.hist, f), 'utf8'));
          return { id: r.id, startedAt: r.startedAt, mode: r.config.mode, intensity: r.config.intensity, durationSec: r.config.durationSec, elapsedSec: r.elapsedSec, verdict: r.verdict, recovered: !!r.recovered, maxCpuTemp: r.stats.cpuTempMax, maxGpuTemp: r.stats.gpuTempMax };
        } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    } catch (_) { return []; }
  }
  report(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.hist, path.basename(id) + '.json'), 'utf8')); } catch (_) { return null; }
  }
  remove(id) {
    try { fs.unlinkSync(path.join(this.hist, path.basename(id) + '.json')); return true; } catch (_) { return false; }
  }

  /**
   * Recupera una sesión que quedó "en curso" (cierre de la app, bloqueo o REINICIO del equipo)
   * y determina qué ocurrió. No se asume nunca que un cierre de aplicación sea un reinicio.
   */
  async recover() {
    if (this.s || !fs.existsSync(this.activeFile)) return null;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(this.activeFile, 'utf8')); } catch (_) { this._clearActive(); return null; }
    if (!meta || meta.status !== 'running') { this._clearActive(); return null; }
    const samples = [];
    try {
      for (const l of fs.readFileSync(this.samplesFile, 'utf8').split('\n')) { if (l.trim()) { try { samples.push(JSON.parse(l)); } catch (_) { /* línea truncada */ } } }
    } catch (_) { /* sin muestras */ }
    const lastTs = meta.lastHeartbeat || (samples.length ? samples[samples.length - 1].ts : meta.t0);
    const bootNow = Date.now() - os.uptime() * 1000;
    const rebooted = bootNow - meta.bootMs > 60000; // el instante de arranque cambió: el equipo se reinició de verdad
    const info = { type: 'app-closed', confirmed: false, note: '', events: [] };
    if (rebooted) {
      const since = new Date(meta.t0 - 60000);
      const xp = `*[System[(EventID=41 or EventID=6008 or EventID=1074 or (EventID=1001 and Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'])) and TimeCreated[@SystemTime>='${since.toISOString()}']]]`;
      const q = await runWevtutilQuery('System', xp, 200);
      if (q.ok) {
        const evs = parseSystemEventsXml(q.xml).criticalEvents.filter(e => new Date(e.time).getTime() >= lastTs - 180000);
        info.events = evs.map(e => ({ id: e.id, time: e.time, type: e.type }));
        const bsod = evs.find(e => e.id === 1001 || (e.id === 41 && e.isBsod));
        const unexp = evs.find(e => e.id === 41 || e.id === 6008 || e.id === 1001);
        if (bsod) { info.type = 'bsod'; info.confirmed = true; info.note = 'Pantallazo azul (BSOD) confirmado por el registro de eventos de Windows.'; }
        else if (unexp) { info.type = 'reboot-unexpected'; info.confirmed = true; info.note = 'Reinicio/apagado inesperado confirmado (Kernel-Power 41 / EventLog 6008).'; }
        else if (evs.find(e => e.id === 1074)) { info.type = 'reboot-ordered'; info.note = 'El equipo se reinició de forma ordenada (evento 1074): no es un fallo por inestabilidad.'; }
        else { info.type = 'reboot-unverified'; info.note = 'El equipo se reinició durante la prueba, pero el registro de eventos no confirma la causa.'; }
      } else {
        info.type = 'reboot-unverified';
        info.note = `El equipo se reinició durante la prueba (cambio del instante de arranque). No se pudo consultar el visor de eventos para confirmar la causa: ${q.unsupported ? 'solo disponible en Windows' : q.error}`;
      }
    } else {
      info.note = 'La aplicación se cerró o dejó de responder durante la prueba, pero el equipo NO se reinició (el instante de arranque no cambió).';
    }
    const s = { id: meta.id, config: meta.config, hw: meta.hw, pre: meta.pre, samples, events: meta.events || [], counters: meta.counters || {}, t0: meta.t0, sensorInfo: meta.sensorInfo || {}, status: 'recovered' };
    s.events.push({ ts: Date.now(), level: info.confirmed ? 'critical' : 'warn', msg: `Sesión recuperada tras cierre inesperado: ${info.note}` });
    const report = this._buildReport(s, { reason: 'recovered', endedAt: lastTs, interruption: info, recovered: true });
    this._saveHistory(report);
    this._clearActive();
    this.log('WARN', `[Stress] Sesión ${meta.id} recuperada: ${info.type}`);
    return report;
  }

  // ── Internos ──
  _event(level, msg) {
    if (!this.s) return;
    const ev = { ts: Date.now(), t: Math.round((Date.now() - this.s.t0) / 1000), level, msg };
    this.s.events.push(ev);
    this.emit('stress-event', ev);
    this.log(level === 'critical' || level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO', `[Stress] ${msg}`);
  }

  _startWorkers() {
    const s = this.s, cfg = s.config;
    s.flag = new SharedArrayBuffer(4);
    s.flagView = new Int32Array(s.flag);
    const duty = cfg.intensity / 100;
    for (let i = 0; i < cfg.threads; i++) {
      const w = new Worker(WORKER_SRC, { eval: true, workerData: { duty, flag: s.flag, id: i, fault: process.env.HCP_STRESS_FAULT === '1' } });
      const st = { w, id: i, iters: 0, errors: 0, lastHb: Date.now(), done: false, stalled: false, firstErr: '' };
      w.on('message', m => {
        st.lastHb = Date.now(); st.iters = m.iters;
        if (m.errors > st.errors) {
          s.counters.calcErrors += m.errors - st.errors;
          this._event('critical', `ERROR DE CÁLCULO en el hilo ${i}: ${m.firstErr || 'resultado incorrecto'} (${m.errors} acumulados)`);
        }
        st.errors = m.errors;
        if (m.type === 'done') st.done = true;
        if (st.stalled) { st.stalled = false; this._event('info', `El hilo ${i} vuelve a responder`); }
      });
      w.on('error', e => { s.counters.workerCrashes++; st.done = true; this._event('critical', `Fallo del hilo de cálculo ${i}: ${e.message}`); });
      w.on('exit', code => { if (!st.done && this.s === s && s.stop == null) { s.counters.workerCrashes++; st.done = true; this._event('critical', `El hilo de cálculo ${i} terminó inesperadamente (código ${code})`); } st.done = true; });
      s.workers.push(st);
    }
  }

  _cpuUtil() {
    const s = this.s, cur = os.cpus();
    let idle = 0, total = 0;
    cur.forEach((c, i) => {
      const p = s.prevCpu[i]; if (!p) return;
      for (const k of Object.keys(c.times)) { const d = c.times[k] - p.times[k]; total += d; if (k === 'idle') idle += d; }
    });
    s.prevCpu = cur;
    return total > 0 ? round(100 * (1 - idle / total)) : null;
  }

  _tick() {
    const s = this.s; if (!s || s.stop) return;
    s.tickN++;
    const now = Date.now(), t = Math.round((now - s.t0) / 1000);
    const L = s.sensors.latest;
    const sumIters = s.workers.reduce((a, w) => a + w.iters, 0);
    const mode = s.config.mode;
    const sample = {
      t, ts: now,
      cpuUtil: this._cpuUtil(),
      cpuFreq: L.cpuFreq, cpuTemp: L.cpuTemp,
      gpuUtil: mode === 'cpu' ? null : L.gpuUtil, gpuTemp: mode === 'cpu' ? L.gpuTemp : L.gpuTemp, gpuClock: L.gpuClock, gpuPower: L.gpuPower,
      opsPerSec: mode === 'gpu' ? null : sumIters - s.lastIters,
      gpuFps: s.gpuStats.fps ?? null,
    };
    s.lastIters = sumIters; s.counters.iterations = sumIters;
    s.samples.push(sample);
    s.sensorInfo = { cpuTempSource: L.cpuTempSource, hasCpuTemp: L.cpuTemp != null, hasCpuFreq: L.cpuFreq != null, hasGpuTemp: L.gpuTemp != null, hasGpuUtil: L.gpuUtil != null, nvidia: s.sensors.nvidia };
    if (this.sfd != null) { try { fs.writeSync(this.sfd, JSON.stringify(sample) + '\n'); if (s.tickN % 3 === 0) fs.fsyncSync(this.sfd); } catch (_) { /* */ } }
    this._persist(s.tickN % 2 === 1);

    // Bloqueos de hilos de cálculo (sin latido > 8 s)
    for (const w of s.workers) {
      if (!w.done && !w.stalled && now - w.lastHb > 8000) { w.stalled = true; s.counters.cpuStalls++; this._event('critical', `Bloqueo: el hilo ${w.id} no responde desde hace más de 8 s`); }
    }
    // Aviso de falta de sensores (una sola vez, tras 5 s)
    if (t >= 5) {
      if (!s.warned.cpuT && mode !== 'gpu' && L.cpuTemp == null) { s.warned.cpuT = 1; this._event('warn', 'Sin sensor de temperatura de CPU disponible: la protección térmica de CPU NO está activa. Vigila la temperatura con otra herramienta.'); }
      if (!s.warned.gpuT && mode !== 'cpu' && L.gpuTemp == null) { s.warned.gpuT = 1; this._event('warn', 'Sin sensor de temperatura de GPU (solo NVIDIA expone la temperatura vía nvidia-smi): protección térmica de GPU no activa.'); }
    }
    // Protección térmica: 3 muestras consecutivas por encima del límite
    s.hot.cpu = (L.cpuTemp != null && mode !== 'gpu' && L.cpuTemp >= s.config.limits.cpu) ? s.hot.cpu + 1 : 0;
    s.hot.gpu = (L.gpuTemp != null && mode !== 'cpu' && L.gpuTemp >= s.config.limits.gpu) ? s.hot.gpu + 1 : 0;
    this.emit('stress-tick', { id: s.id, t, duration: s.config.durationSec, sample, counters: s.counters, sensors: s.sensorInfo });
    if (s.hot.cpu >= 3) { s.thermal = { component: 'CPU', temp: L.cpuTemp, limit: s.config.limits.cpu }; this._event('critical', `PARADA TÉRMICA: CPU a ${L.cpuTemp} °C (límite ${s.config.limits.cpu} °C)`); this._finish('thermal'); return; }
    if (s.hot.gpu >= 3) { s.thermal = { component: 'GPU', temp: L.gpuTemp, limit: s.config.limits.gpu }; this._event('critical', `PARADA TÉRMICA: GPU a ${L.gpuTemp} °C (límite ${s.config.limits.gpu} °C)`); this._finish('thermal'); return; }
    if (t >= s.config.durationSec) this._finish('completed');
  }

  _persist(force) {
    const s = this.s; if (!s || !force) return;
    const meta = { status: 'running', id: s.id, config: s.config, hw: s.hw, pre: s.pre, t0: s.t0, bootMs: s.bootMs, lastHeartbeat: Date.now(), counters: s.counters, events: s.events.slice(-200), sensorInfo: s.sensorInfo };
    try {
      const tmp = this.activeFile + '.tmp';
      const fd = fs.openSync(tmp, 'w'); fs.writeSync(fd, JSON.stringify(meta)); fs.fsyncSync(fd); fs.closeSync(fd);
      fs.renameSync(tmp, this.activeFile);
    } catch (_) { /* disco no disponible */ }
  }
  _clearActive() {
    try { fs.unlinkSync(this.activeFile); } catch (_) { /* */ }
    try { fs.unlinkSync(this.samplesFile); } catch (_) { /* */ }
  }
  _saveHistory(report) {
    try { fs.writeFileSync(path.join(this.hist, report.id + '.json'), JSON.stringify(report)); } catch (e) { this.log('ERROR', `[Stress] No se pudo guardar el informe: ${e.message}`); }
  }

  async _finish(reason) {
    const s = this.s; if (!s || s.stop) return null;
    s.stop = reason;
    clearInterval(s.timer);
    if (s.flagView) Atomics.store(s.flagView, 0, 1);
    await sleep(400);
    for (const w of s.workers) { try { await w.w.terminate(); } catch (_) { /* */ } }
    s.sensors.stop();
    try { os.setPriority(process.pid, 0); } catch (_) { /* */ }
    if (this.sfd != null) { try { fs.fsyncSync(this.sfd); fs.closeSync(this.sfd); } catch (_) { /* */ } this.sfd = null; }
    const endedAt = Date.now();
    // Estado posterior: ¿el controlador gráfico se reinició durante la prueba? (Display 4101)
    if (process.platform === 'win32') {
      const q = await runWevtutilQuery('System', `*[System[(EventID=4101 and Provider[@Name='Display']) and TimeCreated[@SystemTime>='${new Date(s.t0 - 1000).toISOString()}']]]`, 50);
      if (q.ok) {
        const n = (q.xml.match(/<Event[\s>]/gi) || []).length;
        if (n > 0) { s.counters.displayRecoveries = n; this._event('critical', `El controlador gráfico dejó de responder y se recuperó ${n} vez/veces durante la prueba (evento Display 4101)`); }
      }
    }
    s.post = { endedAt: new Date(endedAt).toISOString(), uptimeSec: Math.round(os.uptime()), bootTime: new Date(Date.now() - os.uptime() * 1000).toISOString(), rebooted: false };
    const report = this._buildReport(s, { reason, endedAt });
    this._saveHistory(report);
    this._clearActive();
    this.s = null;
    this.emit('stress-finished', report);
    return report;
  }

  async _hardwareInfo(config) {
    const cpus = os.cpus();
    const hw = {
      hostname: os.hostname(), os: `${os.type()} ${os.release()} (${os.arch()})`,
      cpuModel: (cpus[0] && cpus[0].model || 'N/D').trim(), logicalCores: cpus.length,
      cpuBaseMhz: cpus[0] ? cpus[0].speed : null, ramGB: round(os.totalmem() / 1073741824, 1), gpus: [],
    };
    try {
      if (this.getGpuInfo) { const g = await this.getGpuInfo(); (Array.isArray(g) ? g : []).forEach(x => { const n = x && (x.name || x.model || x.nombre); if (n) hw.gpus.push(String(n)); }); }
    } catch (_) { /* */ }
    if (!hw.gpus.length) { const o = await execP('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], 3000); if (o) o.trim().split('\n').forEach(n => hw.gpus.push(n.trim())); }
    if (!hw.gpus.length && config.gpuRenderer) hw.gpus.push(config.gpuRenderer);
    hw.gpuRenderer = config.gpuRenderer;
    return hw;
  }

  _buildReport(s, o) {
    const samples = s.samples, cfg = s.config, c = Object.assign({ calcErrors: 0, gpuArtifacts: 0, gpuContextLost: 0, gpuStalls: 0, cpuStalls: 0, workerCrashes: 0, displayRecoveries: 0, iterations: 0 }, s.counters);
    const col = k => samples.map(x => x[k]).filter(v => v != null && !isNaN(v));
    const f = col('cpuFreq'), ct = col('cpuTemp'), gt = col('gpuTemp'), cu = col('cpuUtil'), gu = col('gpuUtil');
    const elapsedSec = samples.length ? samples[samples.length - 1].t : 0;
    const stats = {
      cpuTempMax: maxOf(ct), cpuTempAvg: round(avg(ct)), gpuTempMax: maxOf(gt), gpuTempAvg: round(avg(gt)),
      cpuFreqMax: maxOf(f), cpuFreqAvg: f.length ? Math.round(avg(f)) : null,
      cpuUtilAvg: round(avg(cu)), cpuUtilMax: maxOf(cu), gpuUtilAvg: round(avg(gu)), gpuUtilMax: maxOf(gu),
      gpuClockMax: maxOf(col('gpuClock')), gpuPowerMax: maxOf(col('gpuPower')), gpuFpsAvg: round(avg(col('gpuFps'))),
    };
    // Limitación térmica: caída sostenida de frecuencia con la CPU al máximo
    let throttled = false;
    if (f.length > 20 && cfg.mode !== 'gpu') {
      const warm = samples.filter(x => x.t > 10 && x.cpuFreq != null && (x.cpuUtil || 0) > 85);
      if (warm.length > 10) { const m = Math.max(...f); const late = warm.slice(-Math.ceil(warm.length / 3)); if (avg(late.map(x => x.cpuFreq)) < m * 0.8) throttled = true; }
    }
    const interruption = o.interruption || null;
    const completed = o.reason === 'completed';
    const interrupted = !completed;
    const critical = [];
    if (c.calcErrors > 0) critical.push(`${c.calcErrors} error(es) de cálculo`);
    if (c.gpuArtifacts > 0) critical.push(`${c.gpuArtifacts} fallo(s)/artefacto(s) gráfico(s)`);
    if (c.gpuContextLost > 0) critical.push('fallo del controlador gráfico (contexto perdido)');
    if (c.displayRecoveries > 0) critical.push('el controlador gráfico se reinició (Display 4101)');
    if (c.workerCrashes > 0) critical.push('hilo de cálculo caído');
    if (c.cpuStalls > 0) critical.push('bloqueo de hilos de cálculo');
    if (interruption && interruption.confirmed) critical.push(interruption.type === 'bsod' ? 'pantallazo azul (BSOD) confirmado' : 'reinicio inesperado confirmado');
    const warnings = [];
    if (throttled) warnings.push('Limitación de frecuencia (thermal/power throttling) detectada bajo carga');
    if (c.gpuStalls > 0) warnings.push(`${c.gpuStalls} bloqueo(s) puntual(es) de la GPU (fotogramas >2 s)`);
    if (cfg.mode !== 'gpu' && !ct.length) warnings.push('Sin telemetría de temperatura de CPU: no se pudo verificar el comportamiento térmico');
    if (cfg.mode !== 'cpu' && !gt.length) warnings.push('Sin telemetría de temperatura de GPU');
    if (ct.length && maxOf(ct) >= cfg.limits.cpu - 5) warnings.push(`Temperatura de CPU muy cercana al límite (${maxOf(ct)} °C)`);
    if (gt.length && maxOf(gt) >= cfg.limits.gpu - 5) warnings.push(`Temperatura de GPU muy cercana al límite (${maxOf(gt)} °C)`);
    if (s.thermal) warnings.push(`Parada térmica de seguridad: ${s.thermal.component} a ${s.thermal.temp} °C (límite ${s.thermal.limit} °C)`);
    if (interruption && !interruption.confirmed) warnings.push(interruption.note);

    let verdict;
    if (critical.length) verdict = 'FALLIDO';
    else if (interrupted) verdict = 'INTERRUMPIDO';
    else if (warnings.length) verdict = 'ADVERTENCIA';
    else verdict = 'APROBADO';

    const reasonText = {
      completed: 'La prueba se completó en el tiempo configurado.', user: 'Detenida manualmente por el usuario.', emergency: 'Parada de emergencia pulsada por el usuario.',
      thermal: 'Detenida automáticamente por superar el límite térmico configurado.', recovered: interruption ? interruption.note : 'Sesión recuperada.', error: 'Detenida por un error.',
    }[o.reason] || o.reason;
    return {
      id: s.id, version: 1, generatedAt: new Date().toISOString(), startedAt: new Date(s.t0).toISOString(), endedAt: new Date(o.endedAt || Date.now()).toISOString(),
      recovered: !!o.recovered, config: cfg, hw: s.hw, elapsedSec, plannedSec: cfg.durationSec, endReason: o.reason, endReasonText: reasonText,
      verdict, criticalFindings: critical, warnings, counters: c, stats, throttled,
      thresholdsUsed: cfg.limits, pre: s.pre, post: s.post || null, interruption,
      sensors: s.sensorInfo || {}, events: s.events, samples,
      note: 'Temperatura de CPU obtenida de zonas térmicas ACPI/sysfs (no es la temperatura interna de cada núcleo). La frecuencia en Windows se calcula con el contador "% Processor Performance".',
    };
  }
}

module.exports = { StressEngine };
