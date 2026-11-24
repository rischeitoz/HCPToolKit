/**
 * @file event-parser.js
 * @description Recogida y parseo compartidos del Visor de Eventos (Electron y modo web).
 * Consulta el log System con wevtutil.exe (sin PowerShell) y extrae los eventos 41, 6008, 1001 y 1074.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Decodificar entidades XML básicas (&amp; &lt; &gt; &quot; &apos; y numéricas)
function decodeXmlEntities(str = '') {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Extraer el valor de un elemento XML de forma simple (sin parseador externo)
function xmlVal(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const m  = re.exec(xml);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

// Parsear datos de elementos XML tanto por atributo Name como por posición secuencial (nativo Windows).
// Importante: los <Data Name='x' /> vacíos (autocerrados) también ocupan posición; si se ignoran,
// todos los campos posteriores quedan desplazados.
function extractXmlData(block) {
  const named = {};
  const list = [];
  const dataRegex = /<Data(?:\s+Name=['"]([^'"]*)['"])?\s*(?:\/>|>([\s\S]*?)<\/Data>)/gi;
  let match;
  while ((match = dataRegex.exec(block)) !== null) {
    const val = decodeXmlEntities((match[2] || '').trim());
    list.push(val);
    if (match[1]) {
      named[match[1].toLowerCase()] = val;
    }
  }
  return { named, list };
}

// Propiedades del evento en el orden que espera extractEventDetails (system-event-log.js)
function orderedRawProps(ev) {
  const p = ev.rawParams || {};
  switch (ev.eventId) {
    case 41:   return [p.bugcheckCode, p.param1, p.param2, p.param3, p.param4, p.sleepInProgress, p.powerButtonTimestamp];
    case 6008: return [p.shutdownTime, p.shutdownDate];
    case 1001: return [p.stopCode, p.dumpPath, p.reportId];
    case 1074: return [p.process, p.machine, p.reasonComment, p.reasonCode, p.shutdownType, p.extraComment, p.user];
    default:   return Object.values(p);
  }
}

// Parsear estrictamente solo los eventos críticos 41, 6008, 1001 y 1074 con máxima información técnica
function parseSystemEventsXml(xmlText) {
  const criticalEvents = [];
  let lastShutdownInfo = null;

  if (!xmlText) {
    return { criticalEvents, powerEvents: criticalEvents, lastShutdownInfo, powerStats: calculatePowerStats([]) };
  }

  const eventBlocks = xmlText.split(/<Event\s/i).slice(1);

  for (const block of eventBlocks) {
    try {
      const eventId = parseInt(xmlVal(block, 'EventID'), 10);
      if (![41, 6008, 1001, 1074].includes(eventId)) continue;

      const timeRaw = block.match(/TimeCreated\s+SystemTime=['"]([^'"]+)['"]/i)?.[1] || '';
      const time = timeRaw ? new Date(timeRaw) : null;
      if (!time || isNaN(time.getTime())) continue;

      const provider = xmlVal(block, 'Provider') || block.match(/Provider\s+Name=['"]([^'"]+)['"]/i)?.[1] || 'System';
      const { named, list } = extractXmlData(block);
      const isoTime = time.toISOString();

      if (eventId === 41) {
        // Evento 41: Kernel-Power (Reinicio sin apagado limpio previo)
        const bugcheck = named.bugcheckcode || list[0] || '0';
        const numBug = parseInt(bugcheck, 10);
        const isBsod = !isNaN(numBug) && numBug !== 0;
        const bugcheckHex = isBsod ? `0x${numBug.toString(16).toUpperCase().padStart(8, '0')}` : '0x00000000';
        const p1 = named.bugcheckparameter1 || list[1] || '0x0';
        const p2 = named.bugcheckparameter2 || list[2] || '0x0';
        const p3 = named.bugcheckparameter3 || list[3] || '0x0';
        const p4 = named.bugcheckparameter4 || list[4] || '0x0';
        const sleepProgress = named.sleepinprogress || list[5] || '0';
        const powerBtn = named.powerbuttontimestamp || list[6] || '0';

        const hasPowerButton = powerBtn && powerBtn !== '0';
        let reason = '';
        let diagnostic = '';
        if (hasPowerButton) {
          reason = 'Apagado forzado por botón físico (Power Button). El usuario mantuvo pulsado el botón de encendido.';
          diagnostic = 'El sensor de hardware de la placa base registró una pulsación prolongada de apagado brusco.';
        } else if (isBsod) {
          reason = `Reinicio automático tras Pantallazo Azul previo (Código BugCheck: ${bugcheckHex}).`;
          diagnostic = `El kernel experimentó un error crítico y reinició el equipo. Parámetros de parada: (${p1}, ${p2}, ${p3}, ${p4}).`;
        } else {
          reason = 'Pérdida súbita de alimentación eléctrica o bloqueo completo (congelamiento de CPU/GPU).';
          diagnostic = 'El equipo dejó de recibir suministro eléctrico de golpe sin completar la secuencia de apagado de Windows.';
        }

        const ev = {
          id: 41,
          eventId: 41,
          time: isoTime,
          type: 'Kernel-Power (Reinicio Inesperado sin Apagado Limpio)',
          typeCode: 'kernel_power',
          category: 'critico',
          level: 'Crítico',
          levelBadge: 'err',
          icon: '⚡',
          provider: provider || 'Microsoft-Windows-Kernel-Power',
          user: 'NT AUTHORITY\\SYSTEM',
          process: 'Kernel de Windows (ntoskrnl.exe)',
          reason,
          detail: `BugCheckCode: ${bugcheckHex} | Parámetros: (${p1}, ${p2}, ${p3}, ${p4}) | SleepInProgress: ${sleepProgress} | PowerButtonTimestamp: ${powerBtn}`,
          diagnostic,
          rawParams: {
            bugcheckCode: bugcheckHex,
            param1: p1,
            param2: p2,
            param3: p3,
            param4: p4,
            sleepInProgress: sleepProgress,
            powerButtonTimestamp: powerBtn
          }
        };
        criticalEvents.push(ev);

        if (!lastShutdownInfo) {
          lastShutdownInfo = {
            time: isoTime,
            type: ev.type,
            category: 'apagado_inesperado',
            user: ev.user,
            process: ev.process,
            reason: ev.reason
          };
        }
      } else if (eventId === 6008) {
        // Evento 6008: EventLog (Apagado inesperado anterior)
        const shutdownTime = named.param1 || list[0] || '';
        const shutdownDate = named.param2 || list[1] || '';
        const shutdownTimestamp = (shutdownDate && shutdownTime) ? `${shutdownDate} a las ${shutdownTime}` : 'en la sesión anterior';

        const ev = {
          id: 6008,
          eventId: 6008,
          time: isoTime,
          type: 'Apagado Inesperado del Sistema (Corte / Sucio)',
          typeCode: 'unexpected',
          category: 'inesperado',
          level: 'Error / Advertencia',
          levelBadge: 'warn',
          icon: '⚠️',
          provider: provider || 'EventLog',
          user: 'Sistema Local',
          process: 'C:\\Windows\\System32\\services.exe',
          reason: `El apagado anterior del equipo registrado ${shutdownTimestamp} resultó inesperado.`,
          detail: 'El kernel de Windows detectó durante el arranque que la sesión anterior no completó la rutina de apagado limpio (corte de alimentación o apagado forzado).',
          diagnostic: 'Apagado sucio (Dirty Shutdown). Windows tuvo que verificar la integridad y coherencia del sistema de archivos NTFS en el inicio subsiguiente.',
          rawParams: {
            shutdownTime,
            shutdownDate
          }
        };
        criticalEvents.push(ev);

        if (!lastShutdownInfo) {
          lastShutdownInfo = {
            time: isoTime,
            type: ev.type,
            category: 'apagado_inesperado',
            user: ev.user,
            process: ev.process,
            reason: ev.reason
          };
        }
      } else if (eventId === 1001) {
        // Evento 1001: BugCheck / Windows Error Reporting (BSOD)
        const rawString = named.param1 || list.join(' ') || '';
        const dumpPath = named.param2 || list[1] || 'C:\\Windows\\MEMORY.DMP';
        const reportId = named.param3 || list[2] || 'N/D';

        const codeMatch = rawString.match(/0x[0-9a-fA-F]+/i);
        const stopCode = codeMatch ? codeMatch[0] : '0x00000000';

        const ev = {
          id: 1001,
          eventId: 1001,
          time: isoTime,
          type: 'Pantallazo Azul de la Muerte (BSOD / BugCheck)',
          typeCode: 'bsod',
          category: 'critico',
          level: 'Crítico',
          levelBadge: 'err',
          icon: '💥',
          provider: provider || 'Microsoft-Windows-WER-SystemErrorReporting',
          user: 'NT AUTHORITY\\SYSTEM',
          process: 'Kernel BugCheck / WER Reporting',
          reason: `Detención crítica del kernel de Windows por comprobación de error (${stopCode}).`,
          detail: rawString || `El equipo se reinició tras un error grave. Archivo de volcado: ${dumpPath}`,
          diagnostic: `Se generó un archivo de volcado de depuración para análisis forense: ${dumpPath} (Id. de informe: ${reportId}).`,
          rawParams: {
            stopCode,
            dumpPath,
            reportId,
            rawText: rawString
          }
        };
        criticalEvents.push(ev);
      } else if (eventId === 1074) {
        // Evento 1074: USER32 (Apagados o reinicios ordenados)
        // Orden real de los datos del evento 1074 (User32):
        // param1 proceso · param2 equipo · param3 motivo · param4 código de motivo ·
        // param5 tipo de cierre (restart / power off) · param6 comentario · param7 usuario
        const proc = named.param1 || list[0] || 'C:\\Windows\\System32\\shutdown.exe';
        const machine = named.param2 || list[1] || '';
        const reasonText = named.param3 || list[2] || '';
        const reasonCode = named.param4 || list[3] || '0x00000000';
        const actionText = (named.param5 || list[4] || '').toLowerCase();
        const extraComment = named.param6 || list[5] || '';
        const userName = named.param7 || list[6] || named.user || 'Usuario Local';
        const reasonComment = reasonText;

        const isReboot = /reinic|reboot|restart|reiniciar/.test(actionText);
        const actionLabel = isReboot ? 'Reinicio Ordenado (User32)' : 'Apagado Ordenado (User32)';

        const ev = {
          id: 1074,
          eventId: 1074,
          time: isoTime,
          type: actionLabel,
          typeCode: isReboot ? 'reboot' : 'shutdown',
          category: 'normal',
          level: 'Información',
          levelBadge: 'info',
          icon: '🔄',
          provider: provider || 'USER32',
          user: userName,
          process: proc,
          reason: reasonComment ? `Motivo: ${reasonComment}` : (isReboot ? 'Reinicio planificado y completado de forma controlada.' : 'Apagado ordenado del equipo por el usuario.'),
          detail: `Proceso ejecutor: ${proc} | Solicitado por: ${userName} | Código de motivo: ${reasonCode}${extraComment ? ` | Comentario: ${extraComment}` : ''}`,
          diagnostic: 'Operación limpia y programada sin pérdida de datos en el sistema operativo.',
          rawParams: {
            action: isReboot ? 'reboot' : 'shutdown',
            process: proc,
            machine,
            user: userName,
            reasonCode,
            reasonComment,
            shutdownType: actionText,
            extraComment
          }
        };
        criticalEvents.push(ev);

        if (!lastShutdownInfo) {
          lastShutdownInfo = {
            time: isoTime,
            type: ev.type,
            category: 'reinicio_normal',
            user: ev.user,
            process: ev.process,
            reason: ev.reason
          };
        }
      }
    } catch {}
  }

  // Ordenar cronológicamente descendente
  criticalEvents.sort((a, b) => new Date(b.time) - new Date(a.time));
  const powerStats = calculatePowerStats(criticalEvents);
  return { criticalEvents, powerEvents: criticalEvents, lastShutdownInfo, powerStats };
}

// Cálculo matemático real de estabilidad basado en eventos 41, 6008, 1001 vs 1074
function calculatePowerStats(events = []) {
  let count41 = 0;
  let count6008 = 0;
  let count1001 = 0;
  let count1074 = 0;
  let totalReboots = 0;
  let cleanShutdowns = 0;

  events.forEach(e => {
    if (e.eventId === 41) count41++;
    else if (e.eventId === 6008) count6008++;
    else if (e.eventId === 1001) count1001++;
    else if (e.eventId === 1074) {
      count1074++;
      if (e.typeCode === 'reboot') totalReboots++;
      else cleanShutdowns++;
    }
  });

  const total = events.length;
  const unexpectedCount = count41 + count6008 + count1001;
  const stabilityPct = total === 0 ? 100 : Math.max(10, Math.round(((total - unexpectedCount) / Math.max(total, 1)) * 100));

  return {
    totalEvents: total,
    count41,
    count6008,
    count1001,
    count1074,
    totalReboots,
    cleanShutdowns,
    unexpectedShutdowns: unexpectedCount,
    stabilityScore: `${stabilityPct}%`,
    statusLabel: unexpectedCount === 0 ? 'Estable' : (unexpectedCount <= 2 ? 'Atención' : 'Inestable')
  };
}

// ── Consulta directa sin elevación ──
const WEVTUTIL_MAX_EVENTS = 1000;

/**
 * Script PowerShell que lee el registro con Get-WinEvent y escribe el XML en UTF-8 (sin BOM) en un fichero.
 * No pasa por la página de códigos de la consola (con wevtutil + chcp se corrompían las tildes).
 * Códigos de salida: 0 ok (también sin eventos), 5 acceso denegado, 1 otro error.
 */
