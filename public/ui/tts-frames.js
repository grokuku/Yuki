/**
 * Décodage des trames binaires TTS `YTA1` (Lot 7, §4.5) — côté CLIENT.
 *
 * L'UI est vanilla, servie statiquement : elle ne peut PAS importer le code
 * serveur (`src/tts/framing.ts`). Ce module est donc le miroir JS du décodeur
 * serveur : même contrat, même robustesse.
 *
 * Format :
 * ```
 * ┌────────────┬──────────────────┬─────────────────────────┬────────────────────────┐
 * │ magic (4)  │ headerLen (4)    │ header JSON (UTF-8)     │ payload PCM (n octets) │
 * │ "YTA1"     │ u32 big-endian   │ { …métadonnées… }       │ s16le, mono            │
 * └────────────┴──────────────────┴─────────────────────────┴────────────────────────┘
 * ```
 *
 * Le décodeur est **défensif** : toute trame malformée (magic absent, en-tête
 * tronqué, JSON illisible, longueur incohérente, type inconnu) renvoie `null`.
 * Il **ne lève jamais** : une trame inattendue est simplement ignorée.
 *
 * Aucun style, aucune dépendance : module pur, testable sans navigateur.
 */

/** Magic d'identification de la trame (« Yuki TTS Audio v1 »). */
export const TTS_FRAME_MAGIC = "YTA1";
/** Taille de l'en-tête de framing : magic (4) + headerLen (4). */
export const TTS_FRAME_PREFIX_BYTES = 8;
/** Codec audio transporté (PCM signé 16 bits little-endian, mono). */
export const TTS_FRAME_CODEC = "pcm_s16le";

const FRAME_TYPES = new Set(["tts_audio", "tts_end", "tts_cancel"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/** Convertit une entrée (`ArrayBuffer`, `Uint8Array`, vue) en `Uint8Array`, sinon `null`. */
function toBytes(input) {
  try {
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Décode une trame binaire `YTA1`.
 *
 * @param {ArrayBuffer|Uint8Array|ArrayBufferView} input
 * @returns {{ header: object, payload: Uint8Array } | null}
 *   `null` si la trame est invalide (jamais d'exception).
 */
export function decodeTtsFrame(input) {
  const bytes = toBytes(input);
  if (!bytes || bytes.byteLength < TTS_FRAME_PREFIX_BYTES) return null;

  // Magic ASCII « YTA1 ».
  if (
    bytes[0] !== 0x59 || // Y
    bytes[1] !== 0x54 || // T
    bytes[2] !== 0x41 || // A
    bytes[3] !== 0x31 // 1
  ) {
    return null;
  }

  // headerLen : u32 big-endian.
  const headerLen =
    ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  if (headerLen <= 0 || TTS_FRAME_PREFIX_BYTES + headerLen > bytes.byteLength) {
    return null;
  }

  let json;
  try {
    json = new TextDecoder("utf-8").decode(
      bytes.subarray(
        TTS_FRAME_PREFIX_BYTES,
        TTS_FRAME_PREFIX_BYTES + headerLen,
      ),
    );
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const type = parsed.type;
  if (typeof type !== "string" || !FRAME_TYPES.has(type)) return null;

  const payload = bytes.subarray(TTS_FRAME_PREFIX_BYTES + headerLen);
  const header = {
    v: asInt(parsed.v, 1),
    type,
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
    runId: typeof parsed.runId === "string" ? parsed.runId : "",
    segmentIndex: asInt(parsed.segmentIndex, 0),
    chunkIndex: asInt(parsed.chunkIndex, 0),
    codec: typeof parsed.codec === "string" ? parsed.codec : TTS_FRAME_CODEC,
    sampleRate: asInt(parsed.sampleRate, 0),
    channels: asInt(parsed.channels, 1),
    byteLength: asInt(parsed.byteLength, payload.byteLength),
    final: parsed.final === true,
  };
  // Cohérence longueur : le serveur rejette déjà, on rejette de même pour ne
  // jamais décoder un payload tronqué.
  if (header.byteLength !== payload.byteLength) return null;

  return { header, payload };
}
