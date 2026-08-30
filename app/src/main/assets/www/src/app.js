// src/app.js
// orcessa orchestration.
//
// 1. Boot Orca's editor into #orca-host (vendored, unmodified).
// 2. On the "Click to start" gesture: boot SpessaSynth and install the MIDI
//    shim as Orca's output device, so every byte Orca produces is routed to
//    the synth in-page (no Web MIDI hardware).
// 3. Wire tab switching, the soundfont loader, and the 16-channel patch mixer.

import { synthInstance as synth } from "./synth.js";

// ---- Orca bootstrap -------------------------------------------------------

// Orca's scripts attach globals (Client, etc.) to window. Upstream's bootstrap
// does `const client = new Client(); client.install(document.body); client.start()`.
// We do the same but into a dedicated host and expose the instance globally so
// we can reach into client.io.midi to install the shim.
const orcaHost = document.getElementById("orca-host");
const client = new Client(); // eslint-disable-line no-undef
client.install(orcaHost);
client.start();
window.client = client;

// ---- Orca layout / cursor fixes -------------------------------------------
//
// Orca was built to fill the whole window: resize() sizes the canvas from
// window.innerWidth/innerHeight and cursor.mousePick() maps clicks with a
// hardcoded 30px offset. Inside orcessa the editor lives in a panel that is
// smaller than the window (the tab bar + toolbar sit above it, and on Android
// system-bar insets pad the WebView). That mismatch caused three symptoms:
//   1) the canvas overflowed its panel so the status row at the bottom was cut
//      off ("can't see below Orca status outputs");
//   2) cells looked tiny / too zoomed-out (default tile is only 10×15 px);
//   3) taps landed ~2 cells away from the cursor because the click→cell math
//      used the wrong origin and ignored Orca's per-row line spacing
//      (canvas CSS height = (tile.h + tile.h/5) * rows, i.e. 1.2× tile.h/row).
//
// We fix all three without editing vendored Orca source: bump the default tile
// size for readability, override resize() to size the canvas to the HOST
// element (not the window), and override mousePick() to invert the canvas's
// real bounding box.

// (1) Bigger default tile size so the grid is readable. Orca's default is only
// 10×15 px which is too small to read. We raise the floor to 16×22 — this never
// shrinks a user's explicitly-larger preference (Math.max), but guarantees a
// readable minimum. (We can't just check localStorage, because Orca's own
// modZoom() writes the default 10×15 back to localStorage during start().)
client.tile.w = Math.max(client.tile.w, 16);
client.tile.h = Math.max(client.tile.h, 22);
client.tile.ws = Math.floor(client.tile.w * client.scale);
client.tile.hs = Math.floor(client.tile.h * client.scale);

// (2) Override resize() to read the host panel's dimensions instead of the
// full window. Logic mirrors the original but uses orcaHost.clientWidth/Height
// and — critically — sizes rows by their REAL rendered height. Orca draws each
// row at tile.h * 1.2 CSS px (it adds tile.h/5 of line spacing per row), so
// dividing the available height by tile.h (as the original does) produces ~20%
// too many rows and the canvas overflows its panel, cutting off the status line.
client.resize = function () {
  const pad = 8; // small inset so cells aren't flush against the panel edges
  const hostW = orcaHost.clientWidth || (window.innerWidth - 20);
  const hostH = orcaHost.clientHeight || (window.innerHeight - 20);
  const renderedRowH = this.tile.h + this.tile.h / 5; // tile.h * 1.2 (line spacing)
  const tiles = {
    w: Math.max(1, Math.floor((hostW - pad * 2) / this.tile.w)),
    // reserve ~2 rendered rows at the bottom for the status output line
    h: Math.max(1, Math.floor((hostH - pad * 2 - renderedRowH * 2) / renderedRowH))
  };
  const bounds = this.orca.bounds();
  if (tiles.w < bounds.w + 1) { tiles.w = bounds.w + 1; }
  if (tiles.h < bounds.h + 1) { tiles.h = bounds.h + 1; }
  this.crop(tiles.w, tiles.h);
  if (this.cursor.x >= tiles.w) { this.cursor.moveTo(tiles.w - 1, this.cursor.y); }
  if (this.cursor.y >= tiles.h) { this.cursor.moveTo(this.cursor.x, tiles.h - 1); }

  // Canvas internal resolution (physical px) and CSS display size. Height
  // includes Orca's per-row line spacing (tile.h/5).
  const w = this.tile.ws * this.orca.w;
  const h = (this.tile.hs + (this.tile.hs / 5)) * this.orca.h;
  if (w === this.el.width && h === this.el.height) { return; }
  this.el.width = w;
  this.el.height = h;
  this.el.style.width = `${Math.ceil(this.tile.w * this.orca.w)}px`;
  this.el.style.height = `${Math.ceil(renderedRowH * this.orca.h)}px`;
  this.context.textBaseline = "bottom";
  this.context.textAlign = "center";
  this.context.font = `${this.tile.hs * 0.75}px input_mono_medium`;
  this.update();
};

