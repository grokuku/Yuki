/**
 * Lecture audio TTS côté client — **Web Audio obligatoire** (la CSP de Yuki
 * n'a pas de `media-src`, une balise `<audio src>` est interdite ; §4.4).
 *
 * Ce module isole TOUTE la logique d'ordonnancement et de sortie audio :
 *   - réception des trames `tts_audio` (payload PCM s16le mono) ;
 *   - ordre par `(segmentIndex, chunkIndex)` et enchaînement **sans trou** ;
 *   - **coussin de démarrage** avant le premier son ;
 *   - fin de run (`tts_end`) et **purge barge-in** (`tts_cancel`) ;
 *   - volume (`tts.volume`, 0–100) appliqué via un `GainNode` ;
 *   - `unlock()` = `resume()` du `AudioContext` sur un **geste utilisateur** ;
 *   - extraits WAV (échantillons de voix) via `decodeAudioData`.
 *
 * **Testabilité** : la fabrique d'`AudioContext` est **injectable**
 * (`deps.audioContextFactory`). Aucun global n'est utilisé directement, donc
 * la logique est testable en Node avec une doublure, sans vrai son.
 *
 * Aucune affirmation acoustique : on ne fait que **programmer** des buffers.
 * Le rééchantillonnage éventuel est laissé au navigateur (`AudioBuffer` peut
 * porter une `sampleRate` différente de celle du contexte) — on ne
 * rééchantillonne jamais soi-même (§4.3).
 */

/** Coussin par défaut avant le premier son d'un run (ms). */
export const DEFAULT_STARTUP_CUSHION_MS = 150;
/** Volume par défaut (0–100). */
export const DEFAULT_VOLUME = 100;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function defaultLogger() {
  return {
    debug() {},
    info() {},
    warn(...args) {
      console.warn("[tts]", ...args);
    },
    error(...args) {
      console.error("[tts]", ...args);
    },
  };
}

/** Fabrique par défaut : le vrai `AudioContext` du navigateur (ou `null`). */
function defaultAudioContextFactory() {
  const Ctor =
    typeof window !== "undefined" &&
    (window.AudioContext || window.webkitAudioContext);
  return typeof Ctor === "function" ? new Ctor() : null;
}

/** Décode un PCM s16le (little-endian) dans un `Float32Array` (normalisé). */
function decodePcmS16le(bytes, target) {
  const frames = target.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < frames; i += 1) {
    target[i] = view.getInt16(i * 2, true) / 32768;
  }
  return target;
}

/**
 * @typedef {object} TtsPlayerDeps
 * @property {() => any} [audioContextFactory] Fabrique d'AudioContext (injectable).
 * @property {{debug?:Function,info?:Function,warn?:Function,error?:Function}} [logger]
 * @property {(event: {type:"started"|"aborted", runId:string}) => void} [onEvent]
 *   Remontée d'état de lecture (alimente `ClientMessage.playback`).
 * @property {number} [volume] Volume initial 0–100.
 * @property {number} [startupCushionMs] Coussin de démarrage en ms.
 */

/**
 * Crée un lecteur TTS.
 * @param {TtsPlayerDeps} [deps]
 */
