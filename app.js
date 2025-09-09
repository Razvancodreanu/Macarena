/* =========================
   CONFIG
========================= */
const SUPABASE_URL = "https://ndxjdmkeounxliifpbyw.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5keGpkbWtlb3VueGxpaWZwYnl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTcyNTAxMjcsImV4cCI6MjA3MjgyNjEyN30.tzBnFZiFdPzqlSKiqx6uPMpZvHdSF1D8m7DXQx5E0I4";

// dacă tabelele sunt în schema "macarena", lasă 'macarena'; dacă e în public, pune 'public'
const DB_SCHEMA = "macarena";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

/* =========================
   STATE
========================= */
let map;
let me = null;              // supabase user
let myMarker = null;
let myPath = null;
let myTrailLayer = null;
let watchId = null;
let saveTimer = null;
let lastPos = null;

let visibility = "global";  // 'global' | 'private'
let currentRoom = "";
const markers = new Map();  // user_id -> Leaflet marker

// SOS hold
const HOLD_MS = 3000;
let holdTimer = null;
let holdInterval = null;
let holdStart = 0;

/* =========================
   UI REFS
========================= */
const $ = (id) => document.getElementById(id);

const ui = {
    // profil
    profilePhoto: $('profilePhoto'),
    profileName: $('profileName'),
    photoInput: $('photoInput'),
    saveProfile: $('saveProfileBtn'),

    // auth
    googleBtn: $('btnGoogle'),
    magicEmail: $('magicEmail'),
    magicBtn: $('btnMagic'),
    phone: $('phoneInput'),
    smsOtpBtn: $('btnSmsOtp'),
    otp: $('otpInput'),
    smsConfirm: $('btnSmsConfirm'),
    signOut: $('btnSignOut'),
    status: $('authStatus'),

    // vizibilitate & room
    visGlobal: $('visGlobal'),
    visPrivate: $('visPrivate'),
    room: $('room'),
    joinBtn: $('btnJoin'),
    leaveBtn: $('btnLeave'),
    inviteLink: $('inviteLink'),
    copyBtn: $('btnCopy'),

    // share
    startBtn: $('btnStart'),
    stopBtn: $('btnStop'),
    centerBtn: $('btnCenter'),

    // alerte
    sosBtn: $('btnSOS'),
    sosCounter: $('sosCounter'),
    checkinBtn: $('btnCheckin'),
    alertSound: $('alertSound'),

    // live
    members: $('members'),

    // traseu
    trailLoad: $('btnTrailLoad'),
    trailClear: $('btnTrailClear'),
};

/* =========================
   MAP
========================= */
function initMap() {
    map = L.map('map', { preferCanvas: true }).setView([45.9432, 24.9668], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(map);

    // centrează pe user dacă permite
    try {
        navigator.geolocation.getCurrentPosition(p => {
            const { latitude: lat, longitude: lng } = p.coords;
            map.setView([lat, lng], 14);
        });
    } catch { }
}

/* =========================
   HELPERS
========================= */
function nowISO() { return new Date().toISOString(); }
function isoHoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }

function normalIcon() {
    return L.icon({
        iconUrl: "https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-blue.png",
        iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34],
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        shadowSize: [41, 41]
    });
}
function alertDivIcon() { return L.divIcon({ className: "marker-alert" }); }

function setMarker(userId, lat, lng, opts = {}) {
    let m = markers.get(userId);
    if (!m) {
        m = L.marker([lat, lng], { icon: normalIcon() }).addTo(map);
        markers.set(userId, m);
    } else {
        m.setLatLng([lat, lng]);
    }
    if (opts.alert) {
        m.setIcon(alertDivIcon());
        if (m._t) clearTimeout(m._t);
        m._t = setTimeout(() => m.setIcon(normalIcon()), 10 * 60 * 1000);
    }
    if (opts.popup) { m.bindPopup(opts.popup).openPopup(); }
    return m;
}

