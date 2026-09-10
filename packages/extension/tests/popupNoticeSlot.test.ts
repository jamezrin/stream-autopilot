import { describe, expect, it } from "vitest";
import { popupNoticeSlot } from "@lurkloot/popup-ui/popupNoticeSlot";

describe("popupNoticeSlot", () => {
  const bothNudges = { showRateNudge: true, showGithubStarNudge: true };

  it("selects the update notice over both nudges, including in preview", () => {
    expect(popupNoticeSlot({ preview: false, hasUpdateNotice: true, ...bothNudges })).toBe("update");
    expect(popupNoticeSlot({ preview: true, hasUpdateNotice: true, ...bothNudges })).toBe("update");
  });

  it("hides both nudges in preview when there is no update notice", () => {
    expect(popupNoticeSlot({ preview: true, hasUpdateNotice: false, ...bothNudges })).toBe(null);
  });

  it("selects the rate nudge over the github star nudge", () => {
    expect(popupNoticeSlot({ preview: false, hasUpdateNotice: false, ...bothNudges })).toBe("rate");
  });

  it("selects the github star nudge when it is the only eligible banner", () => {
    expect(popupNoticeSlot({
      preview: false,
      hasUpdateNotice: false,
      showRateNudge: false,
      showGithubStarNudge: true,
    })).toBe("github-star");
  });

  it("returns null when nothing is eligible", () => {
    expect(popupNoticeSlot({
      preview: false,
      hasUpdateNotice: false,
      showRateNudge: false,
      showGithubStarNudge: false,
    })).toBe(null);
  });
});
