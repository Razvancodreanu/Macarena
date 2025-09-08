// ==============================
// Macarena • app.js (integral)
// ==============================

// ---------- Helpers DOM ----------
const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn, { passive: true });

function byText(selector, text) {
    const nodes = document.querySelectorAll(selector);
    text = (text || '').toLowerCase();
    for (const n of nodes) {
        if (n.textContent.trim().toLowerCase() === text) return n;
    }
    return null;
}

function idOrText(id, selector, text) {
    return $(id) || byText(selector, text);
}

// injectăm puțin CSS (blink SOS, panel etc) fără să-ți atingi style.css
(function injectCss() {
    const css = `
  .blink{ animation: blink 0.6s ease-in-out infinite; }
  @keyframes blink{ 0%,100%{filter:drop-shadow(0 0 0 red)} 50%{filter:drop-shadow(0 0 8px red)} }
  .panel{ position:absolute; top:0; right:0; width:360px; height:100%; overflow:auto; background:#0e0f11; color:#cfd7df; padding:10px 12px; border-left:1px solid #222; }
  .panel .sec{ margin:10px 0 14px; padding:10px; background:#13151a; border:1px solid #1f2430; border-radius:8px; }
  .panel .sec h4{ margin:0 0 10px; font-weight:600; }
  .soft{ opacity:.85 }
  .badge{ display:inline-block; padding:.25rem .5rem; border-radius:999px; background:#243; color:#aef; font-size:.8rem; }
  `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
})();

// ---------- Supabase init ----------
const SUPABASE_URL = 'https://ndxjdmkeounxliifpbyw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_7k4luMzyb2t3LNeHSF8WBQ_bLZB4KNc'; // public

// supabase-js v2 (global import din <script type="module" ...> în index.html)
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- Leaflet map ----------
let Lmap, meMarker, mePath, meHistory;
const others = new Map(); // user_id -> { marker, path }
let watchId = null;
let saveTimer = null;

// ---------- App State ----------
const S = {
    user: null,
    room: '',
    visibility: 'global',  // 'global' | 'private'
    lastPos: null,
    sosTimer: null,
    sosDownAt: 0,
    sosThresholdMs: 3000,
    alertsRt: null,
    locRt: null
};

// ---------- Tabele ----------
const TB = {
    locations: 'locations',
    alerts: 'alerts',
    history: 'locations_history'
};

// ---------- Beep (audio SOS) ----------
function makeBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        return () => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine'; o.frequency.value = 880;
            g.gain.value = .15;
            o.connect(g); g.connect(ctx.destination);
            o.start();
            setTimeout(() => { o.stop(); }, 300);
        };
    } catch { return () => { }; }
}
const beep = makeBeep();

// ---------- UI refs (cu fallback pe text) ----------
const ui = {
    // top bar
    joinInput: idOrText('room', 'input', ''),
    joinBtn: idOrText('btnJoin', 'button', 'join'),
    centerBtn: idOrText('centerMeBtn', 'button', 'center me'),
    startTop: idOrText('startShareTop', 'button', 'start sharing'),
    stopTop: idOrText('stopShareTop', 'button', 'stop'),

    // panel right (dacă există; nu oblig)
    panel: document.querySelector('.panel') || null,

    // auth
    signGoogle: byText('button', 'sign in with google'),
    signOut: byText('button', 'sign out'),
    magicEmail: document.querySelector('input[type="email"]'),
    magicSend: byText('button', 'trimite magic link'),

    // phone
    phoneInput: document.querySelector('input[placeholder^="+40"], input[placeholder*="xxx"]'),
    otpInput: byText('input', 'cod sms') || null,
    otpSend: byText('button', 'sms otp') || null,
    otpConfirm: byText('button', 'confirmă') || null,

    // mode visibility
    radioGlobal: byText('label,div span', 'global (toți utilizatorii)')?.closest('label,div')?.querySelector('input[type="radio"]'),
    radioPrivate: byText('label,div span', 'cameră privată')?.closest('label,div')?.querySelector('input[type="radio"]'),

    // share location din panel
    startShare: byText('button', 'start sharing'),
    stopShare: byText('button', 'stop'),

    // alerts
    sosBtn: byText('button', 'sos'),
    checkInBtn: byText('button', 'check-in'),

    // history
    histLoad: byText('button', 'încarcă'),
    histClear: byText('button', 'curăță'),

    // display link camera
    roomLinkOut: document.querySelector('input[readonly]') || null
};