// (3) Override mousePick to invert the canvas's actual on-screen box. Using
// rect.width/orca.w (and rect.height/orca.h) accounts for BOTH the real origin
// AND Orca's per-row line spacing, so clicks map to the right cell regardless
// of toolbar/system-bar offsets or tile size.
client.cursor.mousePick = (x, y) => {
  const rect = client.el.getBoundingClientRect();
  const cellW = rect.width / client.orca.w;
  const cellH = rect.height / client.orca.h;
  return {
    x: Math.floor((x - rect.left) / cellW),
    y: Math.floor((y - rect.top) / cellH)
  };
};

// Apply the new sizing now and keep it in sync on window resize / panel change.
client.resize();
window.addEventListener("resize", () => { try { client.resize(); } catch (_) {} });

// ---- MIDI bridge ----------------------------------------------------------

/**
 * Install a fake MIDIOutput as Orca's only output device. Orca calls
 * outputDevice().send(byteArray) for every note / CC / pitch-bend / program /
 * clock message. We forward the bytes straight to SpessaSynth, which accepts
 * exactly that format via synth.sendMessage().
 *
 * This covers the polyphonic `:`, monophonic `%`, and CC/PG `!`/`?` operators
 * (MidiCC reads outputDevice() fresh each frame, so it flows through too),
 * plus the all-notes-off and clock methods.
 */
function installMidiShim() {
  const shim = {
    name: "orcessa (SpessaSynth)",
    state: "connected",
    type: "output",
    onstatechange: null,
    send(data, _timestamp) {
      synth.sendMessage(data);
    },
    open() { return Promise.resolve(this); },
    close() { return Promise.resolve(); }
  };
  client.io.midi.outputs = [shim];
  client.io.midi.outputIndex = 0;
  // Suppress Orca's own Web MIDI enumeration so it can't overwrite our shim.
  // - refresh() initiates navigator.requestMIDIAccess().
  // - access() is the .then() callback that REASSIGNS outputs[] and calls
  //   selectOutput(0). If a Web MIDI permission prompt is granted AFTER the
  //   user clicks Start, the pending access() would run and wipe the shim.
  //   No-op both so nothing can steal the output device.
  client.io.midi.refresh = function () { /* orcessa owns the output */ };
  client.io.midi.access = function () { /* orcessa owns the output */ };
  // Belt-and-suspenders: pin outputDevice() so the shim is always returned
  // regardless of what outputs[]/outputIndex become later. Every Orca MIDI
  // caller (trigger, MidiCC.run, allNotesOff, clock methods) reads
  // outputDevice() fresh, so overriding it here is the single most robust fix.
  client.io.midi.outputDevice = function () { return shim; };
  console.info("orcessa", "MIDI bridge installed: Orca -> SpessaSynth");
}

// ---- Start overlay / audio boot ------------------------------------------

const overlay = document.getElementById("start-overlay");
const startButton = document.getElementById("start-button");
const globalStatus = document.getElementById("global-status");
let audioStarted = false;

startButton.addEventListener("click", async () => {
  if (audioStarted) return;
  audioStarted = true;
  startButton.disabled = true;
  startButton.textContent = "Starting…";
  globalStatus.textContent = "Booting synthesizer…";
  globalStatus.className = "status warn";
  try {
    await synth.start();
    installMidiShim();
    overlay.classList.add("hidden");
    globalStatus.textContent = synth.soundFonts.length
      ? "Audio ready"
      : "Audio ready — load a soundfont in the SpessaSynth tab";
    globalStatus.className = "status ok";
  } catch (e) {
    console.error("orcessa: audio boot failed", e);
    audioStarted = false;
    startButton.disabled = false;
    startButton.textContent = "Click to start audio";
    globalStatus.textContent = "Audio failed: " + (e && e.message ? e.message : e);
    globalStatus.className = "status warn";
    alert("Failed to start SpessaSynth:\n" + (e && e.message ? e.message : e) +
          "\n\nCheck the console for details.");
  }
});

