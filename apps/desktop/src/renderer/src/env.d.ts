import type { LivingMapApi } from "@living-map/contracts/ipc";

declare global {
  interface Window {
    readonly livingMap: LivingMapApi;
  }
}
