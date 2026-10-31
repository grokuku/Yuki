/**
 * Verrou de PUBLICATION — deux règles que la CI doit faire respecter :
 *
 *  1. **UN SEUL numéro de version** pour l'image du gateway ET pour les binaires
 *     de l'agent : `version.txt` (racine). `agent/VERSION` est SUPPRIMÉ — deux
 *     fichiers de version produisent une divergence (0.1.0 côté image vs 0.2.0
 *     côté agent).
 *  2. **UNE SEULE action GitHub** : `release.yml` enchaîne `quality` → `publish`
 *     (image ghcr + bump + push) → `agent-build` (binaires Go) → `release`
 *     (GitHub Release `v<version>`). Le job de release dépend de l'image ET des
 *     binaires, sans `continue-on-error` : jamais de release partielle.
 *
 * ⚠️ Ces tests lisent les workflows comme du TEXTE (aucune dépendance YAML dans
 * le projet). Ils échouent si la structure change de façon incompatible : c'est
 * voulu — la chaîne de publication est un contrat, pas un détail.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RACINE = process.cwd();

function lire(chemin: string): string {
  return readFileSync(join(RACINE, chemin), "utf8");
}

/** Extrait le bloc d'un job (`  <nom>:`) d'un workflow donné, en texte. */
function blocJob(yaml: string, nom: string): string {
  return blocIndente(yaml, `  ${nom}:`, /^ {2}[A-Za-z][A-Za-z0-9_-]*: *$/);
}

/** Extrait un bloc de premier niveau (`on:`, `env:`…) d'un workflow, en texte. */
function blocRacine(yaml: string, nom: string): string {
  return blocIndente(yaml, `${nom}:`, /^[A-Za-z_][A-Za-z0-9_-]*: *$/);
}

function blocIndente(yaml: string, entete: string, motifFin: RegExp): string {
  const lignes = yaml.split("\n");
  const debut = lignes.findIndex((ligne) => ligne === entete);
  if (debut === -1) {
    throw new Error(`bloc « ${entete.trim()} » introuvable dans le workflow`);
  }
  let fin = lignes.length;
  for (let i = debut + 1; i < lignes.length; i += 1) {
    if (motifFin.test(lignes[i] ?? "")) {
      fin = i;
      break;
    }
  }
  return lignes.slice(debut, fin).join("\n");
}

/** Liste récursivement les fichiers d'un répertoire (chemins relatifs). */
function fichiersSous(racineRelative: string): string[] {
  const trouves: string[] = [];
  const parcourir = (relatif: string): void => {
    for (const entree of readdirSync(join(RACINE, relatif))) {
      const chemin = `${relatif}/${entree}`;
      if (statSync(join(RACINE, chemin)).isDirectory()) {
        parcourir(chemin);
      } else {
        trouves.push(chemin);
      }
    }
  };
  parcourir(racineRelative);
  return trouves;
}