/* =========================
   PROFILE
========================= */
async function ensureProfile(user) {
    const { data } = await sb.schema(DB_SCHEMA).from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!data) {
        await sb.schema(DB_SCHEMA).from('profiles').upsert({ id: user.id, name: "", photo_url: "" });
        return { name: "", photo_url: "" };
    }
    return data;
}
async function saveProfile() {
    if (!me) return;
    const name = ui.profileName.value.trim();
    await sb.schema(DB_SCHEMA).from('profiles').upsert({ id: me.id, name, photo_url: ui.profilePhoto.src || "" });
}
async function uploadPhoto(file) {
    if (!me || !file) return;
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `avatars/${me.id}.${ext}`;
    const { error } = await sb.storage.from('public').upload(path, file, { upsert: true });
    if (!error) {
        const { data } = sb.storage.from('public').getPublicUrl(path);
        ui.profilePhoto.src = data.publicUrl;
        await saveProfile();
    }
}

/* =========================
   AUTH
========================= */
async function refreshAuthUI() {
    const { data: { user } } = await sb.auth.getUser();
    me = user || null;
    if (me) {
        ui.status.textContent = `Autentificat: ${me.email || me.phone || me.id}`;
        const prof = await ensureProfile(me);
        ui.profileName.value = prof.name || "";
        ui.profilePhoto.src = prof.photo_url || "";
    } else {
        ui.status.textContent = 'Neautentificat';
        ui.profileName.value = "";
        ui.profilePhoto.src = "";
    }
}

ui.googleBtn.onclick = async () => {
    await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: location.href.split('#')[0] }
    });
};
ui.magicBtn.onclick = async () => {
    const email = ui.magicEmail.value.trim();
    if (!email) return alert('Introdu email');
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } });
    if (error) alert(error.message); else alert('Ți-am trimis linkul pe email.');
};
ui.smsOtpBtn.onclick = async () => {
    const phone = ui.phone.value.trim();
    if (!phone) return alert('Telefon lipsă (+40...)');
    const { error } = await sb.auth.signInWithOtp({ phone });
    if (error) alert(error.message); else alert('Cod SMS trimis.');
};
ui.smsConfirm.onclick = async () => {
    const phone = ui.phone.value.trim();
    const token = ui.otp.value.trim();
    if (!phone || !token) return alert('Telefon/cod lipsă');
    const { error } = await sb.auth.verifyOtp({ phone, token, type: 'sms' });
    if (error) alert(error.message);
    await refreshAuthUI();
};
ui.signOut.onclick = async () => { await sb.auth.signOut(); await refreshAuthUI(); };

sb.auth.onAuthStateChange(async () => { await refreshAuthUI(); });

ui.photoInput.onchange = (e) => uploadPhoto(e.target.files?.[0]);
ui.saveProfile.onclick = saveProfile;

/* =========================
   VISIBILITY / ROOMS
========================= */
ui.visGlobal.onchange = () => { visibility = 'global'; rebuildInvite(); reloadLocationsView(); };
ui.visPrivate.onchange = () => { visibility = 'private'; rebuildInvite(); reloadLocationsView(); };

ui.joinBtn.onclick = () => {
    currentRoom = ui.room.value.trim();
    rebuildInvite();
    reloadLocationsView();
};
ui.leaveBtn.onclick = () => {
    currentRoom = "";
    rebuildInvite();
    reloadLocationsView();
};
ui.copyBtn.onclick = async () => {
    if (!ui.inviteLink.value) rebuildInvite();
    await navigator.clipboard.writeText(ui.inviteLink.value);
    alert('Link copiat.');
};

function rebuildInvite() {
    if (visibility === 'private' && currentRoom) {
        const url = new URL(location.href);
        url.searchParams.set('room', currentRoom);
        ui.inviteLink.value = url.toString();
    } else {
        ui.inviteLink.value = "";
    }
}

/* =========================
   SHARE LOCATION (5s)
========================= */
ui.startBtn.onclick = () => {
    if (!navigator.geolocation) return alert('Geolocația nu este suportată.');
    if (watchId) return;
    myPath = myPath || L.polyline([], { color: '#4dc4ff', weight: 4 }).addTo(map);

    watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
        enableHighAccuracy: true, maximumAge: 0, timeout: 15000
    });
    saveTimer = setInterval(saveCurrentLocation, 5000);
};
ui.stopBtn.onclick = () => {
    if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
};
ui.centerBtn.onclick = () => {
    if (myMarker) { map.setView(myMarker.getLatLng(), 15); }
};