// ---------- Map init ----------
function initMap() {
    const mapDiv = $('map') || (() => { // fallback dacă nu ai id=map
        const d = document.createElement('div');
        d.id = 'map';
        d.style.position = 'absolute';
        d.style.left = '0'; d.style.top = '0'; d.style.bottom = '0'; d.style.right = (ui.panel ? '360px' : '0');
        document.body.appendChild(d);
        return d;
    })();

    if (ui.panel) {
        // dacă panelul nu există în HTML, îl construim minimalist (opțional)
    }

    Lmap = L.map(mapDiv).setView([45.75, 21.23], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(Lmap);
}

function centerOnMe() {
    if (meMarker) {
        Lmap.setView(meMarker.getLatLng(), 15);
    } else {
        navigator.geolocation.getCurrentPosition(p => {
            const { latitude: lat, longitude: lng } = p.coords;
            Lmap.setView([lat, lng], 15);
        });
    }
}

// ---------- Auth ----------
async function restoreSession() {
    const { data: { user } } = await sb.auth.getUser();
    S.user = user || null;
    reflectAuth();
    setRealtime(); // după auth setăm canalele
}

async function signInGoogle() {
    await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: location.href.split('#')[0]
        }
    });
}

async function signOut() {
    await sb.auth.signOut();
    S.user = null;
    reflectAuth();
    setRealtime();
}

async function signInMagic(email) {
    if (!email) return alert('Introdu email');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } });
    if (error) alert(error.message); else alert('Ți-am trimis link pe email.');
}

function reflectAuth() {
    // Panel mic: afișez status
    const el = byText('.panel .sec h4', 'Autentificare')?.closest('.sec') || null;
    if (el) {
        const status = S.user ? `Autentificat ca: <span class="badge">${S.user.email || S.user.phone || S.user.id}</span>` : 'Neautentificat';
        const span = el.querySelector('.soft') || document.createElement('div');
        span.className = 'soft'; span.style.marginTop = '6px';
        span.innerHTML = status;
        el.appendChild(span);
    }

    // link cameră
    if (ui.roomLinkOut) {
        const url = new URL(location.href);
        if (S.room) url.searchParams.set('room', S.room); else url.searchParams.delete('room');
        ui.roomLinkOut.value = S.room ? url.toString() : '';
    }
}

// ---------- Rooms & Visibility ----------
function setVisibility(mode) {
    S.visibility = mode; // 'global' | 'private'
    setRealtime();
}

function joinRoom() {
    const val = (ui.joinInput?.value || '').trim();
    if (!val) return alert('Introdu numele camerei (ex: familia, echipa-42)');
    S.room = val;
    reflectAuth();
    setRealtime();
}

function leaveRoom() {
    S.room = '';
    reflectAuth();
    setRealtime();
}

// ---------- Geolocation & persist ----------
function onPos(p) {
    const { latitude: lat, longitude: lng, accuracy } = p.coords;
    if (!meMarker) {
        meMarker = L.marker([lat, lng], { title: 'Eu' }).addTo(Lmap);
        mePath = L.polyline([], { color: '#4dc4ff', weight: 4 }).addTo(Lmap);
        Lmap.setView([lat, lng], 15);
    } else {
        meMarker.setLatLng([lat, lng]);
    }
    mePath.addLatLng([lat, lng]);
    S.lastPos = { lat, lng, accuracy, at: new Date().toISOString() };
}

function onPosErr(e) { console.warn('geo', e); }