function buildPsScript(channel, xpath, outFile, maxEvents = WEVTUTIL_MAX_EVENTS) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference='Stop'",
    'try {',
    `  $ev = @(Get-WinEvent -LogName ${q(channel)} -FilterXPath ${q(xpath)} -MaxEvents ${parseInt(maxEvents, 10)})`,
    '} catch {',
    "  if ($_.FullyQualifiedErrorId -like '*NoMatchingEventsFound*') { $ev = @() }",
    "  elseif ($_.Exception -is [System.UnauthorizedAccessException] -or $_.Exception.Message -match 'denied|denegado') { [Console]::Error.WriteLine('Acceso denegado: ' + $_.Exception.Message); exit 5 }",
    "  else { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
    '}',
    "$x = ($ev | ForEach-Object { $_.ToXml() }) -join \"`n\"",
    `[System.IO.File]::WriteAllText(${q(outFile)}, $x, (New-Object System.Text.UTF8Encoding($false)))`,
    'exit 0',
  ].join('\r\n');
}

function runWevtutilQuery(channel, xpath, maxEvents = WEVTUTIL_MAX_EVENTS) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, unsupported: true, error: 'El Visor de Eventos solo está disponible en Windows.' });
      return;
    }
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const ps1 = path.join(os.tmpdir(), `hcp_evt_${stamp}.ps1`);
    const out = path.join(os.tmpdir(), `hcp_evt_${stamp}.xml`);
    const cleanup = () => { for (const f of [ps1, out]) { try { fs.unlinkSync(f); } catch (_) { /* */ } } };
    try { fs.writeFileSync(ps1, '﻿' + buildPsScript(channel, xpath, out, maxEvents), 'utf8'); }
    catch (e) { return resolve({ ok: false, error: e.message }); }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 90000, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const errTxt = String(stderr || '') + (err && err.message ? ` ${err.message}` : '');
      if (err) {
        cleanup();
        if (err.killed || err.signal) return resolve({ ok: false, error: 'La consulta al registro de eventos superó el tiempo máximo (90 s).' });
        const denied = err.code === 5 || /access is denied|acceso denegado|denied|0x5\b/i.test(errTxt);
        return resolve({ ok: false, accessDenied: denied, error: (errTxt || 'Error desconocido al leer el registro').trim().slice(0, 400) });
      }
      let xml = '';
      try { xml = fs.readFileSync(out, 'utf8').replace(/^﻿/, ''); } catch (e) { cleanup(); return resolve({ ok: false, error: `No se pudo leer el resultado: ${e.message}` }); }
      cleanup();
      resolve({ ok: true, xml });
    });
  });
}