// ---- Tab switching --------------------------------------------------------

const tabs = document.querySelectorAll(".tab");
const panels = {
  orca: document.getElementById("panel-orca"),
  synth: document.getElementById("panel-synth")
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const which = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    Object.entries(panels).forEach(([key, panel]) =>
      panel.classList.toggle("active", key === which)
    );
    // Orca reads window size in resize(); nudge it when its panel becomes
    // visible so the canvas fills the host correctly.
    if (which === "orca") {
      requestAnimationFrame(() => { try { client.resize && client.resize(); } catch (_) {} });
    }
  });
});

// ---- Orca toolbar: clear grid + paste from clipboard ----------------------

const orcaClearBtn = document.getElementById("orca-clear");
const orcaPasteBtn = document.getElementById("orca-paste");
const orcaPlayBtn = document.getElementById("orca-play");
const orcaToolMsg = document.getElementById("orca-tool-msg");

// Keep the Play/Pause button label in sync with Orca's clock state.
function syncPlayButton() {
  if (!client || !client.clock) return;
  const playing = !client.clock.isPaused;
  orcaPlayBtn.textContent = playing ? "❚❚ Pause" : "▶ Play";
  orcaPlayBtn.classList.toggle("is-playing", playing);
}

let orcaMsgTimer = 0;
function showOrcaMsg(text, kind = "") {
  orcaToolMsg.textContent = text;
  orcaToolMsg.className = "orca-tool-msg show" + (kind ? " " + kind : "");
  clearTimeout(orcaMsgTimer);
  orcaMsgTimer = setTimeout(() => { orcaToolMsg.className = "orca-tool-msg"; }, 2200);
}

/**
 * Clear the Orca grid. Calls Orca's own client.reset(), which wipes the grid
 * to all '.', resets the cursor + history, and leaves the clock running.
 */
orcaClearBtn.addEventListener("click", () => {
  try {
    client.reset();
    showOrcaMsg("Grid cleared", "ok");
  } catch (e) {
    console.error("clear failed", e);
    showOrcaMsg("Clear failed: " + (e.message || e), "error");
  }
});

/**
 * Play/Pause: toggles Orca's clock (equivalent to pressing Space). Updates the
 * button label to reflect the new state.
 */
orcaPlayBtn.addEventListener("click", () => {
  try {
    client.clock.togglePlay(false);
    syncPlayButton();
  } catch (e) {
    console.error("play/pause failed", e);
  }
});
// Sync once on boot and keep in sync — Orca's clock state can also change via
// the Space key or client.reset(), so poll lightly.
syncPlayButton();
setInterval(syncPlayButton, 250);

/**
 * Load Patch: open a native file picker for .orca / .txt patch files and load
 * the contents into the grid (replacing it). Uses a hidden <input type=file>
 * so we get the OS file dialog. Reading mirrors Orca's own "Open file" path.
 */
const orcaLoadBtn = document.getElementById("orca-load");
const orcaFileInput = document.createElement("input");
orcaFileInput.type = "file";
orcaFileInput.accept = ".orca,.txt,text/plain";
orcaFileInput.style.display = "none";
document.body.appendChild(orcaFileInput);

orcaLoadBtn.addEventListener("click", () => orcaFileInput.click());
orcaFileInput.addEventListener("change", async () => {
  const file = orcaFileInput.files && orcaFileInput.files[0];
  orcaFileInput.value = ""; // allow re-picking the same file later
  if (!file) return;
  try {
    const text = await file.text();
    loadOrcaText(text);
  } catch (e) {
    console.error("load patch failed", e);
    showOrcaMsg("Load failed: " + (e.message || e), "error");
  }
});

