> **Exportador PDF de "Información del Equipo"**: se mantiene exactamente como en el proyecto original (misma estructura, textos y colores del documento generado).

## Visor de eventos · correcciones de la recogida de datos

- **Sin UAC innecesario**: el log System se lee directamente con `wevtutil` (UTF-8 vía `chcp 65001`). Solo si Windows
  deniega el acceso se reintenta con elevación, y ahora se distingue "UAC cancelado" de "consulta lenta"
  (antes un UAC cancelado o tardío (>25 s) mostraba un informe vacío sin avisar).
- **Errores visibles**: si la consulta falla se muestra el motivo en pantalla (`queryError`) en vez de un informe vacío.
- **BSOD reales**: el evento 1001 se limita al proveedor `Microsoft-Windows-WER-SystemErrorReporting`; ya no se
  cuentan los informes WER del log Application como pantallazos azules.
- **Evento 1074**: corregido el orden real de los campos (proceso, equipo, motivo, código, tipo de cierre, comentario,
  usuario); antes el usuario, el motivo y si era reinicio/apagado salían descolocados.
- **Evento 41**: el código BugCheck en hexadecimal ya no se leía como 0.
- **XML**: los campos `<Data/>` vacíos ya no desplazan al resto y se decodifican las entidades (`&amp;`, etc.).
- **Rangos y límites**: "Ayer y Hoy" / "Hoy" / 7 / 30 días con límite de 1000 eventos (antes 200) y `daysBack`
  devuelto al informe exportado (antes mostraba "undefined días").
- El código común está en `event-parser.js` (Electron y modo web comparten parseo y consulta).

---

# HCPToolKit · Rediseño "Consola"

Esta versión mantiene **todas las utilidades y el backend originales** (main.js, server.js, rdp-manager.js,
system-event-log.js, preload.js) y rehace por completo la interfaz:

- **Layout v2**: barra superior con pestañas por módulo (Panel, PC, Mantenimiento, Red, Reparación, Canon, Plotter, Guías, Remoto), buscador global (`Ctrl + K`), escenario a ancho completo y panel derecho "Equipo" plegable (host, usuario, SO, uptime y auditoría rápida; `renderer/shell.js`).
- **Panel principal v3**: accesos agrupados por tarea (Diagnosticar / Reparar y mantener / Rendimiento y red) en paneles con filas, y servicios en mosaico (Canon destacada, Plotter, Guías, RDP en banda ancha).
- **Nueva paleta** teal + índigo (tema claro y oscuro) en lugar de lima/rosa/azul, con tokens en `renderer/theme.css`.
- **Nuevo splash** de arranque y componentes del panel (hero, accesos rápidos, tarjetas) con otro lenguaje de formas.
- Rejillas fluidas (sin desbordamiento horizontal) y un único scroll en el escenario.
- `renderer/index.html` y `renderer/theme.css` son los archivos nuevos; `styles.css` conserva los estilos
  interiores de cada utilidad con la paleta remapeada.

