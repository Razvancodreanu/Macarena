// ====== Supabase client (browser-only, ESM) ======
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// >>> completează cu datele tale (le-am pus deja din ce mi-ai dat)
const SUPABASE_URL = "https://ndxjdmkeounxliifpbyw.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5keGpkbWtlb3VueGxpaWZwYnl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcyNTAxMjcsImV4cCI6MjA3MjgyNjEyN30.tzBnFZiFdPzqlSKiqx6uPMpZvHdSF1D8m7DXQx5E0I4";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
        persistSession: true,
        detectSessionInUrl: true, // important pentru callback-ul OAuth/magic link
        flowType: "pkce"
    }
});

// ====== UI refs ======
const el = {
    room: document.getElementById('room'),
    join: document.getElementById('join'),
    share: document.getElementById('share'),
    centerMe: document.getElementById('centerMe'),
    authStatus: document.getElementById('authStatus'),
    email: document.getElementById('email'),
    sendLink: document.getElementById('sendLink'),
    signOut: document.getElementById('signOut'),
    googleBtn: document.getElementById('googleBtn'),
    roomStatus: document.getElementById('roomStatus'),
    shareStatus: document.getElementById('shareStatus'),
    roomLink: document.getElementById('roomLink'),
};

// ====== Map (Leaflet) ======
const map = L.map('map', { zoomControl: true }).setView([45.9432, 24.9668], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
}).addTo(map);

const markers = new Map();
function upsertMarker(uid, { lat, lng, name, ts, isSelf }) {
    const label = name || uid?.slice?.(0, 6) || 'user';
    const text = `${label}${isSelf ? ' (eu)' : ''}<br>${new Date(ts).toLocaleTimeString()}`;
    if (markers.has(uid)) {
        const m = markers.get(uid);
        m.setLatLng([lat, lng]).bindPopup(text);
    } else {
        const m = L.marker([lat, lng]).addTo(map).bindPopup(text);
        markers.set(uid, m);
    }
}
function removeMissing(keepSet) {
    for (const uid of Array.from(markers.keys())) {
        if (!keepSet.has(uid)) {
            const m = markers.get(uid); map.removeLayer(m); markers.delete(uid);
        }
    }
}

// ====== State ======
let session = null;
let currentUser = null;
let roomId = null;
let watchId = null;
let realtimeChannel = null;
let lastSent = 0;

// ====== Helpers ======
function setStatus(where, msg) {
    if (where === 'share') el.shareStatus.textContent = msg;
    else if (where === 'room') el.roomStatus.textContent = msg;
    else el.authStatus.textContent = msg;
}
function getRoomFromURL() {
    const u = new URL(location.href);
    return u.searchParams.get('room');
}
function setRoomToURL(id) {
    const u = new URL(location.href);
    u.searchParams.set('room', id);
    history.replaceState(null, '', u.toString());
    const link = `${u.origin}${u.pathname}?room=${encodeURIComponent(id)}`;
    el.roomLink.textContent = link;
}
const round = (n, p = 5) => Number(n.toFixed(p));

// ====== Auth (UI + fluxuri) ======
async function refreshAuthUI() {
    const { data: { session: s } } = await supabase.auth.getSession();
    session = s;
    currentUser = s?.user || null;
    if (currentUser) {
        setStatus('auth', `Autentificat ca: ${currentUser.email}`);
    } else {
        setStatus('auth', 'Neautentificat. Poți folosi Google sau magic link (email).');
    }
}
await refreshAuthUI();
supabase.auth.onAuthStateChange((_evt, _ses) => refreshAuthUI());

// Google OAuth
el.googleBtn.addEventListener('click', async () => {
    // IMPORTANT: redirectTo = URL-ul public al site-ului tău pe GitHub Pages
    const redirectTo = "https://razvancodreanu.github.io/Macarena/";
    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo } // Supabase va face hop prin /auth/v1/callback și revine aici
    });
    if (error) alert(error.message);
});

// Magic link
el.sendLink.addEventListener('click', async () => {
    const email = (el.email.value || '').trim();
    if (!email) { alert('Introdu o adresă de email.'); return; }
    const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: "https://razvancodreanu.github.io/Macarena/" }
    });
    if (error) alert(error.message);
    else alert('Ți-am trimis un magic link. Verifică emailul și revino la pagină.');
});

// Sign out
el.signOut.addEventListener('click', async () => {
    await supabase.auth.signOut();
    currentUser = null;
    await refreshAuthUI();
});

