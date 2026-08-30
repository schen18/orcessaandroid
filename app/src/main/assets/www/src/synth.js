// src/synth.js
// Wrapper around SpessaSynth's WorkletSynthesizer.
//
// Responsibilities:
//   - Create + resume the AudioContext (must follow a user gesture).
//   - Load the AudioWorklet processor and construct the synthesizer.
//   - Add / remove soundfonts via the SoundBankManager.
//   - Track the available preset list (synth.presetList, refreshed via the
//     "presetListChange" event) and notify the UI when it changes.
//   - Assign a patch (bank + program) to a given MIDI channel.
//   - Track per-channel patch names (via the "programChange" event).
//
// The MIDI byte stream itself is fed in from app.js via synth.sendMessage()
// (Orca's output-device shim calls it). This module owns the synth lifecycle,
// not the MIDI routing.

import { WorkletSynthesizer } from "../vendor/spessasynth_lib/index.js";

// Relative URL of the vendored AudioWorklet processor.
const PROCESSOR_URL = "../vendor/spessasynth_lib/spessasynth_processor.min.js";

// Resolve the processor URL relative to this module's location (src/synth.js),
// so it works regardless of where the page is served from.
const MODULE_DIR = import.meta.url.replace(/[^/]*$/, "");
const PROCESSOR_ABS_URL = new URL(PROCESSOR_URL, MODULE_DIR).href;

export class SpressSynth {
  constructor() {
    this.ctx = null;
    this.synth = null;

    // Latest preset list from the synth (MIDIPatchFull[]).
    this.presets = [];

    // soundfonts tracked by the SoundBankManager: { id, bankOffset }[]
    // plus a friendly display name we attach.
    this.soundFonts = []; // { id, name }

    // Per-channel current patch name, indexed 0..15. Updated via programChange.
    this.channelPatchNames = new Array(16).fill("");

    // UI subscribers: called when preset list or soundfont list changes.
    this._onPresets = new Set();
    this._onSoundFonts = new Set();
    this._onChannelPatch = new Set();

    this._nextSfId = 1;
  }

  /** Subscribe to preset-list changes. Returns an unsubscribe fn. */
  onPresets(fn) { this._onPresets.add(fn); return () => this._onPresets.delete(fn); }
  onSoundFonts(fn) { this._onSoundFonts.add(fn); return () => this._onSoundFonts.delete(fn); }
  onChannelPatch(fn) { this._onChannelPatch.add(fn); return () => this._onChannelPatch.delete(fn); }

  /**
   * Boot the synthesizer. MUST be called from a user-gesture handler
   * (so the AudioContext can start unsuspended).
   */
  async start() {
    if (this.synth) return;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();

    // Some browsers start the context suspended; resume on the gesture.
    if (this.ctx.state === "suspended") {
      try { await this.ctx.resume(); } catch (_) { /* ignore */ }
    }

    // Register the AudioWorklet processor before constructing the synth.
    await this.ctx.audioWorklet.addModule(PROCESSOR_ABS_URL);

    await this._createSynth();
  }

  /**
   * Construct a fresh WorkletSynthesizer on the existing AudioContext and wire
   * its events. Used by start() (initial boot) and recreateSynth() (tear down
   * + rebuild to fully clear all soundfonts, since SoundBankManager refuses to
   * delete the last one). The AudioContext and the already-loaded worklet
   * module are reused, so this is cheap.
   */
  async _createSynth() {
    this.synth = new WorkletSynthesizer(this.ctx);
    this.synth.connect(this.ctx.destination);
    await this.synth.isReady;

    // Wire events. SpessaSynth fires these from the audio thread via
    // MessagePort; BasicSynthesizer re-emits them through its eventHandler
    // (addEvent(name, id, cb) / callEventInternal(name, data)). The events we
    // use are pre-registered by the synth's constructor, so addEvent() is safe.

    // presetListChange: the synth pushes the full MIDIPatchFull[] whenever a
    // soundfont is added/removed/reordered.
    this._installEvent("presetListChange", (e) => {
      this.presets = Array.isArray(e) ? [...e] : [];
      this._onPresets.forEach((fn) => fn(this.presets));
    });

    // programChange: fired when any channel's program/bank changes (including
    // our own assignments). Carries the new patch; update the display name.
    this._installEvent("programChange", (e) => {
      if (e && typeof e.channel === "number" && e.channel >= 0 && e.channel < 16) {
        this.channelPatchNames[e.channel] = e.name || this._fallbackPatchName(e);
        this._onChannelPatch.forEach((fn) => fn(e.channel, this.channelPatchNames[e.channel]));
      }
    });
  }

