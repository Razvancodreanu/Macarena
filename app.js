import { createClient } from "https://cdn.skypack.dev/@supabase/supabase-js@2";

// ========= Supabase config =========
const SUPABASE_URL = "https://ndxjdmkeounxliifpbyw.supabase.co";
const SUPABASE_KEY = "sb_publishable_7k4luMzyb2t3LNeHSF8WBQ_bLZB4KNc";
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ========= UI refs =========
const el = (id) => document.getElementById(id);
const statusEl = el("status");
const roomEl = el("room");
const liveEl = el("live");
const trackEl = el("track");
const alertsEl = el("alerts");

el("join").addEventListener("click", () => joinRoom(roomEl.value.trim()));
el("leave").addEventListener("click", leaveRoom);
el("copyLink").addEventListener("click", copyMagicLink);
el("start").addEventListener("click", startSharing);
el("stop").addEventListener("click", stopSharing);
el("sos").addEventListener("click", () => sendAlert("SOS"));
el("checkin").addEventListener("click", () => sendAlert("CHECKIN"));
el("loadTrack").addEventListener("click", loadLast24h);

// ========= App state =========
let currentRoom = null;
let currentUser = null;
let watchId = null;
let realtimeChannel = null;

// Try autologin with PKCE
(async function initAuth() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href } })
            .catch(() => { }); // dacă ești deja logat, continuă
    }
    const userRes = await supabase.auth.getUser();
    currentUser = userRes.data.user || null;
})();

// Restore room from URL or localStorage
(function initRoomFromURL() {
    const u = new URL(location.href);
    const r = u.searchParams.get("room") || localStorage.getItem("macarena_room") || "";
    if (r) { roomEl.value = r; joinRoom(r); }
})();

// ========= Room handling =========
async function joinRoom(roomId) {
    if (!roomId) { setStatus("Alege un room id (ex: familia)"); return; }
    currentRoom = roomId;
    setStatus(`Camera: ${roomId}`);

    if (el("remember").checked) localStorage.setItem("macarena_room", roomId);

    // subscribe Realtime la locations & alerts (schema macarena)
    await subscribeRealtime(roomId);

    // încarcă lista live inițială
    await refreshLive(roomId);

    // încarcă alerte active (ultimele 20)
    await refreshAlerts(roomId);
}

async function leaveRoom() {
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
    currentRoom = null;
    liveEl.innerHTML = "";
    alertsEl.innerHTML = "";
    setStatus("Părăsit camera.");
}

function copyMagicLink() {
    const r = currentRoom || roomEl.value.trim();
    if (!r) return;
    const u = new URL(location.href);
    u.searchParams.set("room", r);
    navigator.clipboard.writeText(u.toString());
    setStatus("Link copiat.");
}

// ========= Realtime =========
async function subscribeRealtime(roomId) {
    if (realtimeChannel) await supabase.removeChannel(realtimeChannel);

    realtimeChannel = supabase
        .channel(`macarena:${roomId}`)
        .on(
            "postgres_changes",
            { event: "*", schema: "macarena", table: "locations", filter: `room_id=eq.${roomId}` },
            async () => { await refreshLive(roomId); }
        )
        .on(
            "postgres_changes",
            { event: "*", schema: "macarena", table: "alerts", filter: `room_id=eq.${roomId}` },
            async () => { await refreshAlerts(roomId); }
        );

    await realtimeChannel.subscribe((status) => {
        if (status === "SUBSCRIBED") setStatus(`Realtime conectat pentru camera: ${roomId}`);
    });
}

// ========= Live list & alerts =========
async function refreshLive(roomId) {
    const { data, error } = await supabase
        .from("macarena.locations")
        .select("user_id, name, lat, lng, acc, ts")
        .eq("room_id", roomId)
        .order("ts", { ascending: false });
    if (error) return setStatus(`Eroare live: ${error.message}`);

    liveEl.innerHTML = (data || [])
        .map((r) =>
            `<li><strong>${escapeHtml(r.name || shortId(r.user_id))}</strong>
       <span class="muted tiny">@ ${fmtCoord(r.lat, r.lng)} · ±${r.acc ?? "?"}m · ${timeAgo(r.ts)}</span></li>`)
        .join("") || `<li class="muted">nimeni încă...</li>`;
}

