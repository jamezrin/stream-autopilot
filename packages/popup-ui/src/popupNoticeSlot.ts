export type PopupNoticeSlot = "update" | "rate" | "github-star" | null;

export function popupNoticeSlot(input: {
  preview: boolean;
  hasUpdateNotice: boolean;
  showRateNudge: boolean;
  showGithubStarNudge: boolean;
}): PopupNoticeSlot {
  if (input.hasUpdateNotice) return "update";
  if (input.preview) return null;
  if (input.showRateNudge) return "rate";
  if (input.showGithubStarNudge) return "github-star";
  return null;
}