  /**
   * Tear down the current synthesizer and build a fresh one with no soundfonts.
   * This is the ONLY way to truly clear all soundfonts — SoundBankManager
   * refuses to delete the last remaining bank, so removing down to one and
   * then "removing" the last requires rebuilding the synth. Resets presets,
   * the soundfont list, and channel patch names, and notifies all subscribers
   * so the mixer dropdowns fully clear.
   */
  async recreateSynth() {
    if (!this.ctx) return;
    // Tear down the old synth (disconnect + destroy releases the worklet node).
    if (this.synth) {
      try { this.synth.disconnect(); } catch (_) {}
      try { this.synth.destroy && this.synth.destroy(); } catch (_) {}
      this.synth = null;
    }
    this.presets = [];
    this.soundFonts = [];
    this.channelPatchNames = new Array(16).fill("");
    await this._createSynth();
    this._onPresets.forEach((fn) => fn(this.presets));
    this._onSoundFonts.forEach((fn) => fn(this.soundFonts));
    this._onChannelPatch.forEach((fn) => { for (let ch = 0; ch < 16; ch++) fn(ch, ""); });
  }

  /**
   * SpessaSynth's public event subscription helper.
   * Different versions expose slightly different surfaces; try each.
   */
  _installEvent(name, cb) {
    const eh = this.synth && this.synth.eventHandler;
    if (!eh) return;
    // Newest API: addEvent(name, handlerName, callback)
    if (typeof eh.addEvent === "function") {
      try { eh.addEvent(name, "_spressorca_" + name + "_" + Math.random().toString(36).slice(2), cb); return; }
      catch (_) {}
    }
    // Older API: on(name, callback)
    if (typeof this.synth.on === "function") { try { this.synth.on(name, cb); return; } catch (_) {} }
    // Fallback: direct eventHandler.callEvent wiring is not subscribable;
    // poll synth.presetList as a last resort (handled in refreshPresets()).
  }

  _fallbackPatchName(patch) {
    if (!patch) return "";
    const bank = patch.bankMSB ?? patch.bank ?? 0;
    const prog = patch.program ?? 0;
    return `Bank ${bank} / Prog ${prog}`;
  }

  /** Manually re-read the synth's preset list (fallback if events don't fire). */
  refreshPresets() {
    if (!this.synth) return;
    const list = this.synth.presetList;
    if (Array.isArray(list)) {
      this.presets = [...list];
      this._onPresets.forEach((fn) => fn(this.presets));
    }
  }

  /** Is the synthesizer booted? */
  get ready() { return !!this.synth; }

  /**
   * Add a soundfont from an ArrayBuffer (.sf2/.sf3/.sfogg supported).
   * Returns the assigned id.
   *
   * Each loaded soundfont is given a UNIQUE bank offset so that presets from
   * different soundfonts never collide on the same (bank, program) address.
   * The first soundfont gets offset 0 (so a single General MIDI soundfont
   * behaves normally: melodic bank 0, drum bank 128). Each subsequent one is
   * shifted up by 1, so its presets land in distinct banks. This is what makes
   * patch reassignment reliable when more than one soundfont is loaded and
   * while Orca is playing — a patch's (bank, program) uniquely identifies the
   * source soundfont.
   */
  async addSoundFont(arrayBuffer, displayName) {
    if (!this.synth) throw new Error("Synth not started");
    const id = "sf" + (this._nextSfId++);
    const name = displayName || ("Soundfont " + id);
    const bankOffset = this.soundFonts.length; // 0 for the first, 1, 2, … after

    // Snapshot the preset banks already present, so after loading we can record
    // which (now-shifted) banks THIS soundfont produced — used to label presets
    // by soundfont in the mixer dropdown.
    const banksBefore = new Set(this.presets.map((p) => p.bankMSB ?? 0));

    await this.synth.soundBankManager.addSoundBank(arrayBuffer, id, bankOffset);

    // Read the freshly-updated preset list directly (without firing UI events
    // yet) so we can compute this soundfont's bank set and register it BEFORE
    // re-rendering. Otherwise refreshChannelSelects would run with a stale
    // soundFonts list and miss the new soundfont's <optgroup>.
    const fresh = Array.isArray(this.synth.presetList) ? [...this.synth.presetList] : this.presets;
    const bankSet = new Set(
      fresh.map((p) => p.bankMSB ?? 0).filter((b) => !banksBefore.has(b))
    );
    this.soundFonts.push({ id, name, bankOffset, bankSet });

    // NOW update this.presets + notify subscribers, with the new soundfont
    // already registered so grouping/labeling is correct.
    this.refreshPresets();
    this._onSoundFonts.forEach((fn) => fn(this.soundFonts));
    return id;
  }

  /** Return the soundfont entry ({id,name,bankOffset,bankSet}) a preset belongs to, or null. */
  soundfontForBank(bankMSB) {
    const b = bankMSB ?? 0;
    return this.soundFonts.find((sf) => sf.bankSet && sf.bankSet.has(b)) || null;
  }

