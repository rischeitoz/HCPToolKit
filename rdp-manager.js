/**
 * HCPToolKit - Gestor de Conexiones Remotas (RDP)
 * Módulo para parsear, crear, almacenar, probar y lanzar conexiones de Escritorio Remoto (.rdp)
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, exec } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const RDP_FILES_DIR = path.join(DATA_DIR, 'rdp_files');
const RDP_DATA_FILE = path.join(DATA_DIR, 'rdp_connections.json');

// Asegurar directorios de almacenamiento
function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(RDP_FILES_DIR)) {
    fs.mkdirSync(RDP_FILES_DIR, { recursive: true });
  }
}

/**
 * Parsea el contenido en texto plano de un archivo .rdp
 */
function parseRdpContent(content, fileName = '', filePath = '') {
  const lines = (content || '').split(/\r?\n/);
  const settings = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;

    const firstColon = trimmed.indexOf(':');
    if (firstColon === -1) continue;

    const key = trimmed.slice(0, firstColon).trim().toLowerCase();
    const rest = trimmed.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');

    let val = '';
    if (secondColon !== -1) {
      val = rest.slice(secondColon + 1).trim();
    } else {
      val = rest.trim();
    }
    settings[key] = val;
  }

  // Extraer dirección completa y puerto
  let fullAddress = settings['full address'] || '';
  let host = fullAddress;
  let port = 3389;

  if (fullAddress.includes(':')) {
    const parts = fullAddress.split(':');
    host = parts[0].trim();
    const parsedPort = parseInt(parts[1], 10);
    if (!isNaN(parsedPort) && parsedPort > 0) port = parsedPort;
  }

  // Extraer nombre amigable
  let name = fileName ? fileName.replace(/\.rdp$/i, '') : '';
  if (!name && host) name = host;
  if (!name) name = 'Conexión Remota';

  const username = settings['username'] || '';
  const domain = settings['domain'] || '';
  const screenMode = settings['screen mode id'] === '2' ? 'Pantalla Completa' : 'Ventana';
  const useMultimon = settings['use multimon'] === '1';
  const adminSession = settings['administrative session'] === '1';
  const redirectPrinters = settings['redirectprinters'] === '1';
  const redirectClipboard = settings['redirectclipboard'] !== '0';
  const redirectDrives = settings['redirectdrives'] === '1' || settings['drivestoredirect'] === '*';
  const desktopWidth = parseInt(settings['desktopwidth'], 10) || null;
  const desktopHeight = parseInt(settings['desktopheight'], 10) || null;

  return {
    id: 'rdp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
    name,
    fileName: fileName || `${name.replace(/[^a-zA-Z0-9_\-]/g, '_')}.rdp`,
    filePath: filePath || '',
    host,
    port,
    fullAddress: fullAddress || (host ? `${host}:${port}` : ''),
    username,
    domain,
    screenMode,
    useMultimon,
    adminSession,
    redirectPrinters,
    redirectClipboard,
    redirectDrives,
    resolution: desktopWidth && desktopHeight ? `${desktopWidth}x${desktopHeight}` : (screenMode === 'Pantalla Completa' ? 'Nativa' : '1920x1080'),
    rawSettings: settings,
    rawContent: content,
    dateAdded: new Date().toISOString(),
    isFavorite: false,
    group: guessGroup(name, host)
  };
}

/**
 * Deduce un grupo o categoría inicial según el nombre o host
 */
function guessGroup(name = '', host = '') {
  const combined = `${name} ${host}`.toLowerCase();
  if (/cad|bim|revit|autocad|render|3d/i.test(combined)) return 'Puestos CAD & BIM';
  if (/serv|cielo|dc|server|ad|storage|backup|nas/i.test(combined)) return 'Servidores';
  if (/madrid|malaga|sede|oficina|planta/i.test(combined)) return 'Sedes & Plantas';
  return 'General';
}

/**
 * Genera el contenido estándar de un archivo .rdp
 */
function buildRdpContent(options = {}) {
  const {
    host = 'localhost',
    port = 3389,
    username = '',
    domain = '',
    fullScreen = true,
    multiMon = false,
    width = 1920,
    height = 1080,
    adminSession = false,
    redirectClipboard = true,
    redirectPrinters = false,
    redirectDrives = false,
    audioMode = 0 // 0: reproducir aquí, 1: en remoto, 2: no reproducir
  } = options;

  const fullAddress = port && port !== 3389 ? `${host}:${port}` : host;

  const lines = [
    `full address:s:${fullAddress}`,
    `screen mode id:i:${fullScreen ? 2 : 1}`,
    `use multimon:i:${multiMon ? 1 : 0}`,
    `desktopwidth:i:${width}`,
    `desktopheight:i:${height}`,
    `session bpp:i:32`,
    `compression:i:1`,
    `keyboardhook:i:2`,
    `audiocapturemode:i:0`,
    `videoplaybackmode:i:1`,
    `connection type:i:7`,
    `networkautodetect:i:1`,
    `bandwidthautodetect:i:1`,
    `displayconnectionbar:i:1`,
    `enableworkspacereconnect:i:0`,
    `disable wallpaper:i:0`,
    `allow font smoothing:i:1`,
    `allow desktop composition:i:1`,
    `disable full window drag:i:1`,
    `disable menu anims:i:1`,
    `disable themes:i:0`,
    `bitmapcachepersistenable:i:1`,
    `audiomode:i:${audioMode}`,
    `redirectprinters:i:${redirectPrinters ? 1 : 0}`,
    `redirectcomports:i:0`,
    `redirectsmartcards:i:1`,
    `redirectclipboard:i:${redirectClipboard ? 1 : 0}`,
    `redirectposdevices:i:0`,
    `redirectdrives:i:${redirectDrives ? 1 : 0}`,
    `autoreconnection enabled:i:1`,
    `authentication level:i:2`,
    `prompt for credentials:i:0`,
    `negotiate security layer:i:1`,
    `remoteapplicationmode:i:0`,
    `administrative session:i:${adminSession ? 1 : 0}`
  ];

  if (username) lines.push(`username:s:${username}`);
  if (domain) lines.push(`domain:s:${domain}`);

  return lines.join('\r\n') + '\r\n';
}

