import React from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { GITHUB_REPO_URL } from "./constants";
import { useT } from "./context";
import { cn } from "./primitives";

export function GithubStarNudge({ onStar, onDismiss }: { onStar(): void; onDismiss(): void }): React.ReactElement {
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
        <GithubMark size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight" style={{ color: "var(--accent-text)" }}>
          {t("githubStarNudgeTitle")}
        </p>
        <p className="mt-0.5 text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
          {t("githubStarNudgeBody")}
        </p>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noreferrer"
          onClick={onStar}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-contrast)] outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
          style={{ backgroundColor: "var(--accent)" }}
        >
          <GithubMark size={12} />
          {t("githubStarNudgeAction")}
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

function GithubMark({ size }: { size: number }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
