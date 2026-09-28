// The private iCal feed URL is a credential (Stage 4 iCal decision §4): encrypted at rest via
// Electron's OS-backed `safeStorage`, in a file next to (not inside) living-map.sqlite. Never in a
// plain domain table, never sent back to the renderer after submission.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretStore } from "@living-map/integrations-ical-calendar";
import { safeStorage } from "electron";

function secretFile(dataHome: string): string {
  return join(dataHome, "calendar-feed.enc");
}

export function createSafeStorageSecretStore(dataHome: string): SecretStore {
  const file = secretFile(dataHome);
  return {
    load: (): string | null => {
      if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(readFileSync(file));
      } catch {
        return null; // corrupt/undecryptable: treat as disconnected rather than crash
      }
    },
    save: (url: string) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, safeStorage.encryptString(url));
    },
    clear: () => {
      if (existsSync(file)) unlinkSync(file);
    },
  };
}
