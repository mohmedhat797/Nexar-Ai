import { describe, expect, it } from 'vitest';
import { relayLaunch, relayScriptPath } from './bridge-relay-path.js';

describe('relay launch', () => {
  it('runs this executable as plain Node on the script beside the main bundle', () => {
    const launch = relayLaunch('file:///C:/dev/nexar/apps/desktop/dist/main/main.js');
    expect(launch.command).toBe(process.execPath);
    expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(launch.args).toHaveLength(1);
    expect(launch.args[0]).toMatch(/dist[\\/]main[\\/]bridge-relay\.cjs$/);
  });

  it('points into app.asar.unpacked when packaged', () => {
    const path = relayScriptPath(
      'file:///C:/Users/me/AppData/Local/Nexar/resources/app.asar/dist/main/main.js',
    );
    expect(path).toMatch(/app\.asar\.unpacked[\\/]dist[\\/]main[\\/]bridge-relay\.cjs$/);
    expect(path).not.toMatch(/app\.asar[\\/]/);
  });
});
