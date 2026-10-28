/* ============================================================
   app.js - URL Slideshow
   Toda la lógica: editor, reproductor, codificación, local storage
   ============================================================ */

// --- Estado global ---
let editorState = {
    items: [],          // { url, type }
    name: 'Mi presentación',
    duration: 5,
    fit: 'contain-blur',
    transition: 'fade',
    loop: true
};

let playerState = {
    config: null,       // objeto de configuración decodificado
    currentIndex: 0,
    isPlaying: false,
    timer: null,
    isTransitioning: false,
    layers: ['a', 'b'], // ['a','b'] o ['b','a'] según el activo
    activeLayer: 'a',   // capa actualmente visible
    hiddenLayer: 'b',
    captureRefreshTimer: null,
    captureCountdownTimer: null,
    nextCaptureCheckAt: null,
    lastCaptureCheckAt: null,
    captureRefreshInProgress: false
};

// --- DOM references ---
const $ = id => document.getElementById(id);
const editor = $('editor');
const player = $('player');
const layerA = $('slide-layer-a');
const layerB = $('slide-layer-b');
const controls = $('player-controls');
const playPauseBtn = $('play-pause-btn');
const prevBtn = $('prev-btn');
const nextBtn = $('next-btn');
const fullscreenBtn = $('fullscreen-btn');
const exitBtn = $('exit-btn');
const slideCounter = $('slide-counter');
const playerMessage = $('player-message');
const captureRefreshStatus = $('capture-refresh-status');
const captureRefreshTimerText = $('capture-refresh-timer');
const captureRefreshDetail = $('capture-refresh-detail');

// --- Utilidades ---
function detectType(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return 'invalid'; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'invalid';

    // Solo los archivos multimedia directos evitan la conversión a captura.
    // También los enlaces de Canva, Power BI y Looker Studio deben pasar por captura
    // cuando se agregan nuevos medios; los embeds guardados anteriormente siguen funcionando.
    const ext = parsed.pathname.split('.').pop()?.toLowerCase() || '';
    const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'svg'];
    const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'm4v'];
    if (imageExts.includes(ext)) return 'image';
    if (videoExts.includes(ext)) return 'video';

    // Todo otro enlace se inspecciona al agregarlo: imagen directa o captura web.
    return 'web';
}

// Convierte enlaces compartidos en URLs aptas para iframe cuando el proveedor lo permite.
// Los enlaces privados siguen necesitando que el espectador tenga permisos y sesión.
function getEmbedUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) { return rawUrl; }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'canva.com' || host.endsWith('.canva.com')) {
        parsed.searchParams.set('embed', '1');
        return parsed.toString();
    }
    if (host === 'datastudio.google.com' || host === 'lookerstudio.google.com') {
        const match = parsed.pathname.match(/^\/(?:embed\/)?reporting\/([^/]+)(\/page\/[^/?]+)?/i);
        if (match) {
            parsed.hostname = 'lookerstudio.google.com';
            parsed.pathname = '/embed/reporting/' + match[1] + (match[2] || '');
            return parsed.toString();
        }
        return rawUrl;
    }
    if (host === 'app.powerbi.com' || host.endsWith('.powerbi.com')) {
        // Los enlaces "view" públicos y "reportEmbed" son compatibles con iframe.
        if (parsed.pathname.startsWith('/view') || parsed.pathname.includes('/reportEmbed')) return rawUrl;
        // Para otros enlaces de Power BI, no inventamos parámetros de autenticación:
        // el usuario debe pegar el enlace "Insertar informe" proporcionado por Power BI.
        return rawUrl;
    }
    return rawUrl;
}

// Añade una versión al mostrar capturas generadas automáticamente para evitar caché antigua.
function getImageUrlForDisplay(rawUrl) {
    try {
        const parsed = new URL(rawUrl, window.location.href);
        if (/\/captures\/report-\d+\.png$/i.test(parsed.pathname)) {
            parsed.searchParams.set('v', Date.now().toString());
            return parsed.toString();
        }
    } catch (_) {}
    return rawUrl;
}

// Comprueba si el enlace sirve una imagen real, incluso si no tiene extensión.
function probeImage(url, timeoutMs = 8000) {
    return new Promise(resolve => {
        const img = new Image();
        let finished = false;
        const finish = result => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            img.onload = null;
            img.onerror = null;
            if (!result) img.src = 'data:,';
            resolve(result);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        img.onload = () => finish(img.naturalWidth > 0);
        img.onerror = () => finish(false);
        img.src = url;
    });
}

