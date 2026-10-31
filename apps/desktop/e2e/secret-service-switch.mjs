// Playwright's Electron loader forces --password-store=basic, which hides any OS keyring. This runs
// after the loader and before the app, so `safeStorage` sees the throwaway Secret Service.
import { app } from 'electron';

app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
