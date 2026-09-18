/**
 * Types des profils de compatibilité (chargés depuis config/gpu-profiles.json).
 */

export type ProfileStatus = "confirmed" | "to-confirm";

export type Residence = "gpu" | "cpu";

/**
 * Référence symbolique à un modèle : jamais la sémantique du modèle, seulement
 * un identifiant logique résolu par un lot dédié (ASR/TTS).
 */
export interface ModelReference {
  enabled: boolean;
  residence: Residence;
  modelRef: string | null;
  quantizationRef: string | null;
  status: ProfileStatus;
}

export interface GpuProfile {
  id: string;
  label: string;
  rank: number;
  status: ProfileStatus;
  requiresGpu: boolean;
  gpuResidence: boolean;
  bf16Required: boolean;
  minComputeCapability: number | null;
  minVramTotalMiB: number;
  cpuFallback: boolean;
  asr: ModelReference;
  tts: ModelReference;
  notes: string[];
}

export interface ProfilesConfig {
  version: number;
  generatedFor: string;
  auditDate: string;
  selection: string;
  /** Capacités qui déterminent réellement le profil (CC + VRAM totale + BF16). */
  profileCriteria?: string[];
  /** Capacités mesurées mais sans effet sur le profil (avertissement / service). */
  informational?: Record<string, string>;
  profiles: GpuProfile[];
}

export interface CapabilityDefinition {
  id: string;
  label: string;
  type: "boolean" | "number";
  unit?: string;
  source: string;
  criterion: string;
  status: ProfileStatus;
}

export interface CompatService {
  requiresGpu: boolean;
  capabilities: string[];
  status: ProfileStatus;
}

export interface CompatManifest {
  version: number;
  generatedFor: string;
  auditDate: string;
  capabilities: CapabilityDefinition[];
  profiles: Record<string, { requires: string[]; thresholds: Record<string, number> }>;
  services: Record<string, CompatService>;
  notes: string[];
}