// Devuelve dos vías de captura: imagen de pantalla completa y, como respaldo,
// una vista previa más ligera. No se envía timeout=60000 porque podía provocar
// esperas largas en páginas con muchas conexiones persistentes (p. ej. GitHub).
function captureWebpageCandidates(url) {
    // Parámetros documentados para GET /v1/screenshot.
    const screenshotUrl = new URL('https://pageshot.site/v1/screenshot');
    screenshotUrl.searchParams.set('url', url);
    screenshotUrl.searchParams.set('width', '1920');
    screenshotUrl.searchParams.set('height', '1080');
    screenshotUrl.searchParams.set('format', 'png');
    screenshotUrl.searchParams.set('full_page', 'false');
    screenshotUrl.searchParams.set('wait_until', 'domcontentloaded');
    screenshotUrl.searchParams.set('timeout', '20000');
    screenshotUrl.searchParams.set('delay', '500');
    screenshotUrl.searchParams.set('block_ads', 'true');
    screenshotUrl.searchParams.set('hide_banners', 'true');

    // Vista previa optimizada de PageShot como segundo intento.
    const previewUrl = new URL('https://pageshot.site/v1/preview');
    previewUrl.searchParams.set('url', url);
    previewUrl.searchParams.set('width', '800');
    previewUrl.searchParams.set('dark_mode', 'false');

    // Tercer proveedor independiente. Su plan gratuito tiene límite de uso;
    // se usa únicamente como respaldo si PageShot no entrega una imagen.
    const thumUrl = 'https://image.thum.io/get/width/1200/crop/900/noanimate/' + url;

    return [
        { url: screenshotUrl.toString(), timeoutMs: 18000, label: 'captura HD (PageShot)' },
        { url: previewUrl.toString(), timeoutMs: 13000, label: 'vista previa (PageShot)' },
        { url: thumUrl, timeoutMs: 18000, label: 'respaldo (Thum.io)' }
    ];
}

// Espera a que una captura dinámica haya terminado de cargarse.
function waitForCapturedImage(layerElement, timeoutMs = 65000) {
    const image = layerElement.querySelector('img.main-media');
    if (!image) return Promise.resolve(true);
    if (image.complete) return Promise.resolve(image.naturalWidth > 0);

    return new Promise(resolve => {
        let finished = false;
        const finish = loaded => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            image.removeEventListener('load', onLoad);
            image.removeEventListener('error', onError);
            resolve(loaded);
        };
        const onLoad = () => finish(image.naturalWidth > 0);
        const onError = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        image.addEventListener('load', onLoad, { once: true });
        image.addEventListener('error', onError, { once: true });
        // Evita una carrera si la imagen terminó de cargar justo al añadir eventos.
        if (image.complete) finish(image.naturalWidth > 0);
    });
}

// Las capturas locales se regeneran en GitHub Actions cada ~10 min.
 // Slides vuelve a solicitar la imagen actual cada minuto y muestra una cuenta regresiva visible.
const CAPTURE_RELOAD_INTERVAL_MS = 60 * 1000;

function isScheduledCapture(item) {
    if (!item || !item.url) return false;
    try {
        const parsed = new URL(item.url, window.location.href);
        return parsed.origin === window.location.origin &&
            /\/captures\/report-\d+\.png$/i.test(parsed.pathname);
    } catch (_) {
        return false;
    }
}

function formatCountdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return String(minutes).padStart(2, '0') + ':' + String(remainder).padStart(2, '0');
}

function formatClock(timestamp) {
    if (!timestamp) return '--:--:--';
    return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
}

function updateCaptureRefreshStatus() {
    if (!captureRefreshStatus || !playerState.config) return;
    const hasScheduledCaptures = playerState.config.items.some(isScheduledCapture);
    captureRefreshStatus.style.display = hasScheduledCaptures ? 'flex' : 'none';
    if (!hasScheduledCaptures) return;

    const remaining = Math.max(0, (playerState.nextCaptureCheckAt || Date.now()) - Date.now());
    captureRefreshTimerText.textContent = 'Próxima recarga: ' + formatCountdown(remaining);
    captureRefreshDetail.textContent = playerState.lastCaptureCheckAt
        ? 'Última comprobación ' + formatClock(playerState.lastCaptureCheckAt) + ' · fuente cada ~10 min'
        : 'La fuente se renueva aproximadamente cada 10 min';
}

function stopCaptureRefreshMonitoring() {
    if (playerState.captureRefreshTimer) {
        clearInterval(playerState.captureRefreshTimer);
        playerState.captureRefreshTimer = null;
    }
    if (playerState.captureCountdownTimer) {
        clearInterval(playerState.captureCountdownTimer);
        playerState.captureCountdownTimer = null;
    }
    playerState.nextCaptureCheckAt = null;
    playerState.lastCaptureCheckAt = null;
    playerState.captureRefreshInProgress = false;
    if (captureRefreshStatus) captureRefreshStatus.style.display = 'none';
}

function refreshVisibleScheduledCapture() {
    const config = playerState.config;
    if (!config || playerState.captureRefreshInProgress) return;

    playerState.captureRefreshInProgress = true;
    playerState.nextCaptureCheckAt = Date.now() + CAPTURE_RELOAD_INTERVAL_MS;
    updateCaptureRefreshStatus();

    const item = config.items[playerState.currentIndex];
    const activeLayer = playerState.activeLayer === 'a' ? layerA : layerB;
    const currentImage = activeLayer.querySelector('img.main-media');
    const finish = () => {
        playerState.lastCaptureCheckAt = Date.now();
        playerState.captureRefreshInProgress = false;
        updateCaptureRefreshStatus();
    };

    if (!isScheduledCapture(item) || !currentImage) {
        finish();
        return;
    }

    // Pre-cargar la versión sin caché y cambiar la imagen visible solo cuando esté lista.
    const freshUrl = getImageUrlForDisplay(item.url);
    const preloader = new Image();
    let finished = false;
    const finishLoad = loaded => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        preloader.onload = null;
        preloader.onerror = null;

        if (loaded &&
            playerState.config === config &&
            config.items[playerState.currentIndex] === item &&
            currentImage.isConnected) {
            currentImage.src = freshUrl;
        }
        finish();
    };
    const timeout = setTimeout(() => finishLoad(false), 20000);
    preloader.onload = () => finishLoad(preloader.naturalWidth > 0);
    preloader.onerror = () => finishLoad(false);
    preloader.src = freshUrl;
}