/**
 * Paste Orca syntax from the clipboard into the grid.
 *
 * Strategy:
 *   1. navigator.clipboard.readText() (secure context — works on http(s) and
 *      the Android WebView's 127.0.0.1 origin). Requires a user gesture; the
 *      click satisfies that.
 *   2. If the Clipboard API is unavailable or denied (common on Android
 *      WebView, which often doesn't expose clipboard read), show an inline
 *      modal with a <textarea>. The user long-presses the box and uses the
 *      native Paste gesture, then taps "Load into grid". This is the reliable
 *      mobile path — prompt() is awkward on touch and produces a confusing
 *      "clipboard unavailable" message.
 *
 * Loading mirrors Orca's own "Open file" path (client.whenOpen): parse the
 * text into rows, size the grid to fit, orca.load(w, h, s), reset cursor,
 * record history so undo works.
 */
const pasteOverlay = document.getElementById("paste-overlay");
const pasteTextarea = document.getElementById("paste-textarea");
const pasteCancelBtn = document.getElementById("paste-cancel");
const pasteLoadBtn = document.getElementById("paste-load");
const pasteShortcutBtn = document.getElementById("paste-shortcut");

// Isolate the paste modal from Orca's GLOBAL document handlers. Orca binds
// document.onpaste (which reads the clipboard, writes it to the grid, and calls
// preventDefault — so pasted text never reaches the textarea AND lands on the
// grid without the user clicking Load). Orca's keyboard handler likewise
// doesn't ignore focused inputs, so typing would also leak to the grid.
// stopPropagation on the overlay keeps these events inside the modal.
for (const ev of ["paste", "copy", "cut", "keydown", "keyup", "keypress", "input"]) {
  pasteOverlay.addEventListener(ev, (e) => e.stopPropagation());
}

function showPasteModal() {
  pasteTextarea.value = "";
  pasteOverlay.classList.remove("hidden");
  // Focus without popping the keyboard immediately on mobile; user taps to paste.
  setTimeout(() => pasteTextarea.focus(), 50);
}
function hidePasteModal() {
  pasteOverlay.classList.add("hidden");
  pasteTextarea.blur();
}
pasteCancelBtn.addEventListener("click", hidePasteModal);
pasteLoadBtn.addEventListener("click", () => {
  const text = pasteTextarea.value;
  hidePasteModal();
  loadOrcaText(text);
});

pasteShortcutBtn.addEventListener("click", async () => {
  let text = "";
  try {
    // 1. Try the Android bridge (most reliable in our WebView)
    if (window.Android && typeof window.Android.getClipboardText === "function") {
      text = window.Android.getClipboardText();
    }
    // 2. Fallback to standard API if bridge failed or is missing
    if (!text && navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    }
  } catch (e) {
    console.warn("Shortcut paste failed", e);
  }

  if (text) {
    pasteTextarea.value = text;
    pasteTextarea.focus();
  } else {
    showOrcaMsg("Clipboard empty or access denied", "error");
  }
});

orcaPasteBtn.addEventListener("click", async () => {
  let text = "";
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    }
  } catch (e) {
    // Permission denied / unavailable — fall through to the manual modal.
    console.warn("clipboard read failed, showing paste modal", e);
  }

  if (text) {
    loadOrcaText(text);
  } else {
    // Clipboard read unavailable (typical on Android WebView). Show the inline
    // textarea so the user can paste via the native long-press → Paste gesture.
    showPasteModal();
  }
});

/**
 * Load a block of Orca syntax into the grid. Trims, parses rows, resizes the
 * grid to fit, and resets cursor + history. Mirrors client.whenOpen().
 */
function loadOrcaText(text) {
  if (!text || !text.trim()) {
    showOrcaMsg("Nothing to paste", "error");
    return;
  }
  try {
    const trimmed = text.replace(/\r\n/g, "\n").trim();
    const lines = trimmed.split("\n");
    const w = Math.max(...lines.map((l) => l.length));
    const h = lines.length;
    // Pad short lines with '.' (Orca's empty cell) so the rectangle is solid.
    const padded = lines.map((l) => (l + ".".repeat(w)).slice(0, w)).join("\n");

    client.orca.load(w, h, padded);
    client.cursor.reset();
    client.history.reset();
    client.history.record(client.orca.s);
    if (client.resize) client.resize();
    client.update && client.update();
    showOrcaMsg(`Pasted ${w}×${h}`, "ok");
  } catch (e) {
    console.error("paste load failed", e);
    showOrcaMsg("Paste failed: " + (e.message || e), "error");
  }
}