// ====== Rooms / Realtime ======
async function loadInitial(room) {
    const { data, error } = await supabase
        .from('locations')
        .select('*')
        .eq('room_id', room);

    if (error) { setStatus('room', `Eroare load: ${error.message}`); return; }

    const keep = new Set();
    for (const row of data || []) {
        keep.add(row.user_id);
        if (row.lat && row.lng) {
            upsertMarker(row.user_id, {
                lat: row.lat, lng: row.lng, name: row.name,
                ts: row.ts || new Date().toISOString(),
                isSelf: currentUser && row.user_id === currentUser.id
            });
        }
    }
    removeMissing(keep);
}

async function subscribeRoom(room) {
    if (realtimeChannel) {
        await supabase.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }

    realtimeChannel = supabase
        .channel(`room:${room}`)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'locations', filter: `room_id=eq.${room}` },
            (payload) => {
                const row = payload.new || payload.old;
                if (!row) return;
                if (payload.eventType === 'DELETE') return;
                if (row.lat && row.lng) {
                    upsertMarker(row.user_id, {
                        lat: row.lat, lng: row.lng, name: row.name,
                        ts: row.ts, isSelf: currentUser && row.user_id === currentUser.id
                    });
                }
            })
        .subscribe((status) => {
            setStatus('room', `Room "${room}" realtime: ${status}`);
        });
}

async function joinRoom(id) {
    roomId = (id || '').trim();
    if (!roomId) { setStatus('room', 'Alege un room id (ex: friends)'); return; }
    setRoomToURL(roomId);
    await loadInitial(roomId);
    await subscribeRoom(roomId);
}
el.join.addEventListener('click', () => joinRoom(el.room.value));

// Deep-link room din URL, dacă există
const urlRoom = getRoomFromURL();
if (urlRoom) { el.room.value = urlRoom; joinRoom(urlRoom); }

// ====== Share on/off ======
function startSharing() {
    if (!currentUser) { alert('Te rog loghează-te înainte de sharing.'); return; }
    if (!roomId) { alert('Mai întâi intră într-o cameră (Join).'); return; }
    if (!('geolocation' in navigator)) { alert('Browserul nu are Geolocation.'); return; }
    if (watchId) return;

    watchId = navigator.geolocation.watchPosition(async pos => {
        const { latitude, longitude, accuracy } = pos.coords;
        const now = new Date().toISOString();
        const nowMs = Date.now();
        if (nowMs - lastSent < 5000) return; // ~o dată la 5s
        lastSent = nowMs;

        const lat = round(latitude, 5);
        const lng = round(longitude, 5);

        const { error } = await supabase
            .from('locations')
            .upsert({
                room_id: roomId,
                user_id: currentUser.id,
                name: currentUser.email,
                lat, lng, acc: Math.round(accuracy),
                ts: now
            }, { onConflict: 'room_id,user_id' });

        if (error) { setStatus('share', `Eroare: ${error.message}`); return; }

        upsertMarker(currentUser.id, { lat, lng, name: currentUser.email, ts: now, isSelf: true });
        if (!map._centeredOnce) { map.setView([lat, lng], 15); map._centeredOnce = true; }
        setStatus('share', `Sharing ON (±${Math.round(accuracy)} m)`);
    }, err => {
        setStatus('share', `Eroare geolocație: ${err.message}`);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });

    el.share.textContent = 'Stop sharing';
    el.share.classList.add('danger');
}

function stopSharing() {
    if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    el.share.textContent = 'Start sharing';
    el.share.classList.remove('danger');
    setStatus('share', 'Sharing OFF');
}

