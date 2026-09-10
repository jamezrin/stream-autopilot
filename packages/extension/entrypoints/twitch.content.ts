import { startPlaybackTelemetry } from "../src/core/playbackContent";
import { mountInPagePanel } from "../src/core/inPagePanel";

export default defineContentScript({
  matches: ["https://www.twitch.tv/*"],
  main() {
    startPlaybackTelemetry("twitch");
    mountInPagePanel("twitch");
  },
});