// ---- Soundfont loader -----------------------------------------------------

const sfInput = document.getElementById("sf-file-input");
const sfList = document.getElementById("sf-list");

// ---- Hosted soundfonts (auto-discovered from /soundfonts/) ----------------
//
// Discovery order:
//   1. Try to GET /soundfonts/ and parse the host's directory listing
//      (Apache, Nginx, Python http.server, and S3-style XML).
//   2. If that fails or yields nothing usable, GET /soundfonts/index.json,
//      a static manifest file every host serves reliably.
//
// The local file picker (below) remains available regardless.

const HOSTED_DIR = "soundfonts/";
const hostedSfEl = document.getElementById("hosted-sf");
let hostedSoundfonts = []; // { name, url }[] discovered on the server

/**
 * Try to discover soundfont files hosted under /soundfonts/.
 * Updates `hostedSoundfonts` and re-renders the hosted buttons.
 */
async function discoverHostedSoundfonts() {
  hostedSoundfonts = [];
  // 1) Attempt directory listing.
  try {
    const found = await parseDirectoryListing(HOSTED_DIR);
    if (found.length) hostedSoundfonts = dedupeByName(found);
  } catch (_) { /* fall through to manifest */ }

  // 2) Fall back to a static manifest file.
  if (!hostedSoundfonts.length) {
    try {
      const resp = await fetch(HOSTED_DIR + "index.json", { cache: "no-cache" });
      if (resp.ok) {
        const data = await resp.json();
        const items = Array.isArray(data) ? data : (data.soundfonts || data.files || []);
        hostedSoundfonts = dedupeByName(items.map((e) => ({
          name: e.name || e,
          url: HOSTED_DIR + (e.file || e.filename || e.name || e)
        })));
      }
    } catch (_) { /* no manifest */ }
  }

  renderHostedSf();
}

