/**
 * Logger JSON-lines sur stdout.
 *
 * - Un objet JSON par ligne, jamais de sortie multi-ligne.
 * - Redaction systématique des secrets : aucune clé d'API ne doit apparaître
 *   en clair, ni dans les clés, ni dans les valeurs (ex. une clé loggée par
 *   erreur dans un message libre est masquée si elle provient de l'environnement).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = "[REDACTED]";

/** Détecte un nom de variable/clé ressemblant à un secret. */
export function isSecretKey(name: string): boolean {
  return /(api[_-]?key|secret|token|password|passwd|credential|authorization|bearer)/i.test(
    name,
  );
}

/**
 * Collecte, depuis l'environnement, les valeurs des variables dont le nom
 * ressemble à un secret. Ces valeurs sont ensuite masquées partout.
 */
export function collectSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 6 && isSecretKey(key)) {
      values.add(value);
    }
  }
  return [...values];
}

function redactValue(value: unknown, secretValues: string[]): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const secret of secretValues) {
      if (out.includes(secret)) {
        out = out.split(secret).join(REDACTED);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secretValues));
  }
  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>, secretValues);
  }
  return value;
}

function redactObject(
  source: Record<string, unknown>,
  secretValues: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isSecretKey(key)) {
      out[key] = value === undefined || value === null ? value : REDACTED;
    } else {
      out[key] = redactValue(value, secretValues);
    }
  }
  return out;
}

export interface Logger {
  level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(boundFields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink injectable (tests). Par défaut : process.stdout. */
  sink?: (line: string) => void;
  /** Champs liés à toutes les lignes. */
  fields?: Record<string, unknown>;
  /** Valeurs à masquer. Par défaut : déduites de process.env. */
  secretValues?: string[];
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const secretValues = options.secretValues ?? collectSecretValues();
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const boundFields = options.fields ?? {};

  const emit = (
    entryLevel: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (LEVEL_WEIGHT[entryLevel] < LEVEL_WEIGHT[level]) return;
    const merged = { ...boundFields, ...(fields ?? {}) };
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...(redactObject(merged, secretValues) as Record<string, unknown>),
    };
    sink(JSON.stringify(record));
  };

  return {
    level,
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (childFields) =>
      createLogger({
        level,
        sink,
        fields: { ...boundFields, ...childFields },
        secretValues,
      }),
  };
}