  /**
   * Remove a soundfont by id.
   *
   *   - If other soundfonts remain: delete via SoundBankManager, then stop audio
   *     and reset channels. The preset list update arrives a moment later via
   *     the `presetListChange` event; we also poll a couple of times as a
   *     fallback so the dropdowns reliably drop the removed soundfont's patches
   *     (the event can lag the delete's resolution).
   *   - If this is the LAST soundfont: SoundBankManager refuses to delete it,
   *     so we rebuild the synth from scratch via recreateSynth() — the only way
   *     to truly clear every soundfont. The mixer dropdowns fully empty.
   */
  async removeSoundFont(id) {
    if (!this.synth) return;

    // Remove from our tracked list FIRST so the "is this the last?" check and
    // any subsequent addSoundFont bankOffset math are correct.
    const remaining = this.soundFonts.filter((s) => s.id !== id);

    if (remaining.length === 0) {
      // Last soundfont: rebuild the synth to fully clear it.
      await this.recreateSynth();
      return;
    }

    // Not the last: delete via the API (this one succeeds), then update state.
    this.soundFonts = remaining;
    try {
      await this.synth.soundBankManager.deleteSoundBank(id);
    } catch (e) {
      console.warn("removeSoundFont:", e);
    }
    // Silence + reset channels so removed-soundfont patches don't keep sounding
    // or stay assigned.
    this.stopAndResetChannels();

    // The preset list is updated asynchronously by the worklet after deletion.
    // refreshPresets() right now may read the pre-deletion list, so poll a few
    // times; the presetListChange event handler will also fire and refresh.
    this.refreshPresets();
    setTimeout(() => this.refreshPresets(), 150);
    setTimeout(() => this.refreshPresets(), 500);

    this._onSoundFonts.forEach((fn) => fn(this.soundFonts));
  }

  /** Silence the synth and reset every channel to a clean default patch. */
  stopAndResetChannels() {
    if (!this.synth) return;
    try { this.synth.stopAll(true); } catch (_) {}
    for (let ch = 0; ch < 16; ch++) {
      this.channelPatchNames[ch] = "";
      try {
        // Bank 0, program 0 — a known melodic default. Drum channels go melodic
        // so they don't keep holding a drum kit that may be gone.
        this.synth.controllerChange(ch, 0, 0);
        this.synth.controllerChange(ch, 32, 0);
        const mc = this.synth.midiChannels && this.synth.midiChannels[ch];
        if (mc && typeof mc.setDrums === "function") { try { mc.setDrums(false); } catch (_) {} }
        this.synth.programChange(ch, 0);
      } catch (_) {}
    }
  }

  /**
   * Assign a preset to a channel by index into this.presets.
   * Sends bank select (CC0 MSB, CC32 LSB) then program change — exactly the
   * sequence Orca's MidiCC `pg` operator emits — so the synth loads the patch.
   */
  assignPresetByIndex(channel, presetIndex) {
    const patch = this.presets[presetIndex];
    if (!patch) return;
    this.assignPatch(channel, patch);
  }

  /**
   * Assign an explicit patch object { bankMSB, bankLSB, program, isDrum } to a
   * channel. Sends bank select (CC0 MSB, CC32 LSB) then program change — the
   * same sequence Orca's MidiCC `pg` operator emits.
   *
   * Drum-aware: SpessaSynth only honors a program change on a channel whose
   * drum-mode matches the preset. If we didn't toggle setDrums, assigning a
   * melodic patch to channel 10 (or a drum kit to a melodic channel) would be
   * silently ignored and the channel would keep its previous patch. So we set
   * the channel's drum flag from patch.isDrum first.
   */
  assignPatch(channel, patch) {
    if (!this.synth) return;
    const ch = channel & 0xf;

    // Toggle drum mode to match the preset. isDrum may be undefined for melodic
    // presets; treat that as false.
    const wantDrums = !!patch.isDrum;
    const mc = this.synth.midiChannels && this.synth.midiChannels[ch];
    if (mc && typeof mc.setDrums === "function") {
      try { mc.setDrums(wantDrums); } catch (_) {}
    }

    // Bank select first (MSB on CC0, LSB on CC32), then program change.
    if (patch.bankMSB != null) this.synth.controllerChange(ch, 0, patch.bankMSB);
    if (patch.bankLSB != null) this.synth.controllerChange(ch, 32, patch.bankLSB);
    this.synth.programChange(ch, patch.program);
  }

  /** Forward raw MIDI bytes to the synth (used by Orca's output shim). */
  sendMessage(bytes) {
    if (this.synth) this.synth.sendMessage(Array.from(bytes));
  }

  /** Find a preset index whose name/bank/program matches a channel's current patch. */
  findPresetIndexForChannel(channel) {
    if (!this.synth) return -1;
    const cur = this.synth.midiChannels && this.synth.midiChannels[channel];
    if (!cur || !cur.patch) return -1;
    const p = cur.patch;
    return this.presets.findIndex((pr) =>
      pr.program === p.program &&
      (pr.bankMSB ?? 0) === (p.bankMSB ?? 0) &&
      (pr.bankLSB ?? 0) === (p.bankLSB ?? 0)
    );
  }
}

export const synthInstance = new SpressSynth();

// Debug/test hook: expose the singleton on window so automated tests (and the
// browser console) can inspect the synth, e.g. to tap its AudioContext with an
// AnalyserNode to verify real audio output. Harmless in production — it's just
// a reference; nothing additional runs.
if (typeof window !== "undefined") {
  window.__spressorca = { synth: synthInstance };
}
