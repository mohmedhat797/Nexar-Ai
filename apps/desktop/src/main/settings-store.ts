import { readFile } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { z } from 'zod';
import { NexarError } from '@nexar/contracts';
import { DENSITIES, MODES, THEMES, type DesktopSettings } from '../shared/api.js';
import { PLANE_PROJECT_PATTERN } from '../shared/plane.js';
import {
  BEHAVIOR_RESOURCE_PATTERN,
  CODE_PERMISSIONS,
  COWORK_PERMISSIONS,
  DEFAULT_CODE_PERMISSION,
  DEFAULT_COWORK_PERMISSION,
  type BehaviorPatch,
  type BehaviorSettings,
} from '../shared/behavior.js';
import { API_PROVIDER_IDS } from '../shared/providers.js';
import { writeFileAtomic } from './atomic-write.js';

export const DEFAULT_SETTINGS: DesktopSettings = {
  theme: 'light',
  density: 'comfortable',
  mode: 'cowork',
};

const AppearanceSchema = z.strictObject({
  theme: z.enum(THEMES),
  density: z.enum(DENSITIES),
  mode: z.enum(MODES),
});

/** The patch a `settings:set` call may carry: any subset, nothing else. */
export const SettingsPatchSchema = z.strictObject({
  theme: z.enum(THEMES).optional(),
  density: z.enum(DENSITIES).optional(),
  mode: z.enum(MODES).optional(),
});

// ---- Code plane (ADR-025) ---------------------------------------------------------------------

export const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** An absolute POSIX path inside the distro; `..` is refused below. */
export const COMMAND_PATTERN = /^\/[A-Za-z0-9._/-]{1,255}$/;
export const DESKTOP_PROJECT_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
export { PLANE_PROJECT_PATTERN };
export const MAX_PLANE_PROJECTS = 200;
export const DEFAULT_PLANE_DISTRO = 'nexar-plane';
export const DEFAULT_PLANE_COMMAND = '/usr/local/bin/nexar';

const CodePlaneSchema = z.strictObject({
  distro: z.string().regex(DISTRO_PATTERN).default(DEFAULT_PLANE_DISTRO),
  command: z
    .string()
    .regex(COMMAND_PATTERN)
    .refine((value) => !value.includes('..'), 'must not contain ..')
    .default(DEFAULT_PLANE_COMMAND),
  projects: z
    .record(z.string().regex(DESKTOP_PROJECT_PATTERN), z.string().regex(PLANE_PROJECT_PATTERN))
    .refine((map) => Object.keys(map).length <= MAX_PLANE_PROJECTS, 'too many projects')
    .default({}),
});

/** Owner configuration of the Code lane. Only `projects` is ever written by the app. */
export interface CodePlaneConfig {
  readonly distro: string;
  readonly command: string;
  readonly projects: Readonly<Record<string, string>>;
}

/** A damaged `codePlane` section fails closed: the Code lane reports it instead of guessing. */
export type CodePlaneConfigResult =
  { readonly valid: true; readonly value: CodePlaneConfig } | { readonly valid: false };

export const DEFAULT_CODE_PLANE: CodePlaneConfig = {
  distro: DEFAULT_PLANE_DISTRO,
  command: DEFAULT_PLANE_COMMAND,
  projects: {},
};

// ---- Cowork lane (ADR-026) --------------------------------------------------------------------

const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_OPENWORKER_EXECUTABLE = 'openworker-server';
/** `openworker version` (the CLI entry point); `openworker-server` takes server flags only. */
export const DEFAULT_OPENWORKER_VERSION_EXECUTABLE = 'openworker';

/** An absolute path (either platform) or a bare command name; never a relative path or a NUL. */
export function validExecutable(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.includes('\0')) return false;
  return BARE_COMMAND.test(value) || isAbsolute(value) || win32.isAbsolute(value);
}

const CoworkSchema = z.strictObject({
  executable: z.string().refine(validExecutable, 'invalid executable').optional(),
  /** Upstream's version command is the separate `openworker` CLI, not the server binary. */
  versionExecutable: z.string().refine(validExecutable, 'invalid executable').optional(),
  allowedProviders: z
    .array(z.enum(API_PROVIDER_IDS))
    .max(API_PROVIDER_IDS.length)
    .default([])
    .transform((list) => [...new Set(list)]),
});

/** Owner configuration of the Cowork lane; only `allowedProviders` is ever written by the app. */
export interface CoworkConfig {
  readonly executable?: string | undefined;
  readonly versionExecutable?: string | undefined;
  readonly allowedProviders: readonly string[];
}

/** A damaged `cowork` section fails closed (lane unavailable) and is preserved verbatim. */
export type CoworkConfigResult =
  { readonly valid: true; readonly value: CoworkConfig } | { readonly valid: false };

const DEFAULT_COWORK: CoworkConfig = { allowedProviders: [] };

function parseCowork(raw: unknown): CoworkConfigResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_COWORK };
  const parsed = CoworkSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}
// ---- AI behavior (NXR-053) --------------------------------------------------------------------

const ResourceIdSchema = z.string().regex(BEHAVIOR_RESOURCE_PATTERN);
const BehaviorSchema = z
  .strictObject({
    cowork: z
      .strictObject({
        permission: z.enum(COWORK_PERMISSIONS).default(DEFAULT_COWORK_PERMISSION),
        preferredResourceId: ResourceIdSchema.optional(),
      })
      .optional(),
    code: z
      .strictObject({
        permission: z.enum(CODE_PERMISSIONS).default(DEFAULT_CODE_PERMISSION),
        preferredResourceId: ResourceIdSchema.optional(),
      })
      .optional(),
  })
  .transform((value): BehaviorSettings => ({
    cowork: value.cowork ?? { permission: DEFAULT_COWORK_PERMISSION },
    code: value.code ?? { permission: DEFAULT_CODE_PERMISSION },
  }));

/** What a ehavior:set call may carry: any subset of known values, nothing else. */
export const BehaviorPatchSchema = z.strictObject({
  cowork: z
    .strictObject({
      permission: z.enum(COWORK_PERMISSIONS).optional(),
      preferredResourceId: ResourceIdSchema.nullable().optional(),
    })
    .optional(),
  code: z
    .strictObject({
      permission: z.enum(CODE_PERMISSIONS).optional(),
      preferredResourceId: ResourceIdSchema.nullable().optional(),
    })
    .optional(),
});

export const DEFAULT_BEHAVIOR: BehaviorSettings = {
  cowork: { permission: DEFAULT_COWORK_PERMISSION },
  code: { permission: DEFAULT_CODE_PERMISSION },
};

/** A damaged ehavior section fails closed (no turn starts on it) and is preserved verbatim. */
export type BehaviorResult =
  { readonly valid: true; readonly value: BehaviorSettings } | { readonly valid: false };

function parseBehavior(raw: unknown): BehaviorResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_BEHAVIOR };
  const parsed = BehaviorSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

function mergeBehavior(current: BehaviorSettings, patch: BehaviorPatch): BehaviorSettings {
  const preferred = (
    now: string | undefined,
    next: string | null | undefined,
  ): { preferredResourceId?: string } => {
    const value = next === undefined ? now : (next ?? undefined);
    return value === undefined ? {} : { preferredResourceId: value };
  };
  return {
    cowork: {
      permission: patch.cowork?.permission ?? current.cowork.permission,
      ...preferred(current.cowork.preferredResourceId, patch.cowork?.preferredResourceId),
    },
    code: {
      permission: patch.code?.permission ?? current.code.permission,
      ...preferred(current.code.preferredResourceId, patch.code?.preferredResourceId),
    },
  };
}

interface Loaded {
  readonly appearance: DesktopSettings;
  readonly behaviorRaw: unknown;
  readonly behavior: BehaviorResult;
  /** The raw `codePlane` value of the file (kept verbatim when invalid), or `undefined`. */
  readonly codePlaneRaw: unknown;
  readonly codePlane: CodePlaneConfigResult;
  readonly coworkRaw: unknown;
  readonly cowork: CoworkConfigResult;
}

function parseCodePlane(raw: unknown): CodePlaneConfigResult {
  if (raw === undefined) return { valid: true, value: DEFAULT_CODE_PLANE };
  const parsed = CodePlaneSchema.safeParse(raw);
  return parsed.success ? { valid: true, value: parsed.data } : { valid: false };
}

/**
 * `desktop-settings.json`: appearance and mode for the renderer, plus the owner-edited `codePlane`
 * section (distro, command, project mapping) that the renderer can never read or write except for
 * the project mapping through its own channel. A missing or damaged file means the defaults.
 */
