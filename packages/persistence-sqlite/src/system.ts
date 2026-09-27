import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "@living-map/application";

/** Production Clock / IdGenerator for the Node-based composition roots (ARCHITECTURE §42–43). */
export const systemClock: Clock = { now: () => new Date().toISOString() };
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };
