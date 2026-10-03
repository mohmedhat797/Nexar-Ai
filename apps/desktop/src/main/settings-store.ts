import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { NexarError } from '@nexar/contracts';
import { DENSITIES, MODES, THEMES, type DesktopSettings } from '../shared/api.js';
import { PLANE_PROJECT_PATTERN } from '../shared/plane.js';
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

interface Loaded {
  readonly appearance: DesktopSettings;
  /** The raw `codePlane` value of the file (kept verbatim when invalid), or `undefined`. */
  readonly codePlaneRaw: unknown;
  readonly codePlane: CodePlaneConfigResult;
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
    try {
      const file = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (typeof file === 'object' && file !== null && !Array.isArray(file)) {
        const { codePlane, ...rest } = file as Record<string, unknown>;
        const parsed = AppearanceSchema.safeParse(rest);
        if (parsed.success) appearance = parsed.data;
        codePlaneRaw = Object.hasOwn(file, 'codePlane') ? codePlane : undefined;
      }
    } catch {
      // Missing or unreadable: defaults.
    }
    this.current = { appearance, codePlaneRaw, codePlane: parseCodePlane(codePlaneRaw) };
    return this.current;
  }

  private async write(next: Loaded): Promise<void> {
    const section =
      next.codePlane.valid && next.codePlaneRaw === undefined
        ? {}
        : { codePlane: next.codePlane.valid ? next.codePlane.value : next.codePlaneRaw };
    await writeFileAtomic(
      this.path,
      JSON.stringify({ ...next.appearance, ...section }, null, 2) + '\n',
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
}