function startCaptureRefreshMonitoring() {
    stopCaptureRefreshMonitoring();
    const hasScheduledCaptures = playerState.config?.items?.some(isScheduledCapture);
    if (!hasScheduledCaptures) return;

    playerState.nextCaptureCheckAt = Date.now() + CAPTURE_RELOAD_INTERVAL_MS;
    updateCaptureRefreshStatus();
    playerState.captureCountdownTimer = setInterval(updateCaptureRefreshStatus, 1000);
    playerState.captureRefreshTimer = setInterval(
        refreshVisibleScheduledCapture,
        CAPTURE_RELOAD_INTERVAL_MS
    );
}

// --- Configuración comprimida para enlaces cortos ---
// Los enlaces antiguos en Base64 siguen siendo compatibles.
function encodeConfig(config) {
    const json = JSON.stringify(config);
    if (window.LZString) {
        return 'z1.' + LZString.compressToEncodedURIComponent(json);
    }
    // Respaldo compatible si la librería de compresión no carga.
    return 'b1.' + btoa(unescape(encodeURIComponent(json)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function decodeConfig(encoded) {
    try {
        if (encoded.startsWith('z1.')) {
            if (!window.LZString) return null;
            const json = LZString.decompressFromEncodedURIComponent(encoded.slice(3));
            return json ? JSON.parse(json) : null;
        }
        if (encoded.startsWith('b1.')) encoded = encoded.slice(3);
        // Formato anterior: Base64 URL-safe sin prefijo.
        let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        const json = decodeURIComponent(escape(atob(base64)));
        return JSON.parse(json);
    } catch (e) {
        return null;
    }
}

// Reutiliza capturas locales que ya genera GitHub Actions cada 10 minutos.
// Esto evita depender de un segundo servicio remoto para informes conocidos de Looker.
function getKnownDashboardCapture(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.toLowerCase();
        const knownPowerBI = {
            // Public Power BI report URL supplied by the user (the r token identifies it).
            'eyJrIjoiY2RmNWJiMGMtYjRkYi00MWI3LWI1OTYtMWFjZDdhNzQzZGFkIiwidCI6IjdlYWIxY2VkLWNkZTUtNDZjYS04NDQwLWRkM2M1ZTU3ZjdhZiIsImMiOjR9': 'report-3.png'
        };
        if (host === 'app.powerbi.com' && parsed.pathname.toLowerCase() === '/view') {
            const powerBiFile = knownPowerBI[parsed.searchParams.get('r') || ''];
            if (powerBiFile) {
                return new URL('captures/' + powerBiFile, window.location.href.split('#')[0]).toString();
            }
        }

        const match = parsed.pathname.match(/\/(?:embed\/)?reporting\/([^/]+)/i);
        if (!match) return null;
        const reportId = match[1].toLowerCase();
        const knownLooker = {
            '53a75d46-1e56-4252-b957-67d57077bde2': 'report-1.png',
            'd48a4893-4559-4a61-945c-5e91c5d1f90f': 'report-2.png'
        };
        const file = knownLooker[reportId];
        return file ? new URL('captures/' + file, window.location.href.split('#')[0]).toString() : null;
    } catch (_) {
        return null;
    }
}

// --- Editor: agregar medio ---
async function addMediaItem(url) {
    url = url.trim();
    if (!url) return false;

    let parsed;
    try { parsed = new URL(url); } catch (_) { return false; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const canonicalUrl = parsed.toString();
    const detectedType = detectType(canonicalUrl);
    let item;

    const knownCaptureUrl = getKnownDashboardCapture(canonicalUrl);
    if (knownCaptureUrl) {
        // Captura propia ya generada por GitHub Actions; no hace falta una API externa.
        item = {
            url: knownCaptureUrl,
            type: 'image',
            sourceUrl: canonicalUrl,
            capture: true
        };
    } else if (detectedType === 'image' || detectedType === 'video' || detectedType === 'embed') {
        item = { url: canonicalUrl, type: detectedType };
    } else {
        const button = $('add-media-btn');
        const originalLabel = button.textContent;
        button.disabled = true;
        try {
            button.textContent = 'Detectando medio...';
            if (await probeImage(canonicalUrl)) {
                item = { url: canonicalUrl, type: 'image' };
            } else {
                const captureCandidates = captureWebpageCandidates(canonicalUrl);
                let screenshotUrl = null;
                const failedServices = [];
                for (const candidate of captureCandidates) {
                    button.textContent = 'Probando ' + candidate.label + '…';
                    if (await probeImage(candidate.url, candidate.timeoutMs)) {
                        screenshotUrl = candidate.url;
                        break;
                    }
                    failedServices.push(candidate.label);
                }
                if (!screenshotUrl) {
                    throw new Error(
                        'Ninguno de los servicios devolvió una imagen válida (' + failedServices.join(', ') + '). ' +
                        'Puede ser una caída temporal del proveedor o un bloqueo de la página. Prueba de nuevo en unos minutos.'
                    );
                }
                item = {
                    url: screenshotUrl,
                    type: 'image',
                    sourceUrl: canonicalUrl,
                    capture: true
                };
            }
        } finally {
            button.disabled = false;
            button.textContent = originalLabel;
        }
    }

    editorState.items.push(item);
    renderMediaList();
    return true;
}

function removeMediaItem(index) {
    editorState.items.splice(index, 1);
    renderMediaList();
}

function moveMediaItem(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= editorState.items.length) return;
    const [item] = editorState.items.splice(index, 1);
    editorState.items.splice(newIndex, 0, item);
    renderMediaList();
}

function renderMediaList() {
    const list = $('media-list');
    if (editorState.items.length === 0) {
        list.innerHTML = '<p class="empty-message">No hay medios. Agrega una URL.</p>';
        return;
    }
    list.innerHTML = '';
    editorState.items.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'media-item';
        // Thumbnail
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        if (item.type === 'image') {
            const img = document.createElement('img');
            img.src = item.url;
            img.alt = 'thumb';
            img.onerror = () => { img.style.display = 'none'; };
            thumb.appendChild(img);
        } else if (item.type === 'embed' || detectType(item.url) === 'embed') {
            thumb.textContent = '📊';
            thumb.title = 'Presentación o dashboard integrado';
        } else {
            thumb.textContent = '🎬';
        }
        // Info
        const info = document.createElement('div');
        info.className = 'info';
        const urlText = document.createElement('div');
        urlText.className = 'url';
        urlText.textContent = item.sourceUrl || item.url;
        const typeLabel = document.createElement('span');
        typeLabel.className = 'type';
        typeLabel.textContent = item.capture ? 'Captura web' : item.type;
        info.append(urlText, typeLabel);
        // Acciones
        const actions = document.createElement('div');
        actions.className = 'actions';
        actions.innerHTML = `
            <button title="Subir" data-action="up">↑</button>
            <button title="Bajar" data-action="down">↓</button>
            <button class="danger" title="Eliminar" data-action="remove">✕</button>
        `;
        actions.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (action === 'remove') removeMediaItem(idx);
                else if (action === 'up') moveMediaItem(idx, -1);
                else if (action === 'down') moveMediaItem(idx, 1);
            });
        });
        div.appendChild(thumb);
        div.appendChild(info);
        div.appendChild(actions);
        list.appendChild(div);
    });
}

