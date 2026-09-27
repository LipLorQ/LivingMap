import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Data directory shared by desktop and MCP (ARCHITECTURE §10).
 * `LIVING_MAP_HOME` fully overrides it (tests, dev, temporary databases).
 */
export function resolveDataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.LIVING_MAP_HOME?.trim();
  if (override) return resolve(override);
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "LivingMap");
  if (platform === "darwin") return join(home, "Library", "Application Support", "LivingMap");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "LivingMap");
}

export const databaseFile = (dataHome: string): string => join(dataHome, "living-map.sqlite");