export class SettingsStore {
  private current: Loaded | undefined;
  /** Serializes read-modify-write cycles. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<Loaded> {
    if (this.current !== undefined) return this.current;
    let appearance: DesktopSettings = DEFAULT_SETTINGS;
    let codePlaneRaw: unknown;
    let coworkRaw: unknown;
    let behaviorRaw: unknown;
    try {
      const file = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (typeof file === 'object' && file !== null && !Array.isArray(file)) {
        const { codePlane, cowork, behavior, ...rest } = file as Record<string, unknown>;
        const parsed = AppearanceSchema.safeParse(rest);
        if (parsed.success) appearance = parsed.data;
        codePlaneRaw = Object.hasOwn(file, 'codePlane') ? codePlane : undefined;
        coworkRaw = Object.hasOwn(file, 'cowork') ? cowork : undefined;
        behaviorRaw = Object.hasOwn(file, 'behavior') ? behavior : undefined;
      }
    } catch {
      // Missing or unreadable: defaults.
    }
    this.current = {
      appearance,
      codePlaneRaw,
      codePlane: parseCodePlane(codePlaneRaw),
      coworkRaw,
      cowork: parseCowork(coworkRaw),
      behaviorRaw,
      behavior: parseBehavior(behaviorRaw),
    };
    return this.current;
  }

  private async write(next: Loaded): Promise<void> {
    const section =
      next.codePlane.valid && next.codePlaneRaw === undefined
        ? {}
        : { codePlane: next.codePlane.valid ? next.codePlane.value : next.codePlaneRaw };
    const coworkSection =
      next.cowork.valid && next.coworkRaw === undefined
        ? {}
        : { cowork: next.cowork.valid ? next.cowork.value : next.coworkRaw };
    const behaviorSection =
      next.behavior.valid && next.behaviorRaw === undefined
        ? {}
        : { behavior: next.behavior.valid ? next.behavior.value : next.behaviorRaw };
    await writeFileAtomic(
      this.path,
      JSON.stringify(
        { ...next.appearance, ...section, ...coworkSection, ...behaviorSection },
        null,
        2,
      ) + '\n',
    );
    this.current = next;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The renderer-visible settings (never the Code plane section). */
  async get(): Promise<DesktopSettings> {
    return (await this.load()).appearance;
  }

  set(patch: z.infer<typeof SettingsPatchSchema>): Promise<DesktopSettings> {
    return this.serialized(async () => {
      const loaded = await this.load();
      const current = loaded.appearance;
      const appearance = AppearanceSchema.parse({
        theme: patch.theme ?? current.theme,
        density: patch.density ?? current.density,
        mode: patch.mode ?? current.mode,
      });
      await this.write({ ...loaded, appearance });
      return appearance;
    });
  }

  /** Main-process only: the validated Code plane configuration. */
  async getCodePlane(): Promise<CodePlaneConfigResult> {
    return (await this.load()).codePlane;
  }

  /**
   * Maps (or, with `null`, unmaps) a Desktop project to a plane project id. The distro and command
   * stay exactly as the owner wrote them. Refused while the section is damaged: guessing would
   * overwrite the owner's edit.
   */
  setPlaneProject(desktopProjectId: string, planeProject: string | null): Promise<CodePlaneConfig> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.codePlane.valid) {
        throw new NexarError('CONFIGURATION_ERROR', 'The Code plane settings are not valid');
      }
      if (
        !DESKTOP_PROJECT_PATTERN.test(desktopProjectId) ||
        (planeProject !== null && !PLANE_PROJECT_PATTERN.test(planeProject))
      ) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid project id');
      }
      const projects: Record<string, string> = { ...loaded.codePlane.value.projects };
      if (planeProject === null) delete projects[desktopProjectId];
      else projects[desktopProjectId] = planeProject;
      if (Object.keys(projects).length > MAX_PLANE_PROJECTS) {
        throw new NexarError('POLICY_REJECTED', 'Too many project mappings');
      }
      const value: CodePlaneConfig = { ...loaded.codePlane.value, projects };
      await this.write({
        ...loaded,
        codePlaneRaw: value,
        codePlane: { valid: true, value },
      });
      return value;
    });
  }

  /** Main-process only: the validated AI behavior settings. */
  async getBehavior(): Promise<BehaviorResult> {
    return (await this.load()).behavior;
  }

  /** Applies a validated patch. Refused while the section is damaged: guessing would overwrite it. */
  setBehavior(patch: BehaviorPatch): Promise<BehaviorSettings> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.behavior.valid) {
        throw new NexarError('CONFIGURATION_ERROR', 'The AI behavior settings are not valid');
      }
      const value = BehaviorSchema.parse(mergeBehavior(loaded.behavior.value, patch));
      await this.write({ ...loaded, behaviorRaw: value, behavior: { valid: true, value } });
      return value;
    });
  }

  /** Main-process only: the validated Cowork configuration. */
  async getCowork(): Promise<CoworkConfigResult> {
    return (await this.load()).cowork;
  }

  /**
   * Allows (or revokes) OpenWorker's use of one provider's key. Refused while the section is
   * damaged. The key itself is never moved or copied.
   */
  setOpenWorkerAccess(provider: string, allowed: boolean): Promise<CoworkConfig> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.cowork.valid) {
        throw new NexarError('CONFIGURATION_ERROR', 'The Cowork settings are not valid');
      }
      if (!(API_PROVIDER_IDS as readonly string[]).includes(provider)) {
        throw new NexarError('VALIDATION_ERROR', 'Invalid provider');
      }
      const rest = loaded.cowork.value.allowedProviders.filter((p) => p !== provider);
      const value: CoworkConfig = {
        ...loaded.cowork.value,
        allowedProviders: allowed ? [...rest, provider] : rest,
      };
      await this.write({ ...loaded, coworkRaw: value, cowork: { valid: true, value } });
      return value;
    });
  }
}