/** Decode common web-server directory listings into { name, url } entries. */
async function parseDirectoryListing(dirUrl) {
  const resp = await fetch(dirUrl, { cache: "no-cache" });
  if (!resp.ok) return [];
  const ct = resp.headers.get("content-type") || "";
  const body = await resp.text();

  // S3 / CloudFront often return application/xml listings.
  if (ct.includes("xml") || body.trim().startsWith("<ListBucketResult")) {
    return parseS3Listing(body, dirUrl);
  }

  // HTML directory indexes (Apache mod_autoindex, Nginx autoindex,
  // Python http.server, lighttpd): anchor hrefs ending in .sf2/.sf3/.sfogg.
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const raw = m[1];
    // Skip query strings, parent dir, sort links, etc.
    if (/[?&;]/.test(raw) || raw.startsWith("?") || raw === "../" || raw === "..") continue;
    if (!/\.(sf2|sf3|sfogg)([#?]|$)/i.test(raw)) continue;
    const name = decodeURIComponent(raw.split(/[#?]/)[0].split("/").pop());
    const url = new URL(raw, new URL(dirUrl, location.href)).href;
    out.push({ name, url });
  }
  return out;
}

/** Parse an S3-style <ListBucketResult><Contents><Key>…</Key></Contents>… */
function parseS3Listing(xml, dirUrl) {
  const out = [];
  const re = /<Key>([^<]+)<\/Key>/g;
  let m;
  const base = new URL(dirUrl, location.href).href;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1];
    if (!/\.(sf2|sf3|sfogg)$/i.test(key)) continue;
    // S3 keys are full object paths (e.g. "soundfonts/foo.sf2"). Use only the
    // trailing filename and re-resolve against the directory base, otherwise
    // the URL would double-prefix (".../soundfonts/soundfonts/foo.sf2").
    const name = key.split("/").pop();
    const url = new URL(name, base).href;
    out.push({ name, url });
  }
  return out;
}

function dedupeByName(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (it && it.name && !seen.has(it.name)) { seen.add(it.name); out.push(it); }
  }
  return out;
}

// Names of hosted soundfonts currently being fetched+loaded. Tracked so that
// concurrent clicks each show their own per-button "Loading…" state instead of
// one clobbering the whole row.
const inflightHosted = new Set();

/** Load a hosted soundfont by URL into the synth (reuses addSoundFont). */
async function loadHostedSoundfont(entry) {
  if (!synth.ready) {
    alert("Start audio first (click the button if the overlay closed).");
    return;
  }
  // If already loaded by name, or already loading, do nothing.
  if (synth.soundFonts.some((s) => s.name === entry.name)) return;
  if (inflightHosted.has(entry.name)) return;
  inflightHosted.add(entry.name);
  renderHostedSf();
  try {
    const resp = await fetch(entry.url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const buf = await resp.arrayBuffer();
    await synth.addSoundFont(buf, entry.name);
    // synth.onSoundFonts below re-renders, including this button's ✓ state.
  } catch (e) {
    console.error("hosted soundfont load failed", entry, e);
    alert('Could not load "' + entry.name + '":\n' + (e && e.message ? e.message : e));
  } finally {
    inflightHosted.delete(entry.name);
    renderHostedSf();
  }
}

/** Render the hosted-soundfont buttons (one per discovered file). */
function renderHostedSf() {
  hostedSfEl.innerHTML = "";

  if (!hostedSoundfonts.length) {
    const span = document.createElement("span");
    span.className = "sf-empty";
    span.textContent = "No hosted soundfonts found. Drop .sf2/.sf3 into the /soundfonts/ folder (optionally with an index.json), or load from your computer below.";
    hostedSfEl.appendChild(span);
    return;
  }

  const loadedNames = new Set(synth.soundFonts.map((s) => s.name));
  for (const entry of hostedSoundfonts) {
    const isLoaded = loadedNames.has(entry.name);
    const isLoading = inflightHosted.has(entry.name);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hosted-sf-button" + (isLoaded ? " is-loaded" : "");
    btn.disabled = isLoaded || isLoading;

    const nameEl = document.createElement("span");
    nameEl.className = "hosted-name";
    nameEl.textContent = entry.name;
    btn.appendChild(nameEl);

    const tag = document.createElement("span");
    tag.className = "hosted-tag";
    tag.textContent = entry.name.match(/\.sf[23]?ogg$/i) ? "SF3" : "SF2";
    btn.appendChild(tag);

    if (isLoaded) {
      const check = document.createElement("span");
      check.className = "hosted-check";
      check.textContent = "✓ loaded";
      btn.appendChild(check);
    } else if (isLoading) {
      const load = document.createElement("span");
      load.className = "hosted-check";
      load.textContent = "…loading";
      btn.appendChild(load);
    } else {
      btn.addEventListener("click", () => loadHostedSoundfont(entry));
    }
    hostedSfEl.appendChild(btn);
  }
}

// Kick off discovery on load (non-blocking; buttons appear when ready).
// No synth needed for discovery — only loading requires audio to be started.
discoverHostedSoundfonts().catch((e) => {
  console.warn("hosted soundfont discovery failed", e);
  // Write directly into hostedSfEl — hostedSfStatus points at the initial
  // <span>, but renderHostedSf() clears hostedSfEl.innerHTML on success and
  // detaches that span, so writing to it would never be visible.
  hostedSfEl.textContent = "Could not check for hosted soundfonts.";
});

// Re-render hosted buttons when loaded set changes (to toggle ✓ loaded state).
synth.onSoundFonts(() => {
  renderSfList();
  if (hostedSoundfonts.length) renderHostedSf();
});
sfInput.addEventListener("change", async () => {
  if (!synth.ready) {
    alert("Start audio first (click the button if the overlay closed).");
    sfInput.value = "";
    return;
  }
  const files = Array.from(sfInput.files || []);
  sfInput.value = "";
  for (const file of files) {
    const li = renderSfItem({ name: file.name, loading: true });
    sfList.appendChild(li);
    try {
      const buf = await file.arrayBuffer();
      await synth.addSoundFont(buf, file.name);
      // Re-render the whole list from the source of truth once loaded.
      renderSfList();
    } catch (e) {
      console.error("soundfont load failed", e);
      li.classList.remove("loading");
      li.querySelector(".sf-name").textContent = file.name + " (failed: " + (e.message || e) + ")";
      li.style.borderColor = "var(--danger)";
    }
  }
  updateGlobalStatus();
});

function renderSfItem({ name, loading = false, id = null }) {
  const li = document.createElement("li");
  if (loading) li.classList.add("loading");
  const nameEl = document.createElement("span");
  nameEl.className = "sf-name";
  nameEl.textContent = name + (loading ? "  (loading…)" : "");
  li.appendChild(nameEl);

  const badge = document.createElement("span");
  badge.className = "sf-badge";
  badge.textContent = loading ? "…" : "SF2/SF3";
  li.appendChild(badge);

  const remove = document.createElement("button");
  remove.className = "sf-remove";
  remove.textContent = "Remove";
  if (id) {
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await synth.removeSoundFont(id);
        // Pausing Orca on unload gives the "no audio" state the user expects
        // while reconfiguring soundfonts; press Space to resume.
        try { client.clock.stop(); } catch (_) {}
        renderSfList();
        // Force a full channel re-sync so stale patch names/dropdown selections
        // from the removed soundfont clear immediately.
        refreshChannelSelects();
        for (let ch = 0; ch < 16; ch++) syncChannelDisplay(ch);
        updateGlobalStatus();
      } catch (e) {
        remove.disabled = false;
        alert("Could not remove: " + (e && e.message ? e.message : e));
      }
    });
  } else {
    remove.disabled = true;
  }
  li.appendChild(remove);
  return li;
}

