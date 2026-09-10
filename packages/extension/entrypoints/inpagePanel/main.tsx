import { createRoot } from "react-dom/client";
import { Popup } from "@lurkloot/popup-ui";
import "@lurkloot/popup-ui/styles.css";
import { createInPagePanelAdapter } from "../../src/core/inPagePanelAdapter";

// Stage 2 of the in-page panel: the popup UI as its own extension document,
// embedded by the content script in an iframe.
//
// Being a real document is the whole point, and it is what a shadow root could
// not give us:
//
//   - `<img src="/logo-ring.svg">` in Popup.tsx is root-absolute. Here it
//     resolves against the extension origin, as it does in the toolbar popup.
//     Inside a content script it resolved against twitch.tv and 404'd.
//   - `rem` resolves against the document root element even inside a shadow
//     root, so in-page the panel's spacing scaled with whatever
//     `html { font-size }` Twitch or Kick happened to set. Tailwind v4's
//     spacing scale is rem-based, so that governed the entire layout.
//   - styles.css applies unmodified: its `:root`, `html` and `body` rules have
//     a document to match against, so no `:host` mirror and no duplicated
//     font tokens that could drift.
//
// The document is exactly the popup's own 400x600, so the embedding iframe can
// be sized to match with nothing left to scroll.
createRoot(document.getElementById("root")!).render(<Popup adapter={createInPagePanelAdapter()} />);