async function persistCurrentLocation() {
    if (!S.user || !S.lastPos) return;
    try {
        const payload = {
            user_id: S.user.id,
            lat: S.lastPos.lat, lng: S.lastPos.lng,
            accuracy: S.lastPos.accuracy ?? null,
            visibility: S.visibility,
            room: S.visibility === 'private' ? (S.room || null) : null,
            created_at: new Date().toISOString()
        };
        const { error } = await sb.from(TB.locations).insert(payload);
        if (error) console.warn('insert locations', error.message);
    } catch (e) { console.warn(e); }
}

function startSharing() {
    if (!navigator.geolocation) return alert('Browserul nu suportă Geolocation.');
    if (watchId) return;
    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
        enableHighAccuracy: true, maximumAge: 0, timeout: 15000
    });
    saveTimer = setInterval(persistCurrentLocation, 5000);
    console.log('Sharing started');
}

function stopSharing() {
    if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
    console.log('Sharing stopped');
}

// ---------- Realtime ----------
function clearOthers() {
    for (const [id, o] of others) {
        if (o.marker) Lmap.removeLayer(o.marker);
        if (o.path) Lmap.removeLayer(o.path);
    }
    others.clear();
}

function upsertOther(userId, lat, lng) {
    let o = others.get(userId);
    if (!o) {
        o = {
            marker: L.marker([lat, lng], { title: userId, opacity: 0.95 }).addTo(Lmap),
            path: L.polyline([], { color: '#ffaa00', weight: 3, opacity: 0.85 }).addTo(Lmap)
        };
        others.set(userId, o);
    }
    o.marker.setLatLng([lat, lng]);
    o.path.addLatLng([lat, lng]);
}

function setRealtime() {
    // curăț abonamente vechi
    if (S.locRt) { sb.removeChannel(S.locRt); S.locRt = null; }
    if (S.alertsRt) { sb.removeChannel(S.alertsRt); S.alertsRt = null; }
    clearOthers();

    // locații (INSERT)
    S.locRt = sb.channel('rt_locations')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TB.locations }, payload => {
            const r = payload.new;
            // filtre: global sau aceeași cameră
            const show =
                r.visibility === 'global' ||
                (r.visibility === 'private' && S.room && r.room === S.room);
            if (!show) return;
            if (r.user_id === S.user?.id) return;
            upsertOther(r.user_id, r.lat, r.lng);
        })
        .subscribe((status) => { if (status === 'SUBSCRIBED') console.log('RT locations ready'); });

    // alerte — doar pentru popup sonor/efect
    S.alertsRt = sb.channel('rt_alerts')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TB.alerts }, payload => {
            const r = payload.new;
            const show =
                r.visibility === 'global' ||
                (r.visibility === 'private' && S.room && r.room === S.room);
            if (!show) return;

            // Beep + pin roșu temporar
            try { beep(); } catch { }
            const m = L.marker([r.lat, r.lng], { title: `ALERTĂ ${r.type.toUpperCase()}` }).addTo(Lmap);
            const el = m.getElement(); if (el) el.classList.add('blink');
            setTimeout(() => { Lmap.removeLayer(m); }, 10 * 1000);

            // mic toast
            const msg = `ALERTĂ: ${r.type} • ${new Date(r.created_at).toLocaleTimeString()}`;
            console.log(msg);
        })
        .subscribe(() => { });
}

// ---------- History ----------
async function loadMyHistory(hours = 24) {
    if (!S.user) return alert('Autentifică-te');
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    const { data, error } = await sb
        .from(TB.locations)
        .select('lat,lng,created_at')
        .eq('user_id', S.user.id)
        .gte('created_at', since)
        .order('created_at', { ascending: true });

    if (error) { console.warn(error.message); return; }

    if (meHistory) { Lmap.removeLayer(meHistory); }
    meHistory = L.polyline(data.map(d => [d.lat, d.lng]), { color: '#00d4aa', weight: 3 }).addTo(Lmap);
    if (data.length) Lmap.fitBounds(meHistory.getBounds(), { padding: [20, 20] });
}

function clearHistoryLayer() {
    if (meHistory) { Lmap.removeLayer(meHistory); meHistory = null; }
}