// --- Editor: guardar configuración actual ---
function getCurrentConfig() {
    const name = $('presentation-name').value.trim() || 'Sin nombre';
    const duration = parseFloat($('slide-duration').value) || 5;
    const fit = $('fit-mode').value;
    const transition = $('transition-mode').value;
    const transitionDuration = Math.min(1500, Math.max(150, parseInt($('transition-duration').value, 10) || 600));
    const transitionDirection = $('transition-direction').value;
    const transitionEasing = $('transition-easing').value;
    const loop = $('loop-mode').checked;
    return {
        name,
        duration,
        fit,
        transition,
        transitionDuration,
        transitionDirection,
        transitionEasing,
        loop,
        items: editorState.items.slice() // copia
    };
}

function loadConfigToEditor(config) {
    if (!config) return;
    $('presentation-name').value = config.name || 'Mi presentación';
    $('slide-duration').value = config.duration || 5;
    $('fit-mode').value = config.fit || 'contain-blur';
    $('transition-mode').value = config.transition || 'fade';
    $('transition-duration').value = config.transitionDuration || 600;
    $('transition-direction').value = config.transitionDirection || 'left';
    $('transition-easing').value = config.transitionEasing || 'ease';
    $('loop-mode').checked = config.loop !== undefined ? config.loop : true;
    editorState.items = (config.items || []).slice();
    renderMediaList();
}

// --- Guardar en localStorage ---
function saveToLocalStorage() {
    const config = getCurrentConfig();
    if (config.items.length === 0) {
        alert('Agrega al menos un medio antes de guardar.');
        return null;
    }
    const saves = JSON.parse(localStorage.getItem('urlSlideshow_saves') || '[]');
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
    const entry = {
        id,
        name: config.name,
        date: new Date().toISOString(),
        count: config.items.length,
        config: config
    };
    saves.unshift(entry);
    localStorage.setItem('urlSlideshow_saves', JSON.stringify(saves));
    renderLocalSaves();
    return config;
}

function renderLocalSaves() {
    const container = $('local-saves-list');
    const saves = JSON.parse(localStorage.getItem('urlSlideshow_saves') || '[]');
    if (saves.length === 0) {
        container.innerHTML = '<p class="empty-message">No hay presentaciones guardadas localmente.</p>';
        return;
    }
    container.innerHTML = '';
    saves.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'save-item';
        div.innerHTML = `
            <span class="name">${entry.name}</span>
            <span class="meta">${entry.count} elementos · ${new Date(entry.date).toLocaleDateString()}</span>
            <div class="actions">
                <button class="primary" data-action="play">▶ Reproducir</button>
                <button data-action="edit">✏️ Editar</button>
                <button data-action="copy">📋 Copiar URL</button>
                <button class="danger" data-action="delete">🗑 Eliminar</button>
            </div>
        `;
        div.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (action === 'play') {
                    // Reproducir directamente desde el guardado
                    const config = entry.config;
                    if (config && config.items.length) {
                        startPlayer(config);
                    } else {
                        alert('Configuración inválida.');
                    }
                } else if (action === 'edit') {
                    loadConfigToEditor(entry.config);
                } else if (action === 'copy') {
                    copyUrlFromConfig(entry.config);
                } else if (action === 'delete') {
                    if (confirm(`¿Eliminar "${entry.name}"?`)) {
                        const saves2 = JSON.parse(localStorage.getItem('urlSlideshow_saves') || '[]');
                        const filtered = saves2.filter(s => s.id !== entry.id);
                        localStorage.setItem('urlSlideshow_saves', JSON.stringify(filtered));
                        renderLocalSaves();
                    }
                }
            });
        });
        container.appendChild(div);
    });
}