el.share.addEventListener('click', () => watchId ? stopSharing() : startSharing());
el.centerMe.addEventListener('click', () => {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(p => map.setView([p.coords.latitude, p.coords.longitude], 15));
});
/* -------------------- MACARENA HOTFIX PACK -------------------- */
/* Nu atinge codul tău. Rulează doar dacă nu e deja inițializat.  */
(() => {
    if (window.__MACARENA_HOTFIX__) return;
    window.__MACARENA_HOTFIX__ = true;

    // ---------- DOM helpers ----------
    const $ = (sel) => document.querySelector(sel);
    const on = (el, ev, fn) => el && el.addEventListener(ev, fn, { passive: true });

    // ---------- Elemente din UI ----------
    const elRoom = $('#room');
    const elJoin = $('#join');
    const elShare = $('#share');
    const elCenter = $('#centerMe');
    const elRoomLink = $('#roomLink');
    const elRoomStatus = $('#roomStatus');
    const elShareSta = $('#shareStatus');

    // ---------- HARTĂ (reuse dacă există) ----------
    let map = window.__MACARENA_MAP__;
    if (!map) {
        map = L.map('map', { zoomControl: true });
        window.__MACARENA_MAP__ = map;

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        // un loc default rezonabil până aflăm poziția
        map.setView([45.754, 21.226], 13);

        requestAnimationFrame(() => map.invalidateSize());
        window.addEventListener('resize', () => map.invalidateSize());
        document.addEventListener('transitionend', (e) => {
            if (e.target.closest('.panel, .topbar')) map.invalidateSize();
        });
    }

    // ---------- STARE SHARING ----------
    let watchId = null;
    let youMarker = null;
    let youAcc = null;
    let joinedRoom = null;

    // mic util: afișează status jos
    const setRoomStatus = (t) => { if (elRoomStatus) elRoomStatus.textContent = t || ''; };
    const setShareStatus = (t) => { if (elShareSta) elShareSta.textContent = t || ''; };

    // ---------- JOIN ROOM ----------
    function updateInviteLink() {
        if (!elRoomLink) return;
        const url = new URL(location.href);
        url.searchParams.set('room', joinedRoom || '');
        // normalizează spre index fără index.html în URL
        const nice = url.toString().replace(/index\.html(\?|$)/, '$1');
        elRoomLink.textContent = nice;
    }

    function joinRoom(roomName) {
        joinedRoom = (roomName || '').trim();
        if (!joinedRoom) { setRoomStatus(''); updateInviteLink(); return; }
        localStorage.setItem('macarena.room', joinedRoom);
        setRoomStatus(`Camera: ${joinedRoom}`);
        updateInviteLink();
    }

    on(elJoin, 'click', () => joinRoom(elRoom && elRoom.value));

    // auto-complete din ?room= sau din ultimele preferințe
    (function prefillRoom() {
        const sp = new URLSearchParams(location.search);
        const fromUrl = sp.get('room');
        const fromLs = localStorage.getItem('macarena.room');
        const value = fromUrl || fromLs || '';
        if (elRoom && !elRoom.value && value) elRoom.value = value;
        if (value) joinRoom(value);
    })();

    // ---------- CENTER ME ----------
    on(elCenter, 'click', () => {
        if (youMarker) map.setView(youMarker.getLatLng(), Math.max(map.getZoom(), 16), { animate: true });
    });

    // ---------- START/STOP SHARING ----------
    async function startSharing() {
        if (!('geolocation' in navigator)) {
            setShareStatus('Geolocația nu este disponibilă pe acest dispozitiv.');
            return;
        }
        if (watchId !== null) {
            // toggle: STOP
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
            setShareStatus('Sharing oprit.');
            if (elShare) elShare.textContent = 'Start sharing';
            return;
        }
        // START
        setShareStatus('Pornesc sharing-ul… permite accesul la locație.');
        if (elShare) elShare.textContent = 'Stop sharing';

        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude: lat, longitude: lng, accuracy } = pos.coords;

                if (!youMarker) {
                    youMarker = L.marker([lat, lng]).addTo(map);
                    youMarker.bindTooltip('Tu', { permanent: true, direction: 'top', offset: [0, -8] });
                } else {
                    youMarker.setLatLng([lat, lng]);
                }

                if (!youAcc) {
                    youAcc = L.circle([lat, lng], { radius: accuracy, weight: 1, fillOpacity: 0.08 });
                    youAcc.addTo(map);
                } else {
                    youAcc.setLatLng([lat, lng]);
                    youAcc.setRadius(accuracy);
                }

                // centrează prima dată; apoi nu mai forțăm camera
                if (!startSharing._centeredOnce) {
                    startSharing._centeredOnce = true;
                    map.setView([lat, lng], Math.max(map.getZoom(), 16));
                }

                setShareStatus(`Sharing activ • precizie ~${Math.round(accuracy)} m`);
                // TODO: aici putem publica în cameră când conectăm backendul/transportul (Supabase/Ably/WebRTC)
                // publishPosition(joinedRoom, { lat, lng, accuracy, t: Date.now() });
            },
            (err) => {
                const msg = ({
                    1: 'Acces la locație refuzat.',
                    2: 'Poziția este indisponibilă.',
                    3: 'Timeout la obținerea poziției.'
                })[err.code] || 'Eroare necunoscută la geolocalizare.';
                setShareStatus(msg);
                if (elShare) elShare.textContent = 'Start sharing';
                watchId = null;
            },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
        );
    }

    on(elShare, 'click', startSharing);

    // ---------- QUALITY OF LIFE ----------
    // cache-busting simplu: dacă ai probleme cu actualizări din cache, adaugă ?v=DATA pe <script src="./app.js?v=YYYY-MM-DD">
    // elShare/elJoin să aibă aria-pressed corespunzător
    const setPressed = (btn, state) => btn && btn.setAttribute('aria-pressed', state ? 'true' : 'false');
    on(elShare, 'click', () => setPressed(elShare, watchId !== null));

    // expune ptr. debug
    window.__macarena = Object.assign(window.__macarena || {}, {
        joinRoom, startSharing, state: () => ({ joinedRoom, watchId, youMarker: !!youMarker })
    });
})();
