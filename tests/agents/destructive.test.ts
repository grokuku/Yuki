/**
 * Tests du classement des commandes destructrices côté Yuki (Lot 4, A5).
 *
 * ⚠️ Ces tests ne RECOPIENT PAS la liste de motifs : ils lisent le fichier
 * unique `agent/internal/exec/destructive_patterns.json` via `src/agents/
 * destructive.ts`. La preuve d'identité avec le Go est faite par
 * `destructive-cross.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  destructivePatternIds,
  destructivePatternsSha256,
  evaluateDestructive,
  isDestructive,
  loadDestructivePatternsSource,
  resolveDestructivePatternsPath,
} from "../../src/agents/index.js";

describe("destructive (A5)", () => {
  it("charge la source unique et la valide", () => {
    const src = loadDestructivePatternsSource();
    expect(src.path).toMatch(/agent[/\\]internal[/\\]exec[/\\]destructive_patterns\.json$/);
    expect(src.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(src.doc.patterns.length).toBeGreaterThanOrEqual(8);
    // Chaque motif est compilable et ancré sur une expression non vide.
    for (const pattern of src.doc.patterns) {
      expect(pattern.id).not.toBe("");
      expect(pattern.regex).not.toBe("");
      expect(() => new RegExp(pattern.regex, pattern.flags)).not.toThrow();
    }
  });

  it("les identifiants sont stables et sans doublon", () => {
    const ids = destructivePatternIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("rm");
    expect(ids).toContain("dd");
    expect(ids).toContain("fork-bomb");
  });

  const destructrices: Array<[string, string]> = [
    ["rm -rf /tmp/x", "rm"],
    ["sudo rm -rf /", "rm"],
    ["cd /tmp && rm -rf build", "rm"],
    ["dd if=/dev/zero of=/dev/sda bs=1M", "dd"],
    ["mkfs.ext4 /dev/sdb1", "mkfs"],
    ["shutdown -h now", "shutdown"],
    ["sudo reboot", "shutdown"],
    ["systemctl stop nginx", "systemctl"],
    ["systemctl disable foo", "systemctl"],
    ["echo hi > /etc/passwd", "redirect-system"],
    ["echo hi >> /boot/x", "redirect-system"],
    ["chmod 777 /etc/passwd", "chmod-system"],
    ["docker compose down", "docker"],
    ["docker rm -f abc", "docker"],
    ["docker volume rm x", "docker"],
    [":(){ :|:& };:", "fork-bomb"],
    ["shred -u /dev/sda", "wipe"],
    ["echo x > /dev/sda", "raw-device"],
    ["git reset --hard HEAD~1", "git-destructive"],
    ["git push --force origin main", "git-destructive"],
    ["mkswap /dev/sdb1", "swap"],
  ];

  it.each(destructrices)("classe « %s » comme destructrice (%s)", (command, id) => {
    const verdict = evaluateDestructive(command);
    expect(verdict.destructive).toBe(true);
    expect(verdict.ids).toContain(id);
  });

  const anodines: string[] = [
    "ls -la",
    "echo bonjour",
    "cat /tmp/x",
    "grep rm fichier.txt",
    'echo "rm -rf /"',
    "echo ok > /tmp/x",
    "docker ps",
    "git status",
    "pwd",
    "sudo ls /etc",
    "command -v rm",
    "systemctl restart nginx",
    "chmod 644 fichier.txt",
  ];

  it.each(anodines)("ne classe pas « %s » comme destructrice", (command) => {
    expect(isDestructive(command)).toBe(false);
    expect(evaluateDestructive(command).ids).toEqual([]);
  });

  it("le résultat est déterministe", () => {
    expect(evaluateDestructive("rm -rf /")).toEqual(evaluateDestructive("rm -rf /"));
  });

  it("l'empreinte est stable", () => {
    expect(destructivePatternsSha256()).toBe(destructivePatternsSha256());
  });

  it("honore la surcharge de chemin et échoue clairement si le fichier manque", () => {
    const override = { YUKI_DESTRUCTIVE_PATTERNS: "/n-existe-pas/patterns.json" };
    expect(resolveDestructivePatternsPath(override)).toBe("/n-existe-pas/patterns.json");
    expect(() => loadDestructivePatternsSource(override)).toThrow(/introuvable/);
  });
});