// --- Acortar URL automáticamente sin cuenta ni configuración ---
function shortenUrlAutomatically(longUrl) {
    return new Promise((resolve, reject) => {
        const callbackName = '__urlSlideshowShort_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        const script = document.createElement('script');
        let finished = false;
        const cleanup = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            script.remove();
            try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('El servicio de enlaces cortos no respondió.'));
        }, 10000);
        window[callbackName] = (data) => {
            const shortUrl = data && data.shorturl;
            cleanup();
            if (typeof shortUrl === 'string' && /^https:\/\/is\.gd\/[A-Za-z0-9]+$/.test(shortUrl)) resolve(shortUrl);
            else reject(new Error((data && data.errormessage) || 'No se pudo acortar el enlace.'));
        };
        script.onerror = () => {
            cleanup();
            reject(new Error('No se pudo conectar con el servicio de enlaces cortos.'));
        };
        script.src = 'https://is.gd/create.php?format=json&callback=' +
            encodeURIComponent(callbackName) + '&url=' + encodeURIComponent(longUrl);
        document.head.appendChild(script);
    });
}

async function copyUrlFromConfig(config) {
    if (!config || config.items.length === 0) {
        alert('No hay medios para generar una URL.');
        return;
    }
    const encoded = encodeConfig(config);
    const longUrl = window.location.href.split('#')[0] + '#play=' + encoded;
    const cacheKey = 'urlSlideshow_short_' + longUrl;
    let shareUrl = localStorage.getItem(cacheKey);
    try {
        if (!shareUrl) {
            shareUrl = await shortenUrlAutomatically(longUrl);
            try { localStorage.setItem(cacheKey, shareUrl); } catch (_) {}
        }
        await navigator.clipboard.writeText(shareUrl);
        alert('✅ Enlace corto copiado:\n' + shareUrl);
    } catch (error) {
        // Si el acortador falla, la presentación sigue siendo compartible.
        try {
            await navigator.clipboard.writeText(longUrl);
            alert('No se pudo crear un enlace corto. Copié el enlace completo para que puedas compartirlo:\n' + longUrl);
        } catch (_) {
            prompt('Copia este enlace para compartir la presentación:', longUrl);
        }
    }
}

function copyCurrentUrl() {
    const config = getCurrentConfig();
    if (config.items.length === 0) {
        alert('Agrega al menos un medio.');
        return;
    }
    copyUrlFromConfig(config);
}

// --- Vista previa ---
function previewCurrent() {
    const config = getCurrentConfig();
    if (config.items.length === 0) {
        alert('Agrega al menos un medio.');
        return;
    }
    startPlayer(config);
}

// --- Iniciar reproductor ---
function startPlayer(config) {
    if (!config || !config.items || config.items.length === 0) {
        showPlayerMessage('No hay elementos para reproducir.');
        return;
    }
    // Migrar presentaciones antiguas: los dashboards conocidos pasan a usar la captura local.
    config.items = config.items.map(item => {
        if (!item) return item;
        const originalUrl = item.sourceUrl || item.url;
        const captureUrl = getKnownDashboardCapture(originalUrl);
        return captureUrl
            ? { ...item, url: captureUrl, type: 'image', sourceUrl: originalUrl, capture: true }
            : item;
    });
    // Normalizar opciones para que también funcionen enlaces antiguos.
    config.transition = config.transition || 'fade';
    config.transitionDuration = Math.min(1500, Math.max(150, Number(config.transitionDuration) || 600));
    config.transitionDirection = ['left', 'right', 'up', 'down'].includes(config.transitionDirection) ? config.transitionDirection : 'left';
    config.transitionEasing = config.transitionEasing || 'ease';
    // Detener cualquier reproducción anterior
    stopPlayer();
    playerState.config = config;
    playerState.currentIndex = 0;
    playerState.isPlaying = true;
    playerState.isTransitioning = false;
    playerState.activeLayer = 'a';
    playerState.hiddenLayer = 'b';
    // Limpiar capas
    layerA.innerHTML = '';
    layerB.innerHTML = '';
    layerA.className = 'slide-layer';
    layerB.className = 'slide-layer';
    // Mostrar reproductor, ocultar editor
    editor.style.display = 'none';
    player.style.display = 'block';
    controls.classList.remove('visible');
    playPauseBtn.textContent = '⏸';
    // Cargar primera diapositiva. Para capturas remotas, esperar la imagen
    // antes de iniciar el temporizador; así no se reinicia mientras sigue cargando.
    loadSlide(0, layerA, true);
    startCaptureRefreshMonitoring();
    if (config.items[0]?.capture) {
        waitForCapturedImage(layerA).then(loaded => {
            if (playerState.config !== config) return;
            if (loaded) scheduleNext();
            else showPlayerMessage('No se pudo cargar la captura. Comprueba el enlace o vuelve a intentarlo.');
        });
    } else {
        scheduleNext();
    }
    // Mostrar controles temporalmente
    showControlsTemporarily();
    // Actualizar contador
    updateCounter();
}