Arranque: `npm install` y después `npm start` (Electron) o `npm run start:web` (navegador, http://localhost:3000).

---

# HCPToolKit - Diagnóstico y Mantenimiento (Electron)

Aplicación de escritorio para el departamento de IT, compilada como `.exe` de
Windows portable (un único archivo, sin instalación).

## Utilidades incluidas

1. Test de Velocidad (descarga/subida/ping propios).
2. Diagnóstico del PC (RAM, CPU, GPU, disco).
3. Activar Alto Rendimiento (plan de energía).
4. Ejecutar SFC /SCANNOW.
5. Reparar Windows (DISM).
6. Actualizar Drivers de la GPU.
7. **Analizar Visor de Eventos**: consulta automática del registro de
   eventos de Windows (log System) buscando apagados inesperados, BugCheck,
   errores WHEA (hardware), errores de disco/NTFS y errores de servicios.
   Genera un informe con interpretación en lenguaje sencillo, recomendaciones
   automáticas, tabla ordenable de los últimos 20 eventos críticos, y
   exportación a PDF, HTML o TXT.
8. **Evaluar Estado del Equipo** (nueva): agrega los datos de Diagnóstico del
   PC, Visor de Eventos, drivers de GPU y (si se han ejecutado en la misma
   sesión) SFC/DISM, y calcula una puntuación global de 1 a 10 por categoría
   (CPU, RAM, GPU, Disco, Drivers, Sistema, Eventos críticos, Rendimiento),
   con clasificación visual (Excelente/Bueno/Aceptable/Deficiente/Crítico),
   barra de "índice de salud" con color, resumen ejecutivo en lenguaje natural
   y recomendaciones priorizadas (alta/media/baja). Exportable a PDF/HTML/TXT.

## Cómo volver a compilar el .exe con el icono oficial HCP+

```bash
npm install
npm run build     # Genera y valida logo.ico y build/icon.ico con 7 resoluciones nativas
npm run dist      # Empaqueta HCPToolKit.exe asegurando la incrustación del icono oficial
```

El script de empaquetado (`scripts/build-package.js`) valida automáticamente la presencia e integridad binaria de `build/icon.ico` y `logo.ico` antes de invocar `electron-builder`, garantizando que el ejecutable portable final (`dist/HCPToolKit.exe`) y el instalador incorporen el icono oficial de HCP+ en lugar del icono predeterminado del framework.

## Eliminación completa de PowerShell

A petición del usuario, **ninguna utilidad del proyecto utiliza PowerShell**. 

- Toda consulta del sistema se realiza vía **CMD, WMIC, REG, SC, `wevtutil` o APIs nativas de Node.js**.
- La ejecución con permisos elevados (UAC) para SFC, DISM, Diagnóstico de Memoria (`mdsched.exe`) y reinicio de servicios se realiza mediante el método nativo `ShellExecute "runas"` ejecutado con `cscript` (VBScript) sobre consola CMD. Esto garantiza compatibilidad universal sin requerir permisos de ejecución de PowerShell.

## Notas técnicas sobre la Utilidad 8

- **No relanza SFC ni DISM automáticamente** (son operaciones de varios
  minutos que requieren UAC); reutiliza el resultado si el técnico ya las
  ejecutó en la misma sesión de la aplicación. Si no se han ejecutado, la
  categoría "Sistema" recibe una puntuación neutra (7/10) con una nota
  explicándolo, en vez de penalizar o inventar un resultado.
- Cada categoría se puntúa de forma independiente con umbrales explícitos
  (documentados en el código, `renderer.js`, funciones `score*`) y la
  puntuación global es la media simple de las 8 categorías.
- El resumen ejecutivo y las recomendaciones se generan dinámicamente a
  partir de los datos reales detectados (no son texto fijo): solo mencionan
  RAM alta, disco lleno, apagados inesperados, GPU caliente o driver
  desactualizado si esos problemas existen de verdad en el equipo analizado.

## Notas técnicas sobre la Utilidad 7

- Se consulta el log **System** de Windows vía `wevtutil.exe` (CMD nativo de Windows),
  filtrando por los IDs de evento asociados a: Kernel-Power (41, 6008),
  reinicios/apagados normales (1074, 6005, 6006), BugCheck (1001),
  WHEA-Logger (17,18,19,47), errores de disco/NTFS (7,11,51,153,55) y
  Service Control Manager (7000,7001,7009,7011,7016,7026,7031,7034).
- El "motivo del reinicio" y el "usuario que lo inició" se obtienen
  analizando el evento 1074, cuyo mensaje varía según el idioma de Windows;
  el parseo del usuario es un best-effort (busca "Usuario:" o "User:" en el
  texto) y puede no encontrarlo en todos los idiomas/versiones de Windows.
- El "tiempo encendido antes del reinicio" se calcula como la diferencia
  entre el evento de apagado/reinicio anterior y el evento de arranque (6005)
  previo a ese apagado. Si no se encuentran ambos eventos en el rango de
  fechas analizado, se muestra "Desconocido".
- Por defecto se analizan los últimos 30 días; el técnico puede cambiar el
  rango (7/15/30/60/90 días) con el selector que aparece en el propio informe.
- La exportación a PDF utiliza una ventana oculta de Chromium
  (`webContents.printToPDF`), ya incluida en Electron, sin dependencias
  adicionales.

## Estructura del proyecto

```
ITToolkitElectron/
├── package.json          (config de electron-builder)
├── main.js                (proceso principal: toda la lógica de sistema)
├── preload.js              (puente seguro hacia el renderer)
├── build/icon.ico
└── renderer/
    ├── index.html
    ├── styles.css
    └── renderer.js         (interfaz y lógica de las 7 utilidades)
```

## Limitaciones conocidas (heredadas de la versión anterior)

- El test de velocidad mide contra servidores públicos estándar (Cloudflare),
  no hace scraping de la web de Movistar (frágil y sin API pública). Se añade
  un botón para abrir esa web como referencia.
- La temperatura de GPU solo se obtiene de forma fiable para NVIDIA (vía
  `nvidia-smi`). Para AMD/Intel se informa honestamente que no se pudo
  obtener, tal como pedía la especificación original.
- La "última versión disponible" del driver de GPU no se compara
  automáticamente (no hay catálogo público fiable sin scraping de terceros);
  se usa la fecha del driver instalado como heurística y se enlaza siempre a
  la página oficial del fabricante.

## Rediseño de herramientas (v6)
Todas las herramientas y tarjetas tienen nueva interfaz (cabecera con "← Volver", paneles tipo instrumento, rejillas adaptables). "Información del Equipo" (auditar PC) y su exportador PDF se mantienen exactamente como el original (`tools.css` no la afecta: usa la clase `classic-view`).

## Stress Test de hardware (v7) — Mantenimiento → Stress Test de Hardware
- **CPU real:** `stress-engine.js` lanza `worker_threads` con matrices, enteros, coma flotante y memoria; cada iteración se verifica contra un resultado de referencia (un fallo = error de cálculo real). Hilos, intensidad y duración configurables.
- **GPU real:** render WebGL2 con shader fractal sobre la GPU física (checksum de un mosaico cada segundo para detectar artefactos, detección de pérdida de contexto/TDR y bloqueos). Si el navegador usa render por software, la prueba de GPU se rechaza.
- **Telemetría:** utilización (`os.cpus`), frecuencia y temperatura (contadores de Windows / sysfs) y GPU (`nvidia-smi`). Sin sensor → N/D, nunca valores inventados.
- **Persistencia y recuperación:** la sesión se guarda en disco cada segundo (`userData/stress-test` o `data/stress`). Si el equipo se reinicia, al abrir la app se compara el instante de arranque y se consulta el visor de eventos (41, 6008, 1001, 1074): solo se confirma un reinicio/BSOD con evidencia; un cierre de la app no cuenta como reinicio.
- **Seguridad:** límites térmicos configurables con parada automática, parada de emergencia, prioridad reducida; no toca voltajes, BIOS ni frecuencias.
- **Informe:** APROBADO / ADVERTENCIA / FALLIDO / INTERRUMPIDO, con gráficas, exportable a PDF y JSON; historial de informes.

## Visor de eventos (v8)
Lectura del registro con PowerShell Get-WinEvent (XML en UTF-8 a fichero) en lugar de wevtutil+chcp, que corrompía tildes; las rutas largas se parten dentro de las tarjetas.
