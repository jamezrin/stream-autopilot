import React from "react";
import { motion } from "motion/react";
import { Star, X } from "lucide-react";
import { CHROME_WEB_STORE_REVIEW_URL } from "./constants";
import { useT } from "./context";
import { cn } from "./primitives";

export { shouldShowGithubStarNudge, shouldShowRateNudge } from "./rateNudge.logic";

export function RateNudge({ onRate, onDismiss }: { onRate(): void; onDismiss(): void }): React.ReactElement {
  const t = useT();
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18 }}
      className="relative flex items-start gap-2.5 rounded-xl px-3 py-2.5"
      style={{ backgroundColor: "var(--accent-soft)" }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }}>
        <Star size={16} fill="currentColor" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight" style={{ color: "var(--accent-text)" }}>
          {t("rateNudgeTitle")}
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
          {t("rateNudgeBody")}
        </p>
        <a
          href={CHROME_WEB_STORE_REVIEW_URL}
          target="_blank"
          rel="noreferrer"
          onClick={onRate}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          style={{ backgroundColor: "var(--accent)" }}
        >
          <Star size={12} fill="currentColor" />
          {t("rateNudgeAction")}
        </a>
      </div>
      <button
        type="button"
        title={t("rateNudgeDismiss")}
        aria-label={t("rateNudgeDismiss")}
        onClick={onDismiss}
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors",
          "text-zinc-400 hover:bg-black/5 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200",
        )}
      >
        <X size={13} />
      </button>
    </motion.div>
  );
}