function stopPlayer() {
    stopCaptureRefreshMonitoring();
    if (playerState.timer) {
        clearTimeout(playerState.timer);
        playerState.timer = null;
    }
    // Pausar videos
    document.querySelectorAll('.slide-layer video').forEach(v => v.pause());
    playerState.isPlaying = false;
    // No ocultamos el player aquí, solo detenemos la reproducción
}

function loadSlide(index, layerElement, makeActive) {
    const config = playerState.config;
    if (!config || index < 0 || index >= config.items.length) return;
    const item = config.items[index];
    const fit = config.fit || 'contain-blur';
    const mediaType = item.type === 'embed' || detectType(item.url) === 'embed' ? 'embed' : item.type;
    const container = document.createElement('div');
    container.className = 'slide-content';
    
    // Fondo blur solo para imágenes; los dashboards usan todo el lienzo.
    if (fit === 'contain-blur' && mediaType === 'image' && !item.capture) {
        const bg = document.createElement('img');
        bg.className = 'bg-blur';
        bg.src = getImageUrlForDisplay(item.url);
        bg.alt = 'background blur';
        bg.onerror = () => { bg.style.display = 'none'; };
        container.appendChild(bg);
    }
    
    // Elemento principal
    let main;
    const mainClass = fit === 'cover' ? 'cover' : 'contain';
    if (mediaType === 'embed') {
        main = document.createElement('iframe');
        main.className = 'main-media embedded-media';
        main.src = getEmbedUrl(item.url);
        main.title = 'Presentación o dashboard integrado';
        main.loading = 'eager';
        main.referrerPolicy = 'strict-origin-when-cross-origin';
        main.allow = 'fullscreen; autoplay; clipboard-read; clipboard-write';
        main.allowFullscreen = true;
        main.style.border = '0';
        main.style.background = '#fff';
        main.onerror = () => showSlideError(container, 'No se pudo cargar el contenido integrado. Comprueba el enlace y sus permisos.');
        container.appendChild(main);
    } else if (mediaType === 'video') {
        main = document.createElement('video');
        main.src = getImageUrlForDisplay(item.url);
        main.className = `main-media ${mainClass}`;
        main.muted = true;
        main.playsInline = true;
        main.autoplay = false;
        main.preload = 'metadata';
        main.onerror = () => {
            showSlideError(container, 'No se pudo cargar el video');
        };
        main.addEventListener('ended', () => {
            if (playerState.isPlaying) goToNext();
        });
        container.appendChild(main);
    } else {
        main = document.createElement('img');
        main.className = `main-media ${mainClass}`;
        main.src = getImageUrlForDisplay(item.url);
        main.alt = 'slide';
        main.onerror = () => {
            showSlideError(container, 'No se pudo cargar la imagen');
        };
        container.appendChild(main);
    }
    
    // Limpiar y agregar al layer
    layerElement.innerHTML = '';
    layerElement.appendChild(container);
    
    if (makeActive) {
        layerElement.classList.add('active');
        // Si es video, reproducir
        if (item.type === 'video') {
            const video = layerElement.querySelector('video');
            if (video) {
                video.play().catch(() => {});
            }
        }
    } else {
        layerElement.classList.remove('active');
    }
}

function showSlideError(container, msg) {
    const div = document.createElement('div');
    div.className = 'error-msg';
    div.textContent = msg;
    container.appendChild(div);
}

function updateCounter() {
    const total = playerState.config?.items.length || 0;
    const current = playerState.currentIndex + 1;
    slideCounter.textContent = `${current} / ${total}`;
}

// --- Transición y navegación ---
function goToNext() {
    if (playerState.isTransitioning) return;
    const config = playerState.config;
    if (!config) return;
    // Una única captura es una imagen fija: no volver a solicitarla en cada vuelta.
    if (config.items.length === 1 && config.items[0]?.capture) return;
    let nextIndex = playerState.currentIndex + 1;
    if (nextIndex >= config.items.length) {
        if (config.loop) {
            nextIndex = 0;
        } else {
            // Fin de la presentación
            pausePlayer();
            showPlayerMessage('Fin de la presentación');
            return;
        }
    }
    performTransition(nextIndex);
}

function goToPrev() {
    if (playerState.isTransitioning) return;
    const config = playerState.config;
    if (!config) return;
    let prevIndex = playerState.currentIndex - 1;
    if (prevIndex < 0) {
        if (config.loop) {
            prevIndex = config.items.length - 1;
        } else {
            return;
        }
    }
    performTransition(prevIndex);
}

