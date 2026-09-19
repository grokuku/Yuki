// Faux enfant utilisé par les tests du superviseur (`tests/gateway/supervisor.test.ts`).
// Piloté par variables d'environnement :
//   FAKE_EXIT_CODE : code de sortie (défaut 0) ;
//   FAKE_DELAY_MS  : délai avant sortie (défaut 0) ;
//   FAKE_LABEL     : marqueur écrit au démarrage (défaut "fake-child run").
// Il gère aussi SIGTERM/SIGINT pour vérifier le relais de signal, sans jamais
// tuer le processus de test.

const exitCode = Number(process.env.FAKE_EXIT_CODE ?? 0);
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 0);
const label = process.env.FAKE_LABEL ?? "fake-child run";

// Enregistré AVANT d'écrire le marqueur : quand le superviseur (ou le test)
// observe le marqueur, le handler est forcément installé — pas de course.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    process.stdout.write(`fake-child ${signal}\n`);
    process.exit(0);
  });
}

process.stdout.write(`${label}\n`);

setTimeout(() => process.exit(exitCode), delayMs);