async function refreshAlerts(roomId) {
    const { data, error } = await supabase
        .from("macarena.alerts")
        .select("id, user_id, user_email, type, message, lat, lng, active, ts")
        .eq("room_id", roomId)
        .order("ts", { ascending: false })
        .limit(20);
    if (error) return setStatus(`Eroare alerts: ${error.message}`);

    alertsEl.innerHTML = (data || [])
        .map((a) => {
            const cls = a.type === "SOS" ? "danger" : "";
            const where = a.lat && a.lng ? ` · @ ${fmtCoord(a.lat, a.lng)}` : "";
            return `<li>
        <strong class="${cls}">${a.type}</strong>
        <span class="muted tiny">${a.user_email || shortId(a.user_id)}${where} · ${timeAgo(a.ts)}</span>
      </li>`;
        })
        .join("") || `<li class="muted">fără alerte...</li>`;
}

// ========= Share on/off =========
async function startSharing() {
    if (!currentUser) { setStatus("Te rog autentifică-te."); return; }
    if (!currentRoom) { setStatus("Intră într-o cameră mai întâi."); return; }
    if (!("geolocation" in navigator)) { setStatus("Geolocația nu e disponibilă în browser."); return; }

    // Watch position și push în macarena.locations (upsert) + macarena.locations_history (insert)
    let lastSent = 0;
    watchId = navigator.geolocation.watchPosition(async (pos) => {
        const now = Date.now();
        if (now - lastSent < 5000) return; // ~ 5 sec
        lastSent = now;

        const { latitude, longitude, accuracy } = pos.coords;

        const up = await supabase.from("macarena.locations").upsert({
            room_id: currentRoom,
            user_id: currentUser.id,
            name: currentUser.email?.split("@")[0] || "user",
            lat: round(latitude, 6),
            lng: round(longitude, 6),
            acc: Math.round(accuracy ?? 0),
            ts: new Date().toISOString()
        });
        if (up.error) setStatus(`Eroare upsert: ${up.error.message}`);

        const ins = await supabase.from("macarena.locations_history").insert({
            room_id: currentRoom,
            user_id: currentUser.id,
            lat: round(latitude, 6),
            lng: round(longitude, 6),
            acc: Math.round(accuracy ?? 0),
        });
        if (ins.error) setStatus(`Eroare history: ${ins.error.message}`);
    }, (err) => {
        setStatus(`Geo error: ${err.message}`);
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });

    setStatus("Sharing ON");
}

async function stopSharing() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    setStatus("Sharing OFF");
}

// ========= Alerts =========
async function sendAlert(type) {
    if (!currentUser) { setStatus("Nu ești autentificat."); return; }
    if (!currentRoom) { setStatus("Intră într-o cameră mai întâi."); return; }
    if (!["SOS", "CHECKIN", "INFO"].includes(type)) type = "INFO";

    let lat = null, lng = null;
    try {
        const pos = await new Promise((res, rej) =>
            navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 6000 })
        );
        lat = round(pos.coords.latitude, 6);
        lng = round(pos.coords.longitude, 6);
    } catch (_) { }

    const { error } = await supabase.from("macarena.alerts").insert({
        room_id: currentRoom,
        user_id: currentUser.id,
        user_email: currentUser.email || null,
        type,
        message: type === "SOS" ? "Solicit ajutor!" : (type === "CHECKIN" ? "Sunt OK." : null),
        lat, lng
    });
    if (error) return setStatus(`Eroare alertă: ${error.message}`);
    setStatus(`Alertă trimisă: ${type}`);
}

// ========= 24h track =========
async function loadLast24h() {
    if (!currentUser || !currentRoom) return;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from("macarena.locations_history")
        .select("lat, lng, ts")
        .eq("room_id", currentRoom)
        .eq("user_id", currentUser.id)
        .gte("ts", since)
        .order("ts", { ascending: false });

    if (error) return setStatus(`Eroare track: ${error.message}`);

    trackEl.innerHTML = (data || [])
        .map(r => `<li>${fmtCoord(r.lat, r.lng)} · ${timeAgo(r.ts)}</li>`)
        .join("") || `<li class="muted">fără puncte în ultimele 24h...</li>`;
}

// ========= Utils =========
function setStatus(msg) { statusEl.textContent = msg || ""; }
const round = (n, p = 6) => Math.round(n * 10 ** p) / 10 ** p;
const fmtCoord = (lat, lng) => (lat != null && lng != null) ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : "n/a";
const shortId = (s) => (s || "").slice(0, 8);
const escapeHtml = (s = "") => s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
function timeAgo(iso) {
    const sec = (Date.now() - new Date(iso).getTime()) / 1000 | 0;
    if (sec < 60) return `${sec}s`;
    const m = sec / 60 | 0; if (m < 60) return `${m}m`;
    const h = m / 60 | 0; if (h < 24) return `${h}h`;
    const d = h / 24 | 0; return `${d}d`;
}