function renderSfList() {
  sfList.innerHTML = "";
  if (synth.soundFonts.length === 0) {
    const empty = document.createElement("li");
    const span = document.createElement("span");
    span.className = "sf-empty";
    span.textContent = "No soundfonts loaded yet.";
    empty.appendChild(span);
    sfList.appendChild(empty);
    return;
  }
  for (const sf of synth.soundFonts) {
    sfList.appendChild(renderSfItem({ name: sf.name, id: sf.id }));
  }
}
renderSfList();

// ---- 16-channel patch mixer ----------------------------------------------

const channelsEl = document.getElementById("channels");
const channelRows = []; // { select, nameEl, drumCheck }

function buildChannels() {
  channelsEl.innerHTML = "";
  channelRows.length = 0;
  for (let ch = 0; ch < 16; ch++) {
    const isDrum = ch === 9; // GM drum channel (0-indexed 9 = "channel 10")
    const card = document.createElement("div");
    card.className = "channel";

    const head = document.createElement("div");
    head.className = "ch-head";
    const num = document.createElement("div");
    num.className = "ch-num";
    num.textContent = "Ch " + (ch + 1);
    if (isDrum) {
      const tag = document.createElement("span");
      tag.className = "ch-tag";
      tag.textContent = "Drums";
      num.appendChild(tag);
    }
    head.appendChild(num);

    const nameEl = document.createElement("div");
    nameEl.className = "ch-patch-name";
    nameEl.textContent = "—";
    head.appendChild(nameEl);
    card.appendChild(head);

    const select = document.createElement("select");
    select.disabled = true;
    const emptyOpt = document.createElement("option");
    emptyOpt.textContent = "Load a soundfont first";
    emptyOpt.value = "";
    select.appendChild(emptyOpt);
    select.addEventListener("change", () => {
      const idx = parseInt(select.value, 10);
      if (!isNaN(idx)) synth.assignPresetByIndex(ch, idx);
    });
    card.appendChild(select);

    const drumLabel = document.createElement("label");
    drumLabel.className = "drum";
    const drumCheck = document.createElement("input");
    drumCheck.type = "checkbox";
    drumCheck.checked = isDrum;
    drumCheck.addEventListener("change", () => setDrumChannel(ch, drumCheck.checked));
    drumLabel.appendChild(drumCheck);
    drumLabel.appendChild(document.createTextNode("Drum channel"));
    card.appendChild(drumLabel);

    channelsEl.appendChild(card);
    channelRows[ch] = { select, nameEl, drumCheck, num };
  }
}
buildChannels();

/** Toggle a channel's drum mode. SpessaSynth exposes this per-channel. */
function setDrumChannel(channel, on) {
  if (!synth.synth || !synth.synth.midiChannels[channel]) return;
  const mc = synth.synth.midiChannels[channel];
  // API: setDrums(boolean). Guard across versions.
  if (typeof mc.setDrums === "function") {
    try { mc.setDrums(on); return; } catch (_) {}
  }
  // Fallback: post a system message via the synth (worklet-side setDrums).
  try { synth.synth.callEvent && synth.synth.callEvent("drumchange", { channel, isDrum: on }); } catch (_) {}
}