/**
 * XPath del log System: 41, 6008, 1074 y 1001 SOLO del proveedor del BugCheck real
 * (en el log Application el 1001 es un informe WER de cualquier programa).
 */
function buildSystemQuery(sinceDate) {
  return `*[System[(EventID=41 or EventID=6008 or EventID=1074 or ` +
    `(EventID=1001 and Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'])) ` +
    `and TimeCreated[@SystemTime>='${sinceDate.toISOString()}']]]`;
}

/** Rango del selector → fecha inicial y días hacia atrás. */
function resolveRange(range, now = new Date()) {
  const rangeStr = String(range);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (rangeStr === 'today')     return { rangeStr, daysBack: 1,  sinceDate: startOfToday };
  if (rangeStr === 'yesterday') return { rangeStr, daysBack: 2,  sinceDate: new Date(startOfToday.getTime() - 86400000) };
  if (rangeStr === '30')        return { rangeStr, daysBack: 30, sinceDate: new Date(now.getTime() - 30 * 86400000) };
  return { rangeStr, daysBack: 7, sinceDate: new Date(now.getTime() - 7 * 86400000) };
}

module.exports = {
  decodeXmlEntities, xmlVal, extractXmlData, orderedRawProps, parseSystemEventsXml, calculatePowerStats,
  runWevtutilQuery, buildPsScript, buildSystemQuery, resolveRange, WEVTUTIL_MAX_EVENTS,
};