function performTransition(newIndex) {
    const config = playerState.config;
    if (!config) return;
    playerState.isTransitioning = true;

    const activeLayer = playerState.activeLayer;
    const hiddenLayer = activeLayer === 'a' ? 'b' : 'a';
    const activeEl = activeLayer === 'a' ? layerA : layerB;
    const hiddenEl = hiddenLayer === 'a' ? layerA : layerB;
    const mode = config.transition || 'fade';
    const duration = mode === 'none' ? 0 : (config.transitionDuration || 600);
    const nextItem = config.items[newIndex];

    loadSlide(newIndex, hiddenEl, false);

    const beginTransition = () => {
        // El contenido entrante ya está listo; ahora sí cambiar de diapositiva.
        const oldVideo = activeEl.querySelector('video');
        if (oldVideo) oldVideo.pause();
        const video = hiddenEl.querySelector('video');
        if (video) video.play().catch(() => {});

        if (mode === 'none' || duration === 0) {
            activeEl.classList.remove('active');
            hiddenEl.classList.add('active');
            playerState.activeLayer = hiddenLayer;
            playerState.currentIndex = newIndex;
            updateCounter();
            playerState.isTransitioning = false;
            scheduleNext();
            activeEl.innerHTML = '';
            return;
        }

        // La capa entrante se anima por encima de la anterior.
        const direction = config.transitionDirection || 'left';
        hiddenEl.style.zIndex = '2';
        activeEl.style.zIndex = '1';
        hiddenEl.style.setProperty('--transition-duration', duration + 'ms');
        hiddenEl.style.setProperty('--transition-easing', config.transitionEasing || 'ease');
        hiddenEl.classList.remove('transition-in', 'anim-fade', 'anim-slide', 'anim-zoom', 'anim-rotate3d', 'anim-blur', 'anim-rise', 'anim-drop', 'anim-rotate', 'anim-wipe', 'anim-bounce', 'anim-flip');
        activeEl.classList.remove('transition-out');
        hiddenEl.classList.add('transition-in', 'anim-' + mode);
        hiddenEl.dataset.direction = direction;
        hiddenEl.classList.add('active');

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                activeEl.classList.add('transition-out');
                activeEl.classList.remove('active');
            });
        });

        window.setTimeout(() => {
            activeEl.classList.remove('transition-out');
            hiddenEl.classList.remove('transition-in', 'anim-fade', 'anim-slide', 'anim-zoom', 'anim-rotate3d', 'anim-blur', 'anim-rise', 'anim-drop', 'anim-rotate', 'anim-wipe', 'anim-bounce', 'anim-flip');
            hiddenEl.style.zIndex = '';
            activeEl.style.zIndex = '';
            hiddenEl.style.removeProperty('--transition-duration');
            hiddenEl.style.removeProperty('--transition-easing');
            delete hiddenEl.dataset.direction;
            playerState.activeLayer = hiddenLayer;
            playerState.currentIndex = newIndex;
            updateCounter();
            playerState.isTransitioning = false;
            scheduleNext();
            // Limpiar la capa anterior solo después de la animación.
            activeEl.innerHTML = '';
        }, duration + 40);
    };

    if (nextItem?.capture) {
        waitForCapturedImage(hiddenEl).then(loaded => {
            if (playerState.config !== config) return;
            if (loaded) {
                beginTransition();
            } else {
                hiddenEl.innerHTML = '';
                playerState.isTransitioning = false;
                showPlayerMessage('No se pudo cargar la captura siguiente; mantengo la diapositiva actual.');
                scheduleNext();
            }
        });
        return;
    }

    beginTransition();
}
function scheduleNext() {
    // Limpiar timer anterior
    if (playerState.timer) {
        clearTimeout(playerState.timer);
        playerState.timer = null;
    }
    if (!playerState.isPlaying) return;
    const config = playerState.config;
    if (!config) return;
    const item = config.items[playerState.currentIndex];
    if (!item) return;
    
    // Si es video, no usamos timer, el evento ended lo maneja
    if (item.type === 'video') {
        // Verificar si el video ya terminó (por si acaso)
        const activeLayer = (playerState.activeLayer === 'a') ? layerA : layerB;
        const video = activeLayer.querySelector('video');
        if (video && video.ended) {
            // Si ya terminó, avanzar
            goToNext();
        }
        return;
    }
    
    // Una captura dinámica en solitario no necesita recargarse cada vuelta.
    if (item.capture && config.items.length === 1) return;

    // Imagen/GIF: programar siguiente. Las capturas ya están cargadas al llegar aquí.
    const duration = (config.duration || 5) * 1000;
    playerState.timer = setTimeout(() => {
        if (playerState.isPlaying) {
            goToNext();
        }
    }, duration);
}

// --- Controles de reproducción ---
function togglePlayPause() {
    if (!playerState.config) return;
    if (playerState.isPlaying) {
        pausePlayer();
    } else {
        resumePlayer();
    }
}

function pausePlayer() {
    if (!playerState.isPlaying) return;
    playerState.isPlaying = false;
    if (playerState.timer) {
        clearTimeout(playerState.timer);
        playerState.timer = null;
    }
    // Pausar videos
    const activeLayer = (playerState.activeLayer === 'a') ? layerA : layerB;
    const video = activeLayer.querySelector('video');
    if (video) video.pause();
    playPauseBtn.textContent = '▶';
    showPlayerMessage('⏸ Pausado');
    setTimeout(() => hidePlayerMessage(), 1500);
}

function resumePlayer() {
    if (playerState.isPlaying) return;
    const config = playerState.config;
    if (!config) return;
    playerState.isPlaying = true;
    // Reanudar video si existe
    const activeLayer = (playerState.activeLayer === 'a') ? layerA : layerB;
    const video = activeLayer.querySelector('video');
    if (video) {
        video.play().catch(() => {});
        // Si el video ya terminó, avanzar
        if (video.ended) {
            goToNext();
            return;
        }
    }
    playPauseBtn.textContent = '⏸';
    scheduleNext();
    hidePlayerMessage();
}