/** Populate every channel's <select> with the current preset list. */
function refreshChannelSelects() {
  const presets = synth.presets;
  for (let ch = 0; ch < 16; ch++) {
    const row = channelRows[ch];
    if (!row) continue;
    const prev = row.select.value;
    row.select.innerHTML = "";

    // No soundfont loaded (or all unloaded): flush the dropdown entirely.
    if (presets.length === 0) {
      const o = document.createElement("option");
      o.textContent = "Load a soundfont first";
      o.value = "";
      row.select.appendChild(o);
      row.select.disabled = true;
      // Clear the patch-name display too, so it doesn't keep showing a stale patch.
      row.nameEl.textContent = "—";
      continue;
    }

    row.select.disabled = false;
    const placeholder = document.createElement("option");
    placeholder.textContent = "— select patch —";
    placeholder.value = "";
    row.select.appendChild(placeholder);

    // Group presets by soundfont using <optgroup>. With per-soundfont bank
    // offsets, each preset's bank uniquely identifies its source soundfont, so
    // we gather presets by their owning soundfont to keep each soundfont's
    // patches contiguous (the merged preset list may interleave them).
    const multi = synth.soundFonts.length > 1;
    if (multi) {
      // Order soundfonts by their load order (soundFonts array order).
      const bySfName = new Map(); // name -> [{i, p}]
      const orphan = []; // presets with no resolved soundfont
      for (let i = 0; i < presets.length; i++) {
        const p = presets[i];
        const bank = p.bankMSB != null ? p.bankMSB : (p.bank ?? 0);
        const sf = synth.soundfontForBank(bank);
        const key = sf ? sf.name : null;
        if (!key) { orphan.push({ i, p }); continue; }
        if (!bySfName.has(key)) bySfName.set(key, []);
        bySfName.get(key).push({ i, p });
      }
      const emit = (groupLabel, items) => {
        const groupEl = document.createElement("optgroup");
        groupEl.label = groupLabel;
        for (const { i, p } of items) {
          const o = document.createElement("option");
          o.value = String(i);
          const tag = p.isDrum ? " [drums]" : "";
          o.textContent = `${formatPatchName(p)} (prog ${p.program})${tag}`;
          groupEl.appendChild(o);
        }
        row.select.appendChild(groupEl);
      };
      for (const sf of synth.soundFonts) {
        const items = bySfName.get(sf.name);
        if (items && items.length) emit(sf.name, items);
      }
      if (orphan.length) emit("Other", orphan);
    } else {
      for (let i = 0; i < presets.length; i++) {
        const p = presets[i];
        const o = document.createElement("option");
        o.value = String(i);
        const tag = p.isDrum ? " [drums]" : "";
        o.textContent = `${formatPatchName(p)} (prog ${p.program})${tag}`;
        row.select.appendChild(o);
      }
    }

    // Preserve selection if still valid; otherwise clear.
    row.select.value = prev && presets[parseInt(prev, 10)] ? prev : "";
  }
}

function formatPatchName(p) {
  if (!p) return "Unknown";
  return p.name || p.presetName || "Program " + p.program;
}

/** Update a single channel's displayed patch name + select selection. */
function syncChannelDisplay(ch) {
  const row = channelRows[ch];
  if (!row) return;
  const idx = synth.findPresetIndexForChannel(ch);
  row.nameEl.textContent = idx >= 0 ? formatPatchName(synth.presets[idx]) : (synth.channelPatchNames[ch] || "—");
  if (idx >= 0) row.select.value = String(idx);
}

// React to synth events.
synth.onPresets(() => {
  refreshChannelSelects();
  for (let ch = 0; ch < 16; ch++) syncChannelDisplay(ch);
});
synth.onChannelPatch((ch) => syncChannelDisplay(ch));

// ---- helpers --------------------------------------------------------------

function updateGlobalStatus() {
  if (!synth.ready) return;
  const n = synth.soundFonts.length;
  globalStatus.textContent = n
    ? `${n} soundfont${n === 1 ? "" : "s"} loaded`
    : "Audio ready — load a soundfont in the SpessaSynth tab";
  globalStatus.className = "status ok";
}

// If presets were already known before the UI subscribed (not the case on
// fresh load, but safe), render them now.
if (synth.presets.length) refreshChannelSelects();

console.info("orcessa ready. Click 'Start audio' to boot SpessaSynth.");
