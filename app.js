/* ================== CONFIG ================== */
const SUPABASE_URL = "https://ndxjdmkeounxliifpbyw.supabase.co";
const SUPABASE_ANON = "sb_publishable_7k4uMzyb2t3LNeHSF8WBQ_bLZB4KNc"; // publishable
const DB_SCHEMA = "macarena"; // <- dacă ai alt schema, schimbă aici (ex: "public")

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

/* ================== STATE ================== */
let map, me = null, markers = new Map(), trailLayer = null;
let watchId = null;
let currentRoom = null;
let visMode = "global"; // "global" | "room"
let myProfile = { name: "", photo_url: "" };

const HOLD_MS = 3000;           // 3 secunde pentru SOS instant
const ALERT_PULSE_MS = 10 * 60 * 1000; // 10 minute
const TRAIL_LOOKBACK_H = 24;

let holdTimer = null;
let holdInterval = null;
let holdStartTs = 0;

/* ================== UI ================== */
const els = {
    profilePhoto: document.getElementById("profilePhoto"),
    profileName: document.getElementById("profileName"),
    photoInput: document.getElementById("photoInput"),
    saveProfile: document.getElementById("saveProfileBtn"),

    authStatus: document.getElementById("authStatus"),
    googleBtn: document.getElementById("googleBtn"),
    magicBtn: document.getElementById("magicBtn"),
    phoneInput: document.getElementById("phoneInput"),
    phoneOtpBtn: document.getElementById("phoneOtpBtn"),
    otpInput: document.getElementById("otpInput"),
    confirmOtp: document.getElementById("confirmOtpBtn"),
    signOut: document.getElementById("signOutBtn"),

    visRadios: document.querySelectorAll('input[name="visMode"]'),
    roomBlock: document.getElementById("roomBlock"),
    roomInput: document.getElementById("roomInput"),
    joinBtn: document.getElementById("joinBtn"),
    leaveBtn: document.getElementById("leaveBtn"),
    copyMagic: document.getElementById("copyMagicLinkBtn"),
    inviteLink: document.getElementById("inviteLink"),

    startBtn: document.getElementById("startBtn"),
    stopBtn: document.getElementById("stopBtn"),

    sosBtn: document.getElementById("sosBtn"),
    sosCountdown: document.getElementById("sosCountdown"),
    checkinBtn: document.getElementById("checkinBtn"),
    membersList: document.getElementById("membersList"),

    alertModal: document.getElementById("alertModal"),
    alertSelect: document.getElementById("alertTypeSelect"),
    sendAlert: document.getElementById("sendAlertBtn"),

    incomingModal: document.getElementById("incomingAlertModal"),
    iaPhoto: document.getElementById("iaPhoto"),
    iaName: document.getElementById("iaName"),
    iaType: document.getElementById("iaType"),
    iaCoords: document.getElementById("iaCoords"),
    centerOnAlert: document.getElementById("centerOnAlertBtn"),

    loadTrail: document.getElementById("loadTrailBtn"),
    clearTrail: document.getElementById("clearTrailBtn"),

    alertSound: document.getElementById("alertSound"),
};

/* ================== MAP ================== */
function initMap() {
    map = L.map('map').setView([45.75, 21.23], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(map);
}
initMap();

/* ================== HELPERS ================== */
function toast(msg) { console.log('[UI]', msg); }
function nowISO() { return new Date().toISOString(); }
function isoHoursAgo(h) { return new Date(Date.now() - h * 3600 * 1000).toISOString(); }

function makeNormalIcon() {
    return L.icon({
        iconUrl: "https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-blue.png",
        iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34],
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        shadowSize: [41, 41]
    });
}
function makeAlertDivIcon() { return L.divIcon({ className: "marker-alert" }); }

function setMarker(userId, lat, lng, opts = {}) {
    let m = markers.get(userId);
    if (!m) {
        m = L.marker([lat, lng], { icon: makeNormalIcon() }).addTo(map);
        markers.set(userId, m);
    } else m.setLatLng([lat, lng]);

    if (opts.alert) {
        m.setIcon(makeAlertDivIcon());
        if (m._alertTimeout) clearTimeout(m._alertTimeout);
        m._alertTimeout = setTimeout(() => m.setIcon(makeNormalIcon()), ALERT_PULSE_MS);
    }
    if (opts.popup) { m.bindPopup(opts.popup).openPopup(); }
    return m;
}