// --- Controles de UI ---
function showControlsTemporarily() {
    controls.classList.add('visible');
    clearTimeout(window.controlsTimeout);
    window.controlsTimeout = setTimeout(() => {
        controls.classList.remove('visible');
    }, 3000);
}

function showPlayerMessage(msg) {
    playerMessage.textContent = msg;
    playerMessage.classList.add('show');
    clearTimeout(window.msgTimeout);
    window.msgTimeout = setTimeout(() => {
        playerMessage.classList.remove('show');
    }, 3000);
}

function hidePlayerMessage() {
    playerMessage.classList.remove('show');
    clearTimeout(window.msgTimeout);
}

// --- Fullscreen ---
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.() || 
        document.documentElement.webkitRequestFullscreen?.();
    } else {
        document.exitFullscreen?.() || 
        document.webkitExitFullscreen?.();
    }
}

// --- Salir del reproductor ---
function exitPlayer() {
    stopPlayer();
    if (document.fullscreenElement) {
        document.exitFullscreen?.() || document.webkitExitFullscreen?.();
    }
    player.style.display = 'none';
    editor.style.display = 'flex';
    // Restablecer capas
    layerA.innerHTML = '';
    layerB.innerHTML = '';
    layerA.className = 'slide-layer';
    layerB.className = 'slide-layer';
    playerState.config = null;
    // Refrescar lista local
    renderLocalSaves();
}

// --- Inicialización: leer hash ---
function initFromHash() {
    const hash = window.location.hash;
    if (hash.startsWith('#play=')) {
        const encoded = hash.substring(6);
        const config = decodeConfig(encoded);
        if (config && config.items && config.items.length > 0) {
            startPlayer(config);
            return true;
        } else {
            // Hash inválido
            alert('Presentación no válida. El hash está corrupto o no se puede decodificar.');
            window.location.hash = '';
            return false;
        }
    }
    return false;
}

// --- Event listeners ---
document.addEventListener('DOMContentLoaded', () => {
    // Editor: agregar medio
    $('add-media-btn').addEventListener('click', async () => {
        const input = $('media-url');
        const url = input.value;
        try {
            const added = await addMediaItem(url);
            if (added) {
                input.value = '';
                input.focus();
            } else {
                alert('Ingresa una URL válida que comience con http:// o https://.');
            }
        } catch (error) {
            alert(
                'No se pudo capturar esta página.\n\n' +
                (error?.message || 'Error desconocido.') +
                '\n\nProbé dos endpoints de PageShot y un servicio alternativo. Las páginas privadas, protegidas o que bloquean capturas pueden fallar.'
            );
        }
    });
    $('media-url').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            $('add-media-btn').click();
        }
    });
    
    // Editor: guardar
    $('save-btn').addEventListener('click', () => {
        const config = saveToLocalStorage();
        if (config) {
            alert('✅ Presentación guardada en este navegador. Para compartirla, usa «Copiar URL»: el enlace corto se generará automáticamente.');
        }
    });
    
    // Editor: vista previa
    $('preview-btn').addEventListener('click', previewCurrent);
    
    // Editor: copiar URL
    $('copy-btn').addEventListener('click', copyCurrentUrl);
    
    // Reproductor: controles
    playPauseBtn.addEventListener('click', togglePlayPause);
    prevBtn.addEventListener('click', () => { if (playerState.config) goToPrev(); });
    nextBtn.addEventListener('click', () => { if (playerState.config) goToNext(); });
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    exitBtn.addEventListener('click', exitPlayer);
    
    // Teclado
    document.addEventListener('keydown', (e) => {
        if (player.style.display === 'block') {
            if (e.key === 'ArrowLeft') { e.preventDefault(); goToPrev(); showControlsTemporarily(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); goToNext(); showControlsTemporarily(); }
            else if (e.key === ' ' || e.key === 'Space') { e.preventDefault(); togglePlayPause(); showControlsTemporarily(); }
            else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
            else if (e.key === 'Escape') { 
                if (document.fullscreenElement) {
                    document.exitFullscreen?.() || document.webkitExitFullscreen?.();
                } else {
                    exitPlayer();
                }
            }
        }
    });
    
    // Mostrar/ocultar controles con mouse/touch en reproductor
    player.addEventListener('mousemove', showControlsTemporarily);
    player.addEventListener('touchstart', showControlsTemporarily);
    player.addEventListener('click', showControlsTemporarily);
    
    // Cargar presentaciones locales al iniciar
    renderLocalSaves();
    
    // Inicializar desde hash
    const hasValidHash = initFromHash();
    if (hasValidHash) {
        // Ya estamos en reproductor
    } else {
        // Asegurar editor visible
        editor.style.display = 'flex';
        player.style.display = 'none';
        // Cargar datos de ejemplo (opcional)
        if (editorState.items.length === 0) {
            // Agregar ejemplos solo si no hay hash y no hay nada
            // (para demostración, pero no obligatorio)
        }
    }
});

// Cuando cambie el hash (por ejemplo, al hacer clic en un enlace)
window.addEventListener('hashchange', () => {
    // Si estamos en el reproductor y el hash cambia, podría ser una nueva presentación
    if (player.style.display === 'block') {
        // Salir y recargar
        exitPlayer();
    }
    initFromHash();
});

// --- Utilidad extra: escalar el fondo blur ---
// (Ya está en CSS con transform: scale(1.1))

console.log('🎬 URL Slideshow cargado correctamente.');
console.log('Comparte presentaciones mediante #play=... en la URL.');