// ---------- Alerts ----------
function sosDown() {
    S.sosDownAt = performance.now();
    // mic countdown vizual în titlu (opțional)
    S.sosTimer = requestAnimationFrame(tickCountdown);
}
function sosUp() {
    if (S.sosTimer) { cancelAnimationFrame(S.sosTimer); S.sosTimer = null; document.title = document.title.replace(/^\[\d\]\s*/, ''); }
    const dur = performance.now() - S.sosDownAt;
    if (dur >= S.sosThresholdMs) {
        triggerSOS(true); // instant
    } else {
        // scurt → selector tip (minimal pentru demo)
        triggerSOS(false);
    }
}

function tickCountdown() {
    const remain = Math.max(0, S.sosThresholdMs - (performance.now() - S.sosDownAt));
    const sec = Math.ceil(remain / 1000);
    const base = document.title.replace(/^\[\d\]\s*/, '');
    document.title = `[${sec}] ${base}`;
    S.sosTimer = requestAnimationFrame(tickCountdown);
}

async function triggerSOS(instant = false) {
    try { beep(); } catch { }
    // blink pe markerul meu
    if (meMarker) {
        const el = meMarker.getElement();
        if (el) { el.classList.add('blink'); setTimeout(() => el.classList.remove('blink'), 10 * 1000); }
    }
    // inserăm în DB dacă știm poziția & userul
    if (!S.user || !meMarker) return;
    const { lat, lng } = meMarker.getLatLng();
    const payload = {
        user_id: S.user.id,
        type: instant ? 'sos_instant' : 'sos_select',
        lat, lng,
        visibility: S.visibility,
        room: S.visibility === 'private' ? (S.room || null) : null,
        created_at: new Date().toISOString()
    };
    const { error } = await sb.from(TB.alerts).insert(payload);
    if (error) console.warn('insert alerts', error.message);
}

async function checkIn() {
    if (!S.user || !meMarker) return;
    const { lat, lng } = meMarker.getLatLng();
    const { error } = await sb.from(TB.alerts).insert({
        user_id: S.user.id, type: 'checkin', lat, lng,
        visibility: S.visibility, room: S.visibility === 'private' ? (S.room || null) : null,
        created_at: new Date().toISOString()
    });
    if (error) console.warn('checkin', error.message);
}

// ---------- Wire UI ----------
function wireUi() {
    // top bar
    on(ui.centerBtn, 'click', centerOnMe);
    on(ui.joinBtn, 'click', () => S.room ? leaveRoom() : joinRoom());
    on(ui.startTop, 'click', startSharing);
    on(ui.stopTop, 'click', stopSharing);

    // auth
    on(ui.signGoogle, 'click', signInGoogle);
    on(ui.signOut, 'click', signOut);
    on(ui.magicSend, 'click', () => signInMagic(ui.magicEmail?.value || ''));

    // visibility
    on(ui.radioGlobal, 'change', () => setVisibility('global'));
    on(ui.radioPrivate, 'change', () => setVisibility('private'));

    // panel share
    on(ui.startShare, 'click', startSharing);
    on(ui.stopShare, 'click', stopSharing);

    // alerts
    if (ui.sosBtn) {
        ui.sosBtn.addEventListener('pointerdown', sosDown);
        ui.sosBtn.addEventListener('pointerup', sosUp);
        ui.sosBtn.addEventListener('pointerleave', sosUp);
        ui.sosBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { sosDown(); setTimeout(sosUp, 100); } });
    }
    on(ui.checkInBtn, 'click', checkIn);

    // history
    on(ui.histLoad, 'click', () => loadMyHistory(24));
    on(ui.histClear, 'click', clearHistoryLayer);
}

// ---------- Init ----------
async function init() {
    initMap();
    wireUi();

    // preia ?room= din url
    const roomQ = new URLSearchParams(location.search).get('room');
    if (roomQ) { S.room = roomQ; if (ui.joinInput) ui.joinInput.value = roomQ; }

    await restoreSession();

    // centrează la început (fără a porni share)
    try {
        navigator.geolocation.getCurrentPosition(p => {
            const { latitude: lat, longitude: lng } = p.coords;
            Lmap.setView([lat, lng], 13);
        });
    } catch { }
}

document.addEventListener('DOMContentLoaded', init);