function onPos(p) {
    const { latitude: lat, longitude: lng, accuracy } = p.coords;
    if (!myMarker) {
        myMarker = L.marker([lat, lng], { icon: normalIcon(), title: 'Eu' }).addTo(map);
        map.setView([lat, lng], 15);
    } else {
        myMarker.setLatLng([lat, lng]);
    }
    if (myPath) myPath.addLatLng([lat, lng]);
    lastPos = { lat, lng, accuracy, at: nowISO() };
}
function onPosErr(e) { console.warn('geo', e); }

async function saveCurrentLocation() {
    if (!me || !lastPos) return;
    const payload = {
        user_id: me.id,
        lat: lastPos.lat,
        lng: lastPos.lng,
        accuracy: lastPos.accuracy ?? null,
        visibility,
        room: visibility === 'private' ? (currentRoom || null) : null,
        created_at: nowISO()
    };
    // salvează în locations + history
    await sb.schema(DB_SCHEMA).from('locations').insert(payload);
    await sb.schema(DB_SCHEMA).from('locations_history').insert(payload);
}

/* =========================
   RELOAD + REALTIME LOCATIONS
========================= */
async function reloadLocationsView() {
    // curăță marker-ele altora (păstrează-l pe al meu)
    for (const [uid, m] of markers) { if (!me || uid !== me.id) { map.removeLayer(m); } }
    const selfMarker = me ? markers.get(me.id) : null;
    markers.clear();
    if (selfMarker) markers.set(me.id, selfMarker);

    let q = sb.schema(DB_SCHEMA).from('locations').select('user_id, lat, lng, visibility, room, created_at');
    if (visibility === 'private') {
        if (!currentRoom) return; else q = q.eq('room', currentRoom);
    } else {
        q = q.is('room', null);
    }
    const { data } = await q.order('created_at', { ascending: false }).limit(200);
    data?.forEach(r => {
        if (me && r.user_id === me.id) return;
        setMarker(r.user_id, r.lat, r.lng);
    });
}

// realtime subscribes
const channel = sb
    .channel('macarena-live')
    .on('postgres_changes', { event: 'INSERT', schema: DB_SCHEMA, table: 'locations' }, payload => {
        const r = payload.new;
        // filtrare vizibilitate
        if (visibility === 'private') {
            if (r.room !== currentRoom) return;
        } else {
            if (r.room !== null) return;
        }
        if (me && r.user_id === me.id) return;
        setMarker(r.user_id, r.lat, r.lng);
    })
    .on('postgres_changes', { event: 'INSERT', schema: DB_SCHEMA, table: 'alerts' }, payload => {
        handleIncomingAlert(payload.new);
    })
    .subscribe();

/* =========================
   TRAIL (24h)
========================= */
ui.trailLoad.onclick = async () => {
    if (!me) return alert('Autentifică-te');
    if (myTrailLayer) { map.removeLayer(myTrailLayer); myTrailLayer = null; }

    let q = sb.schema(DB_SCHEMA).from('locations_history')
        .select('lat,lng,created_at')
        .eq('user_id', me.id)
        .gte('created_at', isoHoursAgo(24))
        .order('created_at', { ascending: true });

    if (visibility === 'private') {
        if (!currentRoom) return alert('Ești pe mod Cameră. Intră într-o cameră.');
        q = q.eq('room', currentRoom);
    } else {
        q = q.is('room', null);
    }

    const { data, error } = await q;
    if (error) { console.warn(error.message); return; }
    if (!data || !data.length) return alert('Nu există puncte în ultimele 24h.');

    const latlngs = data.map(p => [p.lat, p.lng]);
    myTrailLayer = L.polyline(latlngs, { color: '#00d4aa', weight: 4, opacity: .85 }).addTo(map);
    map.fitBounds(myTrailLayer.getBounds(), { padding: [24, 24] });
};
ui.trailClear.onclick = () => {
    if (myTrailLayer) { map.removeLayer(myTrailLayer); myTrailLayer = null; }
};