/**
 * Carga la lista persistente de conexiones RDP guardadas
 */
function loadConnections() {
  ensureDirectories();
  try {
    if (fs.existsSync(RDP_DATA_FILE)) {
      const data = fs.readFileSync(RDP_DATA_FILE, 'utf8');
      const list = JSON.parse(data);
      if (Array.isArray(list)) {
        return list;
      }
    }
  } catch (err) {
    console.error('[RDP-Manager] Error al leer rdp_connections.json:', err.message);
  }
  return [];
}

/**
 * Guarda la lista de conexiones RDP
 */
function saveConnections(connections) {
  ensureDirectories();
  try {
    fs.writeFileSync(RDP_DATA_FILE, JSON.stringify(connections, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[RDP-Manager] Error al guardar rdp_connections.json:', err.message);
    return false;
  }
}

/**
 * Añade una o varias conexiones a la lista persistente
 */
function addConnections(newItems) {
  const current = loadConnections();
  const items = Array.isArray(newItems) ? newItems : [newItems];

  for (const item of items) {
    // Si ya existe por filePath o id, actualizarlo
    const index = current.findIndex(c => c.id === item.id || (item.filePath && c.filePath === item.filePath));
    if (index >= 0) {
      current[index] = { ...current[index], ...item };
    } else {
      current.push(item);
    }
  }

  saveConnections(current);
  return current;
}

/**
 * Elimina una conexión por su ID
 */
function deleteConnection(id) {
  const current = loadConnections();
  const filtered = current.filter(c => c.id !== id);
  saveConnections(filtered);
  return filtered;
}

/**
 * Actualiza una conexión existente (favorito, nombre, grupo, notas)
 */
function updateConnection(id, updates) {
  const current = loadConnections();
  const item = current.find(c => c.id === id);
  if (item) {
    Object.assign(item, updates);
    saveConnections(current);
    return item;
  }
  return null;
}

/**
 * Comprueba la conectividad TCP al puerto RDP (por defecto 3389)
 */
function testRdpHost(host, port = 3389, timeout = 2500) {
  return new Promise((resolve) => {
    if (!host) {
      return resolve({ online: false, latencyMs: null, message: 'Dirección de host no especificada' });
    }

    const start = Date.now();
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      if (!isResolved) {
        isResolved = true;
        resolve({
          online: true,
          latencyMs,
          port,
          host,
          message: `Puerto ${port} respondiendo en ${latencyMs} ms`
        });
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      if (!isResolved) {
        isResolved = true;
        resolve({
          online: false,
          latencyMs: null,
          port,
          host,
          message: `Tiempo de espera agotado (${timeout} ms)`
        });
      }
    });

    socket.on('error', (err) => {
      socket.destroy();
      if (!isResolved) {
        isResolved = true;
        const msg = err.code === 'ECONNREFUSED' 
          ? `Host alcanzado pero puerto ${port} cerrado (rechazado)`
          : (err.message || 'Error de conexión');
        resolve({
          online: false,
          latencyMs: null,
          port,
          host,
          message: msg,
          code: err.code
        });
      }
    });

    try {
      socket.connect(port, host);
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        resolve({
          online: false,
          latencyMs: null,
          port,
          host,
          message: e.message
        });
      }
    }
  });
}

/**
 * Lanza la conexión RDP en Windows mediante mstsc.exe
 */
function launchRdpConnection(options = {}) {
  const { filePath, host, port = 3389, adminMode = false, editMode = false } = options;

  return new Promise((resolve, reject) => {
    // Si estamos en Windows
    if (process.platform === 'win32') {
      let cmd = 'start "" mstsc.exe';

      if (editMode && filePath) {
        cmd = `start "" mstsc.exe /edit "${filePath}"`;
      } else if (filePath && fs.existsSync(filePath)) {
        cmd = `start "" mstsc.exe ${adminMode ? '/admin ' : ''}"${filePath}"`;
      } else if (host) {
        const full = port && port !== 3389 ? `${host}:${port}` : host;
        cmd = `start "" mstsc.exe /v:${full} ${adminMode ? '/admin' : ''}`;
      } else {
        return reject(new Error('No se especificó archivo .rdp ni dirección de host válida.'));
      }

      exec(cmd, { windowsHide: false }, (err) => {
        if (err) {
          return reject(err);
        }
        resolve({
          success: true,
          command: cmd,
          message: editMode ? 'Abriendo editor de conexión en Windows...' : 'Iniciando conexión de Escritorio Remoto...'
        });
      });
    } else {
      // En entorno no-Windows (ej. Linux/Mac o contenedor de desarrollo)
      resolve({
        success: true,
        command: `mstsc.exe ${filePath ? `"${filePath}"` : `/v:${host}`}`,
        isSimulated: true,
        message: `Comando RDP preparado: mstsc.exe ${filePath ? `"${path.basename(filePath)}"` : `/v:${host}`}`
      });
    }
  });
}

module.exports = {
  DATA_DIR,
  RDP_FILES_DIR,
  RDP_DATA_FILE,
  parseRdpContent,
  buildRdpContent,
  loadConnections,
  saveConnections,
  addConnections,
  deleteConnection,
  updateConnection,
  testRdpHost,
  launchRdpConnection
};