async function ensureProfile(user) {
    const { data } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!data) {
        await sb.from('profiles').upsert({ id: user.id, name: "", photo_url: "" });
        return { name: "", photo_url: "" };
    }
    return data;
}

async function uploadPhoto(file) {
    if (!me) return;
    const ext = file.name.split('.').pop();
    const path = `avatars/${me.id}.${ext}`;
    const { error } = await sb.storage.from('public').upload(path, file, { upsert: true });
    if (!error) {
        const { data } = sb.storage.from('public').getPublicUrl(path);
        myProfile.photo_url = data.publicUrl;
        els.profilePhoto.src = myProfile.photo_url;
        await saveProfile();
    }
}

async function saveProfile() {
    if (!me) return;
    myProfile.name = els.profileName.value.trim();
    await sb.from('profiles').upsert({ id: me.id, name: myProfile.name, photo_url: myProfile.photo_url || "" });
    toast('Profil salvat.');
}

/* ================== AUTH ================== */
async function refreshAuthUI() {
    const { data: { user } } = await sb.auth.getUser();
    me = user;
    if (me) {
        els.authStatus.textContent = `Autentificat ca: ${me.email || me.phone || me.id}`;
        myProfile = await ensureProfile(me);
        els.profileName.value = myProfile.name || "";
        els.profilePhoto.src = myProfile.photo_url || "";
    } else {
        els.authStatus.textContent = "Neautentificat";
        myProfile = { name: "", photo_url: "" };
        els.profileName.value = ""; els.profilePhoto.src = "";
    }
}

els.googleBtn.onclick = async () => {
    await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: location.href.split('#')[0] }
    });
};
els.magicBtn.onclick = async () => {
    const email = prompt("Email pentru magic link:");
    if (!email) return;
    await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } });
    toast('Magic link trimis.');
};
els.phoneOtpBtn.onclick = async () => {
    const phone = els.phoneInput.value.trim();
    if (!phone) return alert('Introduceți telefonul cu +40...');
    await sb.auth.signInWithOtp({ phone });
    toast('Cod SMS trimis.');
};
els.confirmOtp.onclick = async () => {
    const phone = els.phoneInput.value.trim();
    const token = els.otpInput.value.trim();
    if (!phone || !token) return;
    await sb.auth.verifyOtp({ phone, token, type: 'sms' });
    await refreshAuthUI();
};
els.signOut.onclick = async () => {
    await sb.auth.signOut(); await refreshAuthUI();
};

sb.auth.onAuthStateChange(async () => { await refreshAuthUI(); });

els.photoInput.onchange = (e) => e.target.files[0] && uploadPhoto(e.target.files[0]);
els.saveProfile.onclick = saveProfile;

/* ================== MODE: GLOBAL / ROOM ================== */
els.visRadios.forEach(r => {
    r.onchange = () => {
        visMode = document.querySelector('input[name="visMode"]:checked').value;
        els.roomBlock.classList.toggle('hidden', visMode !== 'room');
        if (visMode === 'global') currentRoom = null;
        reloadLocationsView();
    };
});

els.joinBtn.onclick = async () => {
    if (!me) return alert('Autentificare necesară.');
    const room = els.roomInput.value.trim();
    if (!room) return;
    currentRoom = room;
    els.inviteLink.value = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
    toast(`Ai intrat în camera ${room}`);
    reloadLocationsView();
};
els.leaveBtn.onclick = () => { currentRoom = null; reloadLocationsView(); };
els.copyMagic.onclick = async () => {
    const link = els.inviteLink.value || `${location.origin}${location.pathname}?room=${encodeURIComponent(els.roomInput.value.trim() || '')}`;
    await navigator.clipboard.writeText(link);
    toast('Link copiat.');
};

/* ================== SHARE LOCATION ================== */
els.startBtn.onclick = async () => {
    if (!me) return alert('Autentificare necesară.');
    if (!navigator.geolocation) return alert('Geolocation indisponibil.');
    if (watchId) return;

    watchId = navigator.geolocation.watchPosition(async pos => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        await upsertLocation(lat, lng, accuracy);
        setMarker(me.id, lat, lng, { popup: myProfile.name || me.email || me.id });
    }, err => console.warn(err), { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
    toast('Share location ON');
};
els.stopBtn.onclick = () => {
    if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; toast('Share location OFF'); }
};