/* =========================
   ALERTS (SOS & CHECK-IN)
========================= */
async function sendAlert(type) {
    if (!me) return alert('Autentifică-te');
    if (!myMarker) { return alert('Pornește "Start sharing" ca să avem coordonate.'); }
    const { lat, lng } = myMarker.getLatLng();
    const row = {
        user_id: me.id, type,
        lat, lng, visibility,
        room: visibility === 'private' ? (currentRoom || null) : null,
        created_at: nowISO()
    };
    await sb.schema(DB_SCHEMA).from('alerts').insert(row);
}

function handleIncomingAlert(a) {
    // filtrare
    if (visibility === 'private') {
        if (a.room !== currentRoom) return;
    } else {
        if (a.room !== null) return;
    }
    // sunet + marker roșu pulsant
    ui.alertSound.currentTime = 0;
    ui.alertSound.play().catch(() => { });
    setMarker(a.user_id, a.lat, a.lng, { alert: true, popup: `ALERTĂ: ${a.type}` });
}

// SOS: scurt = selector; lung = 3s → SOS
function startHold() {
    if (holdTimer) return;
    holdStart = Date.now();
    ui.sosCounter.classList.remove('hidden');
    updateCountdown();
    holdInterval = setInterval(updateCountdown, 100);
    holdTimer = setTimeout(async () => {
        stopHoldUI();
        await sendAlert('SOS');
    }, HOLD_MS);
}
function stopHoldUI() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
    ui.sosCounter.classList.add('hidden');
}
function updateCountdown() {
    const left = Math.max(0, HOLD_MS - (Date.now() - holdStart));
    const sec = Math.ceil(left / 1000);
    ui.sosCounter.textContent = sec > 0 ? `${sec}` : 'SOS!';
}
function openAlertPicker() {
    const t = prompt('Tip alertă: (Răpire, Amenințare cu cuțit, Viol, Intimidare, Agresiune fizică, Bătaie, Urmăritor dubios, Tentativă furt, Furt, Injurături)');
    if (!t) return;
    sendAlert(t);
}

ui.sosBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startHold(); });
ui.sosBtn.addEventListener('pointerup', (e) => {
    e.preventDefault();
    if (holdTimer) { stopHoldUI(); openAlertPicker(); } // short press
});
ui.sosBtn.addEventListener('pointerleave', () => stopHoldUI());
ui.checkinBtn.onclick = () => sendAlert('Check-in');

/* =========================
   MEMBERS LIST (simplu)
========================= */
async function refreshMembers() {
    let q = sb.schema(DB_SCHEMA).from('locations')
        .select('user_id,created_at,room,visibility')
        .order('created_at', { ascending: false })
        .limit(50);

    if (visibility === 'private') {
        if (!currentRoom) { ui.members.textContent = '-'; return; }
        q = q.eq('room', currentRoom);
    } else {
        q = q.is('room', null);
    }

    const { data } = await q;
    if (!data || !data.length) { ui.members.textContent = '-'; return; }
    const ids = [...new Set(data.map(r => r.user_id))];

    const { data: profs } = await sb.schema(DB_SCHEMA).from('profiles').select('id,name').in('id', ids);
    const nameById = new Map((profs || []).map(p => [p.id, p.name]));

    ui.members.innerHTML = data
        .filter((v, i, a) => a.findIndex(x => x.user_id === v.user_id) === i)
        .map(r => {
            const n = nameById.get(r.user_id) || r.user_id;
            const when = new Date(r.created_at).toLocaleTimeString();
            return `<div>${n} <span class="note">• ${when}</span></div>`;
        }).join('');
}
setInterval(refreshMembers, 8000);

/* =========================
   BOOT
========================= */
function applyRoomFromURL() {
    const room = new URLSearchParams(location.search).get('room');
    if (room) {
        visibility = 'private';
        ui.visPrivate.checked = true;
        currentRoom = room;
        ui.room.value = room;
        rebuildInvite();
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    initMap();
    applyRoomFromURL();
    await refreshAuthUI();
    await reloadLocationsView();
    await refreshMembers();
});