describe("version unique (image == agents)", () => {
  it("version.txt est la source unique, au format MAJOR.MINOR.PATCH", () => {
    expect(existsSync("version.txt")).toBe(true);
    expect(lire("version.txt").trim()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
  });

  it("agent/VERSION a disparu (plus de seconde source de vérité)", () => {
    expect(existsSync("agent/VERSION")).toBe(false);
  });

  it("aucun fichier du dépôt ne lit plus agent/VERSION", () => {
    const repertoires = ["agent", ".github", "scripts", "docs", "deploy"];
    const coupables: string[] = [];
    for (const repertoire of repertoires) {
      if (!existsSync(repertoire)) continue;
      for (const chemin of fichiersSous(repertoire)) {
        if (lire(chemin).includes("agent/VERSION")) coupables.push(chemin);
      }
    }
    expect(coupables).toEqual([]);
  });

  it("l'agent injecte la version DEPUIS version.txt (buildinfo.Version)", () => {
    const build = lire(".github/workflows/agent-build.yml");
    // Injection ldflags : la version vient du fichier, jamais d'une constante.
    expect(build).toContain("-X github.com/grokuku/yuki/agent/internal/buildinfo.Version=${VERSION}");
    expect(build).toContain('VERSION="$(tr -d \'[:space:]\' < version.txt)"');
  });
});

describe("release.yml : image + agents + release dans la même action", () => {
  const release = lire(".github/workflows/release.yml");

  it("n'a QUE le déclencheur manuel (aucun push, aucune boucle de bump)", () => {
    const declencheurs = blocRacine(release, "on");
    expect(declencheurs).toContain("workflow_dispatch:");
    expect(declencheurs).not.toMatch(/^ {2}push:/m);
    expect(declencheurs).not.toMatch(/^ {2}pull_request:/m);
    expect(declencheurs).not.toMatch(/tags:/);
  });

  it("enchaîne quality → publish → agent-build → release (ordre du fichier)", () => {
    const iQuality = release.indexOf("  quality:");
    const iPublish = release.indexOf("  publish:");
    const iAgentBuild = release.indexOf("  agent-build:");
    const iRelease = release.indexOf("\n  release:");
    expect(iQuality).toBeGreaterThan(-1);
    expect(iPublish).toBeGreaterThan(iQuality);
    expect(iAgentBuild).toBeGreaterThan(iPublish);
    expect(iRelease).toBeGreaterThan(iAgentBuild);
  });

  it("garde une chaîne `needs:` STRICTE (aucune release partielle)", () => {
    expect(blocJob(release, "publish")).toMatch(/needs: quality/);
    expect(blocJob(release, "agent-build")).toMatch(/needs: publish/);
    const blocRelease = blocJob(release, "release");
    expect(blocRelease).toMatch(/needs: \[publish, agent-build\]/);
    // Le job de release ne « tolère » rien : un échec en amont doit l'empêcher.
    expect(blocRelease).not.toContain("continue-on-error");
  });

  it("réserve contents: write au job de release, packages: write à publish", () => {
    const publish = blocJob(release, "publish");
    expect(publish).toContain("contents: write");
    expect(publish).toContain("packages: write");
    const blocRelease = blocJob(release, "release");
    expect(blocRelease).toContain("contents: write");
    expect(blocRelease).not.toContain("packages: write");
    expect(blocJob(release, "quality")).not.toContain("contents: write");
  });

  it("injecte dans les binaires la version BUMPÉE (pas celle d'avant le push)", () => {
    const agentBuild = blocJob(release, "agent-build");
    expect(agentBuild).toContain("uses: ./.github/workflows/agent-build.yml");
    expect(agentBuild).toContain("version: ${{ needs.publish.outputs.release_version }}");
    expect(blocJob(release, "publish")).toContain(
      "release_version: ${{ steps.version.outputs.next_version }}",
    );
    // Le bump doit précéder le build (un seul numéro pour tout le run)…
    const bump = release.indexOf("name: Increment version.txt");
    const build = release.indexOf("name: Build and push image");
    // …et le push du bump précéder la release (le tag tombe sur le bon commit).
    const push = release.indexOf("name: Commit and push new version");
    expect(bump).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(bump);
    expect(push).toBeGreaterThan(build);
  });

  it("publie le tag v<version> sur le commit de bump, sans jamais écraser", () => {
    const blocRelease = blocJob(release, "release");
    expect(blocRelease).toContain('TAG="v${VERSION}"');
    expect(blocRelease).toContain('--target "${SHA}"');
    expect(blocRelease).toContain('ref: ${{ needs.publish.outputs.release_sha }}');
    // ⚠️ `--clobber` écraserait un asset existant en silence : interdit.
    expect(blocRelease).not.toContain("--clobber");
    // Garde explicite « le tag existe déjà ⇒ incrémentez version.txt ».
    expect(blocRelease).toContain("incrémentez version.txt");
  });

  it("attache les 4 binaires (noms inchangés) + SHA256SUMS + le compose minimal", () => {
    const blocRelease = blocJob(release, "release");
    for (const nom of [
      "yuki-agent-linux-amd64-musl",
      "yuki-agent-linux-arm64-musl",
      "yuki-agent-windows-amd64.exe",
      "yuki-agent-windows-arm64.exe",
    ]) {
      expect(blocRelease).toContain(nom);
    }
    expect(blocRelease).toContain("SHA256SUMS");
    expect(blocRelease).toContain("deploy/minimal/docker-compose.yml");
    // Notes de release : les trois commandes utiles à l'utilisateur.
    expect(blocRelease).toContain("docker compose pull");
    expect(blocRelease).toContain("yuki-agent");
    expect(blocRelease).toContain("docker-compose.yml");
  });

  it("n'utilise plus la famille de tags agent-v…", () => {
    // Les WORKFLOWS ne publient plus que `v<version>`. La doc, elle, explique le
    // sort des anciennes releases (mention légitime, vérifiée plus bas).
    expect(release).not.toContain("agent-v");
    expect(lire(".github/workflows/agent.yml")).not.toContain("agent-v");
    expect(lire(".github/workflows/agent-build.yml")).not.toContain("agent-v");
    // Le runbook donne les commandes à jour : plus de tag `agent-v…`.
    expect(lire("docs/runbook.md")).not.toContain("agent-v");
    expect(lire("docs/runbook.md")).toContain("releases/download/v");
    // …et la doc de publication explique l'historique des anciens tags.
    expect(lire("docs/release.md")).toContain("agent-v<version>");
  });
});

describe("agent.yml : CI autonome conservée, logique de build partagée", () => {
  const agent = lire(".github/workflows/agent.yml");

  it("conserve push / pull_request / workflow_dispatch", () => {
    const declencheurs = blocRacine(agent, "on");
    expect(declencheurs).toMatch(/^ {2}push:$/m);
    expect(declencheurs).toMatch(/^ {2}pull_request:$/m);
    expect(declencheurs).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it("délègue la compilation au workflow réutilisable agent-build.yml", () => {
    expect(blocJob(agent, "agent-build")).toContain("uses: ./.github/workflows/agent-build.yml");
    const build = lire(".github/workflows/agent-build.yml");
    expect(build).toMatch(/^ {2}workflow_call:$/m);
  });

  it("ne crée sa release que sur dispatch manuel (jamais quand release.yml l'appelle)", () => {
    const blocRelease = blocJob(agent, "agent-release");
    expect(blocRelease).toContain("if: github.event_name == 'workflow_dispatch'");
    // Garde par `github.event.inputs` : le contexte `inputs` n'existe pas sur push.
    expect(blocRelease).not.toMatch(/if: inputs\./);
    expect(blocRelease).toContain("incrémentez version.txt");
  });
});
