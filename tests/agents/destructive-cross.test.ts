/**
 * PREUVE D'UNICITÉ DE SOURCE Go ↔ TS du matcher destructeur (Lot 4, A5).
 *
 * Le risque visé est SILENCIEUX : deux listes de motifs qui divergent laisseraient
 * passer une commande jugée anodine par un côté et destructrice par l'autre.
 * Ce test prouve :
 *
 *   1. les DEUX camps lisent des OCTETS IDENTIQUES — l'empreinte SHA-256 du
 *      fichier lu par le TypeScript (via `src/agents/destructive.ts`) est
 *      comparée à celle du fichier EMBARQUÉ dans le binaire Go (via
 *      `patterncheck info`) ;
 *   2. les DEUX camps classent IDENTIQUEMENT une batterie de commandes
 *      (destructrices, anodines et cas limites), y compris les identifiants de
 *      motifs retournés.
 *
 * ⚠️ Nécessite Go. Absent ⇒ test SAUTÉ (`describe.skipIf`) — l'aveu est explicite.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  destructivePatternIds,
  evaluateDestructive,
  loadDestructivePatternsSource,
} from "../../src/agents/index.js";

const AGENT_DIR = fileURLToPath(new URL("../../agent/", import.meta.url));
const PATTERNS_PATH = fileURLToPath(
  new URL("../../agent/internal/exec/destructive_patterns.json", import.meta.url),
);

interface GoVerdict {
  command: string;
  destructive: boolean;
  ids: string[];
}

/** Exécute `patterncheck` avec `stdin`, renvoie la dernière ligne JSON. */
function runPatterncheck(args: string[], stdin: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("go", ["run", "./cmd/patterncheck", ...args], {
      cwd: AGENT_DIR,
      env: { ...process.env, GOFLAGS: "-mod=mod" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("patterncheck : délai dépassé"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`patterncheck sortie ${code} : ${stderr}`));
        return;
      }
      const line = stdout.trim().split("\n").pop() as string;
      resolve(line);
    });
    child.stdin.end(stdin);
  });
}

async function goAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("go", ["version"]);
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

const GO = await goAvailable();

/** Batterie partagée : destructrices, anodines, cas limites et obfuscations. */
const BATTERY: string[] = [
  // Destructrices.
  "rm -rf /tmp/x",
  "sudo rm -rf /",
  "cd /tmp && rm -rf build",
  "rm file.txt",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "mkfs.ext4 /dev/sdb1",
  "sudo mkfs /dev/sdc",
  "shutdown -h now",
  "sudo reboot",
  "poweroff",
  "systemctl stop nginx",
  "systemctl disable foo",
  "systemctl mask foo",
  "echo hi > /etc/passwd",
  "echo hi >> /boot/x",
  "echo hi >/etc/hosts",
  "chmod 777 /etc/passwd",
  "chown root:root /usr/bin/x",
  "docker compose down",
  "docker rm -f abc",
  "docker volume rm x",
  "docker system prune -a",
  ":(){ :|:& };:",
  "shred -u /dev/sda",
  "echo x > /dev/sda",
  "git reset --hard HEAD~1",
  "git clean -fd",
  "git push --force origin main",
  "mkswap /dev/sdb1",
  "swapoff -a",
  // Anodines.
  "ls -la",
  "echo bonjour",
  "cat /tmp/x",
  "grep rm fichier.txt",
  'echo "rm -rf /"',
  "echo ok > /tmp/x",
  "docker ps",
  "docker compose up -d",
  "git status",
  "git commit -m 'ok'",
  "pwd",
  "sudo ls /etc",
  "command -v rm",
  "systemctl restart nginx",
  "systemctl status nginx",
  "chmod 644 fichier.txt",
  "echo x > /tmp/sortie.txt",
  // Cas limites / séparateurs.
  "true && rm -rf /tmp/y",
  "false || dd if=/dev/zero of=/dev/sdb",
  "ls\nrm -rf /tmp/z",
  "echo fin",
];

describe.skipIf(!GO)("matcher destructeur — unicité de source Go ↔ TS (A5)", () => {
  it("les deux camps lisent le MÊME fichier (empreinte SHA-256 identique)", async () => {
    const info = JSON.parse(await runPatterncheck(["info"], "")) as {
      version: number;
      count: number;
      ids: string[];
      sha256: string;
    };

    // Empreinte du fichier lu par le TypeScript…
    const tsSource = loadDestructivePatternsSource();
    const tsSha = createHash("sha256").update(tsSource.bytes).digest("hex");
    // … et empreinte des octets embarqués côté Go.
    expect(info.sha256).toBe(tsSha);

    // Le module TS a bien lu le fichier du dépôt, pas une copie.
    expect(tsSource.path).toBe(PATTERNS_PATH);
    expect(readFileSync(PATTERNS_PATH).equals(tsSource.bytes)).toBe(true);

    // Mêmes motifs, dans le même ordre.
    expect(info.ids).toEqual(destructivePatternIds());
    expect(info.count).toBe(destructivePatternIds().length);
  });

  it("les deux camps classent IDENTIQUEMENT la batterie", async () => {
    const raw = await runPatterncheck(["classify"], JSON.stringify(BATTERY));
    const goVerdicts = JSON.parse(raw) as GoVerdict[];
    expect(goVerdicts.length).toBe(BATTERY.length);

    for (let i = 0; i < BATTERY.length; i += 1) {
      const command = BATTERY[i] as string;
      const go = goVerdicts[i] as GoVerdict;
      const ts = evaluateDestructive(command);
      // Le message d'échec nomme la commande fautive (diagnostic utile).
      expect(go.command, `commande ${i}`).toBe(command);
      expect(go.ids, `identifiants pour ${JSON.stringify(command)}`).toEqual(ts.ids);
      expect(go.destructive, `destructif pour ${JSON.stringify(command)}`).toBe(ts.destructive);
    }

    // Le désaccord serait silencieux : on vérifie aussi que la batterie couvre
    // BIEN les deux classes (sinon le test ne prouverait rien).
    expect(goVerdicts.some((v) => v.destructive)).toBe(true);
    expect(goVerdicts.some((v) => !v.destructive)).toBe(true);
  });
});