async function upsertLocation(lat, lng, accuracy) {
    const payload = {
        user_id: me.id, lat, lng, accuracy,
        room: visMode === 'room' ? (currentRoom || null) : null,
        updated_at: nowISO()
    };
    // păstrează ultima locație în `locations`
    await sb.from('locations').upsert(payload, { onConflict: 'user_id' });
    // salvează în istoric
    await sb.from('locations_history').insert({ ...payload, created_at: nowISO() });
}

/* ================== LOAD + SUBSCRIBE LOCATIONS ================== */
async function reloadLocationsView() {
    // curăță marker-ele altora dar păstrează al meu dacă există
    for (const [uid, m] of markers) {
        if (!me || uid !== me.id) { map.removeLayer(m); }
    }
    markers = me && markers.get(me.id) ? new Map([[me.id, markers.get(me.id)]]) : new Map();

    let q = sb.from('locations').select('user_id, lat, lng, room, updated_at');
    if (visMode === 'room') {
        if (!currentRoom) return; // până intră într-o cameră, nu afișăm
        q = q.eq('room', currentRoom);
    } else {
        q = q.is('room', null);
    }
    const { data } = await q;
    data?.forEach(row => {
        if (me && row.user_id === me.id) return;
        setMarker(row.user_id, row.lat, row.lng);
    });
}

/* realtime changes */
const channel = sb
    .channel('live')
    .on('postgres_changes', { event: 'INSERT', schema: DB_SCHEMA, table: 'locations' }, payload => {
        const row = payload.new;
        if (visMode === 'room') {
            if (row.room !== currentRoom) return;
        } else {
            if (row.room !== null) return;
        }
        if (!me || row.user_id !== me.id) setMarker(row.user_id, row.lat, row.lng);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: DB_SCHEMA, table: 'locations' }, payload => {
        const row = payload.new;
        if (visMode === 'room') {
            if (row.room !== currentRoom) return;
        } else {
            if (row.room !== null) return;
        }
        if (!me || row.user_id !== me.id) setMarker(row.user_id, row.lat, row.lng);
    })
    .on('postgres_changes', { event: 'INSERT', schema: DB_SCHEMA, table: 'alerts' }, payload => {
        handleIncomingAlert(payload.new);
    })
    .subscribe();

/* ================== TRAIL (24h) ================== */
els.loadTrail.onclick = async () => {
    if (!me) return;
    if (trailLayer) { map.removeLayer(trailLayer); trailLayer = null; }
    const filter = {
        user_id: me.id,
        created_at: `gte.${isoHoursAgo(TRAIL_LOOKBACK_H)}`
    };
    let q = sb.from('locations_history').select('lat,lng,created_at').eq('user_id', me.id).gte('created_at', isoHoursAgo(TRAIL_LOOKBACK_H)).order('created_at', { ascending: true });
    if (visMode === 'room' && currentRoom) q = q.eq('room', currentRoom);
    else q = q.is('room', null);

    const { data } = await q;
    if (!data || !data.length) return toast('Nu există puncte în ultimele 24h.');
    const latlngs = data.map(p => [p.lat, p.lng]);
    trailLayer = L.polyline(latlngs, { color: '#60a5fa', weight: 4, opacity: .8 }).addTo(map);
    map.fitBounds(trailLayer.getBounds(), { padding: [30, 30] });
};
els.clearTrail.onclick = () => {
    if (trailLayer) { map.removeLayer(trailLayer); trailLayer = null; }
};

/* ================== ALERTS ================== */
async function sendAlert(type) {
    if (!me) return alert('Autentificare necesară.');
    // ia ultima poziție a mea din `locations`
    const { data: last } = await sb.from('locations').select('lat,lng').eq('user_id', me.id).maybeSingle();
    if (!last) return alert('Pornește întâi "Start sharing" ca să trimitem coordonatele.');
    const row = {
        user_id: me.id,
        type,
        lat: last.lat, lng: last.lng,
        room: visMode === 'room' ? (currentRoom || null) : null,
        created_at: nowISO()
    };
    await sb.from('alerts').insert(row);
    toast(`Alertă ${type} trimisă.`);
}

