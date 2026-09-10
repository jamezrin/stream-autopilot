import { startPlaybackTelemetry } from "../src/core/playbackContent";
import { mountInPagePanel } from "../src/core/inPagePanel";

export default defineContentScript({
  matches: ["https://kick.com/*"],
  main() {
    startPlaybackTelemetry("kick");
    mountInPagePanel("kick");
  },
});
