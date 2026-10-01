import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DENSITIES, MODES, THEMES, type DesktopSettings } from '../shared/api.js';
import { writeFileAtomic } from './atomic-write.js';

export const DEFAULT_SETTINGS: DesktopSettings = {
  theme: 'light',
  density: 'comfortable',
  mode: 'cowork',
};

const SettingsSchema = z.strictObject({
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

/** `desktop-settings.json`: appearance and mode. A missing or damaged file means the defaults. */
export class SettingsStore {
  private current: DesktopSettings | undefined;

  constructor(private readonly path: string) {}

  async get(): Promise<DesktopSettings> {
    if (this.current !== undefined) return this.current;
    let loaded: DesktopSettings = DEFAULT_SETTINGS;
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')));
      if (parsed.success) loaded = parsed.data;
    } catch {
      // Missing or unreadable: defaults.
    }
    this.current = loaded;
    return loaded;
  }

  async set(patch: z.infer<typeof SettingsPatchSchema>): Promise<DesktopSettings> {
    const current = await this.get();
    const next = SettingsSchema.parse({
      theme: patch.theme ?? current.theme,
      density: patch.density ?? current.density,
      mode: patch.mode ?? current.mode,
    });
    await writeFileAtomic(this.path, JSON.stringify(next, null, 2) + '\n');
    this.current = next;
    return next;
  }
}