function handleIncomingAlert(a) {
    // filtrare după vizibilitate
    if (visMode === 'room') {
        if (a.room !== currentRoom) return;
    } else {
        if (a.room !== null) return;
    }
    // marker roșu + popup
    setMarker(a.user_id, a.lat, a.lng, { alert: true, popup: `ALERTĂ: ${a.type}` });
    // pop-up cu datele persoanei
    els.alertSound.currentTime = 0;
    els.alertSound.play().catch(() => { });
    // ia profilul
    sb.from('profiles').select('name,photo_url').eq('id', a.user_id).maybeSingle().then(({ data }) => {
        els.iaName.textContent = data?.name || a.user_id;
        els.iaPhoto.src = data?.photo_url || "";
        els.iaType.textContent = a.type;
        els.iaCoords.textContent = `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`;
        els.centerOnAlert.onclick = (e) => { e.preventDefault(); map.setView([a.lat, a.lng], 16); els.incomingModal.close(); };
        els.incomingModal.showModal();
    });
}

/* Apăsare scurtă -> deschide select alert type */
function openAlertPicker() { els.alertModal.showModal(); }
els.sendAlert.onclick = async (e) => {
    e.preventDefault();
    els.alertModal.close();
    await sendAlert(els.alertSelect.value);
};

/* Apăsare lungă (3 sec) -> SOS instant cu countdown 3..2..1..SOS! */
function startHold() {
    if (holdTimer) return;
    holdStartTs = Date.now();
    els.sosCountdown.classList.remove('hidden');
    updateCountdown(); // imediat

    holdInterval = setInterval(updateCountdown, 100);
    holdTimer = setTimeout(async () => {
        stopHoldUI();
        await sendAlert('SOS');
    }, HOLD_MS);
}
function stopHoldUI() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
    els.sosCountdown.classList.add('hidden');
}
function updateCountdown() {
    const left = Math.max(0, HOLD_MS - (Date.now() - holdStartTs));
    const sec = Math.ceil(left / 1000);
    els.sosCountdown.textContent = sec > 0 ? `${sec}` : 'SOS!';
}

/* suport pointer și touch & mouse */
function attachPressHandlers(btn, onShort) {
    const start = (ev) => { ev.preventDefault(); startHold(); };
    const end = (ev) => {
        ev.preventDefault();
        if (holdTimer) { // s-a eliberat înainte de 3s => short press
            stopHoldUI();
            onShort();
        } else {
            // deja s-a trimis SOS
        }
    };
    btn.addEventListener('pointerdown', start, { passive: false });
    btn.addEventListener('pointerup', end, { passive: false });
    btn.addEventListener('pointerleave', () => stopHoldUI(), { passive: true });
}
attachPressHandlers(els.sosBtn, openAlertPicker);

els.checkinBtn.onclick = () => sendAlert('Check-in');

/* ================== MEMBERS LIST (simplu) ================== */
async function refreshMembersList() {
    let q = sb.from('locations').select('user_id,updated_at').order('updated_at', { ascending: false });
    if (visMode === 'room') {
        if (!currentRoom) { els.membersList.textContent = '-'; return; }
        q = q.eq('room', currentRoom);
    } else q = q.is('room', null);

    const { data } = await q;
    if (!data || !data.length) { els.membersList.textContent = '-'; return; }

    // ia nume din profiles
    const ids = data.map(r => r.user_id);
    const { data: profs } = await sb.from('profiles').select('id,name').in('id', ids);
    const nameById = new Map((profs || []).map(p => [p.id, p.name]));
    els.membersList.innerHTML = data.map(r => {
        const n = nameById.get(r.user_id) || r.user_id;
        return `<div>${n} <span class="muted">· ${new Date(r.updated_at).toLocaleTimeString()}</span></div>`;
    }).join('');
}

/* mici refresh-uri periodice */
setInterval(refreshMembersList, 8000);

/* ================== BOOT ================== */
(async function boot() {
    // pornește pe camera din URL dacă există
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
        visMode = 'room';
        document.querySelector('input[name="visMode"][value="room"]').checked = true;
        els.roomBlock.classList.remove('hidden');
        els.roomInput.value = room;
        currentRoom = room;
        els.inviteLink.value = `${location.origin}${location.pathname}?room=${encodeURIComponent(room)}`;
    }
    await refreshAuthUI();
    await reloadLocationsView();
    await refreshMembersList();
})();