export function createTtsPlayer(deps = {}) {
  const logger = deps.logger ?? defaultLogger();
  const factory = deps.audioContextFactory ?? defaultAudioContextFactory;
  const startupCushionMs = Number.isFinite(deps.startupCushionMs)
    ? Math.max(0, deps.startupCushionMs)
    : DEFAULT_STARTUP_CUSHION_MS;

  let volume = clamp(
    Number.isFinite(deps.volume) ? deps.volume : DEFAULT_VOLUME,
    0,
    100,
  );

  let ctx = null;
  let gain = null;
  let nextStartTime = 0;
  let resumedOnce = false;

  /** Runs en cours, par `runId`. */
  const runs = new Map();
  /** Toutes les sources audio planifiées (streaming + extraits). */
  const activeSources = new Set();

  function emit(event) {
    try {
      deps.onEvent?.(event);
    } catch (error) {
      logger.warn("onEvent a échoué", error);
    }
  }

  /** Crée le contexte (une fois) et le nœud de gain partagé. */
  function ensureContext() {
    if (ctx) return ctx;
    let created = null;
    try {
      created = factory();
    } catch (error) {
      logger.error("Création de l'AudioContext impossible", error);
      created = null;
    }
    if (!created) return null;
    ctx = created;
    if (typeof created.createGain === "function" && created.destination) {
      try {
        gain = created.createGain();
        gain.gain.value = volume / 100;
        gain.connect(created.destination);
      } catch (error) {
        logger.warn("GainNode indisponible", error);
        gain = null;
      }
    }
    return ctx;
  }

  /** Sortie commune : gain si présent, sinon destination. */
  function outputNode(context) {
    return gain ?? context.destination;
  }

  function connectSource(source, context) {
    try {
      source.connect(outputNode(context));
    } catch (error) {
      logger.warn("Connexion de la source impossible", error);
    }
  }

  function getRun(runId) {
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId,
        segments: new Map(),
        nextSegment: 0,
        sampleRate: 0,
        channels: 1,
        started: false,
        finished: false,
        purged: false,
      };
      runs.set(runId, run);
    }
    return run;
  }

  /** Ré-ajuste `nextSegment` si un segment a été perdu (trou toléré, §4.1). */
  function skipLostSegments(run) {
    let advanced = false;
    let guard = 0;
    while (!run.segments.has(run.nextSegment) && guard < 10000) {
      let next = null;
      for (const key of run.segments.keys()) {
        if (key > run.nextSegment && (next === null || key < next)) next = key;
      }
      if (next === null) break;
      logger.warn("Segment audio perdu (trou toléré)", {
        runId: run.runId,
        from: run.nextSegment,
        to: next,
      });
      run.nextSegment = next;
      advanced = true;
      guard += 1;
    }
    return advanced;
  }

  /**
   * Concatène les chunks d'un segment si — et seulement si — ils forment une
   * suite contiguë `0..finalIndex`. Renvoie le PCM complet ou `null`.
   */
  function collectSegment(segment) {
    if (segment.finalIndex === null) return null;
    const total = segment.finalIndex + 1;
    for (let i = 0; i < total; i += 1) {
      if (!segment.chunks.has(i)) return null;
    }
    let byteLength = 0;
    for (let i = 0; i < total; i += 1) {
      byteLength += segment.chunks.get(i).byteLength;
    }
    const merged = new Uint8Array(byteLength);
    let offset = 0;
    for (let i = 0; i < total; i += 1) {
      const chunk = segment.chunks.get(i);
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /** Planifie un segment PCM sur l'horloge du contexte. */
  function scheduleSegment(run, pcm) {
    const frames = pcm.byteLength >> 1;
    if (frames === 0) return;
    if (run.sampleRate <= 0) {
      logger.warn("Segment sans fréquence d'échantillonnage : ignoré", {
        runId: run.runId,
      });
      return;
    }
    const context = ensureContext();
    if (!context) {
      logger.warn("Aucun AudioContext : segment non lu");
      return;
    }
    if (
      typeof context.createBuffer !== "function" ||
      typeof context.createBufferSource !== "function"
    ) {
      logger.warn("AudioContext incomplet : segment non lu");
      return;
    }

    let buffer;
    try {
      buffer = context.createBuffer(1, frames, run.sampleRate);
    } catch (error) {
      logger.warn("Création de l'AudioBuffer impossible", error);
      return;
    }
    const pcmFloat = new Float32Array(frames);
    decodePcmS16le(pcm, pcmFloat);
    if (typeof buffer.copyToChannel === "function") {
      buffer.copyToChannel(pcmFloat, 0);
    } else if (typeof buffer.getChannelData === "function") {
      buffer.getChannelData(0).set(pcmFloat);
    }

    let source;
    try {
      source = context.createBufferSource();
      source.buffer = buffer;
    } catch (error) {
      logger.warn("Création de la source impossible", error);
      return;
    }
    // Marque la source pour que la purge cible le bon run.
    source.__yukiRunId = run.runId;
    connectSource(source, context);

    const now = typeof context.currentTime === "number" ? context.currentTime : 0;
    const cushionSec = startupCushionMs / 1000;
    let when = Math.max(now, nextStartTime);
    if (!run.started) {
      // Coussin de démarrage : évite les micro-coupures sur le premier segment.
      when = Math.max(when, now + cushionSec);
      run.started = true;
      emit({ type: "started", runId: run.runId });
    }

    const duration =
      typeof buffer.duration === "number" && buffer.duration > 0
        ? buffer.duration
        : frames / run.sampleRate;
    nextStartTime = when + duration;

    source.onended = () => {
      activeSources.delete(source);
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
    };

    try {
      source.start(when);
    } catch (error) {
      logger.warn("Démarrage de la source impossible", error);
      activeSources.delete(source);
      return;
    }
    activeSources.add(source);

    // Politique d'autoplay : si le contexte est suspendu, on tente de le
    // reprendre (sans geste, le navigateur peut refuser — `unlock()` reste la
    // voie garantie sur clic).
    if (context.state === "suspended" && typeof context.resume === "function") {
      try {
        const p = context.resume();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  /** Vide la file d'un segment : concatène et planifie tout ce qui est prêt. */
  function drain(run) {
    let progressed = true;
    while (progressed) {
      progressed = skipLostSegments(run);
      const segment = run.segments.get(run.nextSegment);
      if (!segment) break;
      const pcm = collectSegment(segment);
      if (!pcm) break;
      run.segments.delete(run.nextSegment);
      run.nextSegment += 1;
      scheduleSegment(run, pcm);
      progressed = true;
    }
  }

  function enqueue(header, payload) {
    const runId = header.runId ?? "";
    const run = getRun(runId);
    if (run.finished || run.purged) return;

    const segmentIndex = Math.max(0, header.segmentIndex | 0);
    const chunkIndex = Math.max(0, header.chunkIndex | 0);
    const sampleRate = header.sampleRate | 0;
    const channels = Math.max(1, header.channels | 0);

    if (run.sampleRate === 0 && sampleRate > 0) run.sampleRate = sampleRate;
    if (sampleRate > 0 && sampleRate !== run.sampleRate) {
      logger.warn("Fréquence native incohérente sur le run", {
        runId,
        expected: run.sampleRate,
        got: sampleRate,
      });
    }
    if (channels !== 1) {
      logger.warn("Trame multi-canal : lue en mono (contrat s16le mono)", {
        runId,
        channels,
      });
    }

    let segment = run.segments.get(segmentIndex);
    if (!segment) {
      segment = { chunks: new Map(), finalIndex: null };
      run.segments.set(segmentIndex, segment);
    }
    segment.chunks.set(chunkIndex, payload);
    // Le chunk de clôture porte `final: true` et un payload vide.
    if (header.final) segment.finalIndex = chunkIndex;

    drain(run);
  }

  /** Purge des sources d'un ensemble de runs ; renvoie les runs purgés. */
  function purgeRuns(selected) {
    let purgedStarted = false;
    for (const run of selected) {
      if (run.purged) continue;
      run.purged = true;
      run.segments.clear();
      // Arrête les sources appartenant à ce run.
      for (const source of activeSources) {
        if (source.__yukiRunId === run.runId) {
          stopSource(source);
          activeSources.delete(source);
        }
      }
      if (run.started) purgedStarted = true;
    }
    if (activeSources.size === 0) nextStartTime = 0;
    return purgedStarted;
  }

  function stopSource(source) {
    try {
      source.stop(0);
    } catch {
      /* déjà arrêtée */
    }
    try {
      source.disconnect();
    } catch {
      /* ignore */
    }
  }

  function handleFrame(decoded) {
    if (!decoded || typeof decoded !== "object") return;
    const header = decoded.header;
    if (!header || typeof header.type !== "string") return;

    if (header.type === "tts_cancel") {
      cancel(header.runId ?? "");
      return;
    }
    if (header.type === "tts_end") {
      const run = runs.get(header.runId ?? "");
      if (run) run.finished = true;
      return;
    }
    if (header.type === "tts_audio") {
      const payload = decoded.payload;
      if (!payload || typeof payload.byteLength !== "number") return;
      enqueue(header, payload);
    }
  }

  /** Annule un run (ou tous si `runId` est vide) et remonte l'état. */
  function cancel(runId) {
    const selected = [];
    if (runId) {
      const run = runs.get(runId);
      if (run) selected.push(run);
    } else {
      for (const run of runs.values()) selected.push(run);
    }
    const hadStarted = purgeRuns(selected);
    if (hadStarted) emit({ type: "aborted", runId: runId || "" });
  }

  /**
   * Arrêt immédiat de TOUT (streaming + extraits) — utilisé par le bouton Stop
   * et l'envoi d'un nouveau message. Renvoie `true` si une lecture était en
   * cours (pour remonter un seul `playback_aborted`).
   */
  function stopAll() {
    const selected = [];
    let startedRunId = "";
    for (const run of runs.values()) {
      if (run.started && !run.purged) startedRunId = run.runId;
      selected.push(run);
    }
    const hadStarted = purgeRuns(selected);
    for (const source of [...activeSources]) {
      stopSource(source);
      activeSources.delete(source);
    }
    nextStartTime = 0;
    if (hadStarted) emit({ type: "aborted", runId: startedRunId });
    return hadStarted;
  }

  /**
   * `resume()` du contexte sur un geste utilisateur (clic). Renvoie une promesse
   * résolue à `true` si le contexte est utilisable.
   */
  function unlock() {
    const context = ensureContext();
    if (!context) return Promise.resolve(false);
    if (context.state === "suspended" && typeof context.resume === "function") {
      try {
        return Promise.resolve(context.resume())
          .then(() => {
            resumedOnce = true;
            return true;
          })
          .catch(() => false);
      } catch {
        return Promise.resolve(false);
      }
    }
    resumedOnce = true;
    return Promise.resolve(true);
  }

  function setVolume(percent) {
    volume = clamp(Number.isFinite(percent) ? percent : volume, 0, 100);
    if (gain && gain.gain) gain.gain.value = volume / 100;
    return volume;
  }

  /**
   * Joue un extrait WAV (échantillon de voix ou aperçu) par Web Audio.
   * `decodeAudioData` accepte un conteneur WAV — jamais le PCM brut (§4.4).
   * Renvoie une promesse résolue à `true` si la lecture a démarré.
   */
  function playWav(arrayBuffer) {
    const context = ensureContext();
    if (!context) return Promise.resolve(false);
    if (typeof context.decodeAudioData !== "function") {
      return Promise.resolve(false);
    }
    // La copie évite que `decodeAudioData` « neutre » le buffer appelant.
    const data =
      arrayBuffer instanceof ArrayBuffer
        ? arrayBuffer.slice(0)
        : arrayBuffer;
    return Promise.resolve()
      .then(() => context.decodeAudioData(data))
      .then((audioBuffer) => {
        if (!audioBuffer) return false;
        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        source.__yukiSample = true;
        connectSource(source, context);
        source.onended = () => {
          activeSources.delete(source);
          try {
            source.disconnect();
          } catch {
            /* ignore */
          }
        };
        activeSources.add(source);
        source.start();
        return true;
      })
      .catch((error) => {
        logger.warn("Extrait audio illisible", error);
        return false;
      });
  }

  /** Arrête uniquement les extraits (laisse le streaming intact). */
  function stopSamples() {
    for (const source of [...activeSources]) {
      if (source.__yukiSample === true) {
        stopSource(source);
        activeSources.delete(source);
      }
    }
  }

  function dispose() {
    stopAll();
    if (ctx && typeof ctx.close === "function") {
      try {
        const p = ctx.close();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* ignore */
      }
    }
    ctx = null;
    gain = null;
  }

  return {
    handleFrame,
    cancel,
    stopAll,
    stopSamples,
    unlock,
    setVolume,
    playWav,
    dispose,
    get volume() {
      return volume;
    },
    get context() {
      return ctx;
    },
    /** Valeur de gain effectivement appliquée (ou `null` avant création). */
    get gainValue() {
      return gain && gain.gain ? gain.gain.value : null;
    },
    get resumed() {
      return resumedOnce;
    },
  };
}
