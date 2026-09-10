import React, { useEffect, useState } from "react";
import { AppWindow, Box, SquareTerminal, Star, type LucideIcon } from "lucide-react";
import type { SupportedLocale } from "@lurkloot/shared/models";
import { DEFAULT_LOCALE, isRtlLocale, translateFromCatalogs, type MessageCatalog } from "@lurkloot/shared/i18n";
import { loadCatalog } from "@lurkloot/locales";
import { PROMO_GRADIENT } from "./constants";
import type { ScreenshotVariant } from "./types";
import { variantShowsPopup } from "./types";

function useScreenshotCatalog(locale: SupportedLocale | undefined): (key: string) => string {
  const [catalog, setCatalog] = useState<MessageCatalog | undefined>(undefined);
  const [fallback, setFallback] = useState<MessageCatalog | undefined>(undefined);
  useEffect(() => {
    void loadCatalog(locale ?? DEFAULT_LOCALE).then(setCatalog);
    void loadCatalog(DEFAULT_LOCALE).then(setFallback);
  }, [locale]);
  return (key: string) => translateFromCatalogs(key, undefined, catalog, fallback ?? catalog ?? {});
}

function Eyebrow({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="mb-4 text-[13px] font-semibold uppercase tracking-[0.14em] bg-linear-to-r from-[#c4a7ff] to-[#b7ff6a] bg-clip-text text-transparent">
      {children}
    </p>
  );
}

function CopyBlock({
  eyebrowKey,
  headlineKey,
  subcopyKey,
  translate,
  showSubcopy = true,
  className,
}: {
  eyebrowKey: string;
  headlineKey: string;
  subcopyKey: string;
  translate: (key: string) => string;
  showSubcopy?: boolean;
  className?: string;
}): React.ReactElement {
  return (
    <div className={className}>
      <Eyebrow>{translate(eyebrowKey)}</Eyebrow>
      <h1 className="font-display text-[56px] font-bold leading-[0.98] tracking-normal text-[#ecedf5]">
        {translate(headlineKey)}
      </h1>
      {showSubcopy ? (
        <p className="mt-5 max-w-[520px] text-[20px] leading-snug text-[#9c9db4]">
          {translate(subcopyKey)}
        </p>
      ) : null}
    </div>
  );
}

function PopupFrame({ children, className }: { children: React.ReactNode; className?: string }): React.ReactElement {
  return (
    <div className={`h-[600px] w-[400px] shrink-0 overflow-hidden ${className ?? ""}`}>
      {children}
    </div>
  );
}

function ExtraCallout({
  dot,
  name,
  meta,
}: {
  dot: string;
  name: string;
  meta: string;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span
        className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: dot, boxShadow: `0 0 12px ${dot}` }}
      />
      <div className="min-w-0">
        <div className="text-[24px] font-semibold leading-tight text-[#ecedf5]">{name}</div>
        <div className="mt-1 text-[16px] leading-snug text-[#9c9db4]">{meta}</div>
      </div>
    </div>
  );
}

function StepItem({
  number,
  title,
  sub,
}: {
  number: string;
  title: string;
  sub: string;
}): React.ReactElement {
  return (
    <div className="relative min-w-0 ps-5">
      <div className="font-display text-[32px] font-bold leading-none text-[#c4a7ff]/80">{number}</div>
      <div className="mt-3 text-[18px] font-semibold text-[#ecedf5]">{title}</div>
      <div className="mt-1.5 text-[14px] leading-snug text-[#9c9db4]">{sub}</div>
    </div>
  );
}

function RuntimeIcon({
  accent,
  className,
  children,
}: {
  accent: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span
      className={`relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-[#101014] ${className ?? ""}`}
      style={{ color: accent, boxShadow: `inset 0 1px 0 rgba(255,255,255,0.06), 0 0 8px -6px ${accent}` }}
      aria-hidden
    >
      {children}
    </span>
  );
}

function LucideMark({ icon: Icon, size = 26 }: { icon: LucideIcon; size?: number }): React.ReactElement {
  return <Icon size={size} strokeWidth={1.6} />;
}

function GithubMark({ size = 26 }: { size?: number }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.31-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5Z" />
    </svg>
  );
}

function StarRow(): React.ReactElement {
  return (
    <div className="mt-4 flex items-center justify-center gap-1.5 text-[#c4a7ff]" aria-hidden>
      {Array.from({ length: 5 }, (_, index) => (
        <Star key={index} size={28} fill="currentColor" strokeWidth={0} />
      ))}
    </div>
  );
}

function RuntimeRow({
  title,
  sub,
  marks,
}: {
  title: string;
  sub: string;
  marks: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-4">
      <div className="flex shrink-0">{marks}</div>
      <div className="min-w-0">
        <div className="text-[20px] font-semibold leading-tight text-[#ecedf5]">{title}</div>
        <div className="mt-1 text-[14px] leading-snug text-[#9c9db4]">{sub}</div>
      </div>
    </div>
  );
}

export function StoreScreenshot({
  variant,
  children,
  locale = DEFAULT_LOCALE,
}: {
  variant: ScreenshotVariant;
  children?: React.ReactNode;
  locale?: SupportedLocale;
}): React.ReactElement {
  const translate = useScreenshotCatalog(locale);
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";
  const rtl = dir === "rtl";
  const popup = variantShowsPopup(variant) ? children : null;

  return (
    <div
      dir={dir}
      data-layout={variant.layout}
      className="relative h-[800px] w-[1280px] overflow-hidden bg-[#060609] text-[#ecedf5]"
    >
      <div className="pointer-events-none absolute inset-0" style={{ background: variant.glow }} />

      {variant.layout === "hero" ? (
        <>
          <CopyBlock
            className="absolute start-[7%] bottom-[12%] end-[40%] z-10"
            eyebrowKey={variant.eyebrowKey}
            headlineKey={variant.headlineKey}
            subcopyKey={variant.subcopyKey}
            translate={translate}
          />
          {popup ? (
            <div className={`absolute end-[7%] top-[9%] z-20 origin-center ${rtl ? "rotate-[2deg]" : "rotate-[-2deg]"}`}>
              <PopupFrame>{popup}</PopupFrame>
            </div>
          ) : null}
        </>
      ) : null}

      {variant.layout === "extras" ? (
        <>
          <div className="absolute start-[7%] top-[12%] end-[42%] z-10">
            <CopyBlock
              eyebrowKey={variant.eyebrowKey}
              headlineKey={variant.headlineKey}
              subcopyKey={variant.subcopyKey}
              translate={translate}
            />
            <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-7">
              <ExtraCallout
                dot="#a970ff"
                name={translate("screenshotExtrasPointsName")}
                meta={translate("screenshotExtrasPointsMeta")}
              />
              <ExtraCallout
                dot="#53fc18"
                name={translate("screenshotExtrasChallengesName")}
                meta={translate("screenshotExtrasChallengesMeta")}
              />
              <ExtraCallout
                dot="#c4a7ff"
                name={translate("screenshotExtrasWatchlistName")}
                meta={translate("screenshotExtrasWatchlistMeta")}
              />
              <ExtraCallout
                dot="#b7ff6a"
                name={translate("screenshotExtrasFlashName")}
                meta={translate("screenshotExtrasFlashMeta")}
              />
            </div>
          </div>
          {popup ? (
            <div className={`absolute end-[7%] top-[9%] z-20 origin-center ${rtl ? "rotate-[2deg]" : "rotate-[-2deg]"}`}>
              <PopupFrame>{popup}</PopupFrame>
            </div>
          ) : null}
        </>
      ) : null}

      {variant.layout === "steps" ? (
        <>
          <CopyBlock
            className="absolute start-[7%] top-[10%] end-[46%] z-10"
            eyebrowKey={variant.eyebrowKey}
            headlineKey={variant.headlineKey}
            subcopyKey={variant.subcopyKey}
            translate={translate}
            showSubcopy={false}
          />
          <div data-steps className="absolute start-[7%] top-[34%] bottom-[10%] z-10 flex w-[34%] flex-col justify-between">
            <div className="pointer-events-none absolute start-0 top-2 bottom-6 w-0.5 bg-linear-to-b from-[#9147ff] to-[#53fc18]" />
            <StepItem
              number="01"
              title={translate("screenshotEasyInstallTitle")}
              sub={translate("screenshotEasyInstallSub")}
            />
            <StepItem
              number="02"
              title={translate("screenshotEasyPinTitle")}
              sub={translate("screenshotEasyPinSub")}
            />
            <StepItem
              number="03"
              title={translate("screenshotEasyEnableTitle")}
              sub={translate("screenshotEasyEnableSub")}
            />
            <StepItem
              number="04"
              title={translate("screenshotEasyProfitTitle")}
              sub={translate("screenshotEasyProfitSub")}
            />
          </div>
          {popup ? (
            <div className={`absolute end-[7%] top-[9%] z-20 origin-center ${rtl ? "rotate-[-2deg]" : "rotate-[2deg]"}`}>
              <PopupFrame>{popup}</PopupFrame>
            </div>
          ) : null}
        </>
      ) : null}

      {variant.layout === "settings" ? (
        <>
          {popup ? (
            <div className="absolute start-[5%] top-[8%] z-20">
              <PopupFrame>{popup}</PopupFrame>
            </div>
          ) : null}
          <CopyBlock
            className="absolute start-[42%] end-[7%] top-[18%] z-10"
            eyebrowKey={variant.eyebrowKey}
            headlineKey={variant.headlineKey}
            subcopyKey={variant.subcopyKey}
            translate={translate}
          />
        </>
      ) : null}

      {variant.layout === "updated" ? (
        <>
          <div className="absolute start-[7%] end-[40%] top-[9%] z-10 flex h-[600px] flex-col justify-center">
            <CopyBlock
              className="text-center [&_p]:mx-auto"
              eyebrowKey={variant.eyebrowKey}
              headlineKey={variant.headlineKey}
              subcopyKey={variant.subcopyKey}
              translate={translate}
            />
          </div>
          <div
            data-updated-board
            className="absolute end-[7%] top-[9%] z-10 flex h-[600px] w-[400px] flex-col justify-between overflow-hidden rounded-3xl border border-white/8 bg-[#0c0c10]/80 px-8 py-9"
          >
            <div className="flex flex-col items-center text-center">
              <div className="font-display text-[80px] font-bold leading-none tracking-tight text-[#ecedf5]">
                {translate("screenshotUpdatedRating")}
              </div>
              <StarRow />
              <p className="mt-5 text-[20px] leading-snug text-[#9c9db4]">
                {translate("screenshotUpdatedUsers")}
              </p>
            </div>
            <div>
              <div className="mb-7 h-px bg-white/10" />
              <div className="flex flex-col gap-5">
                <RuntimeRow
                  title={translate("screenshotUpdatedBrowsersTitle")}
                  sub={translate("screenshotUpdatedBrowsersSub")}
                  marks={(
                    <RuntimeIcon accent="#c4a7ff">
                      <LucideMark icon={AppWindow} />
                    </RuntimeIcon>
                  )}
                />
                <RuntimeRow
                  title={translate("screenshotUpdatedHeadlessTitle")}
                  sub={translate("screenshotUpdatedHeadlessSub")}
                  marks={(
                    <RuntimeIcon accent="#b7ff6a">
                      <LucideMark icon={SquareTerminal} />
                    </RuntimeIcon>
                  )}
                />
                <RuntimeRow
                  title={translate("screenshotUpdatedDockerTitle")}
                  sub={translate("screenshotUpdatedDockerSub")}
                  marks={(
                    <RuntimeIcon accent="#9c9db4">
                      <LucideMark icon={Box} />
                    </RuntimeIcon>
                  )}
                />
                <RuntimeRow
                  title={translate("githubAttributionShort")}
                  sub={`${translate("screenshotUpdatedEyebrow")} · ${translate("screenshotUpdatedLicense")}`}
                  marks={(
                    <RuntimeIcon accent="#ecedf5">
                      <GithubMark />
                    </RuntimeIcon>
                  )}
                />
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// Platform names only — no Twitch/Kick logos, which are trademarked. The brand
// colour lives in a small status dot so the pills read as one neutral glass
// control instead of two solid brand-coloured buttons.
const PLATFORMS = [
  { name: "Twitch", color: "#a970ff" },
  { name: "Kick", color: "#53fc18" },
];

function PromoPills({ translate, scale = 1 }: { translate: (key: string) => string; scale?: number }): React.ReactElement {
  const px = (value: number) => `${value * scale}px`;
  const pad = `${px(9)} ${px(15)}`;
  return (
    <div className="flex flex-wrap items-center" style={{ fontSize: px(15), gap: px(10) }}>
      <span
        className="inline-flex items-center rounded-full border border-white/15 bg-white/10 font-semibold text-white"
        style={{ padding: pad, gap: px(10) }}
      >
        {PLATFORMS.map((platform, index) => (
          <React.Fragment key={platform.name}>
            {index > 0 && <span className="font-normal text-white/25">/</span>}
            <span className="inline-flex items-center" style={{ gap: px(7) }}>
              <span
                className="rounded-full"
                style={{ width: px(7), height: px(7), background: platform.color, boxShadow: `0 0 ${px(9)} ${platform.color}` }}
              />
              {platform.name}
            </span>
          </React.Fragment>
        ))}
      </span>
      <span className="rounded-full border border-white/12 bg-white/5 font-medium text-zinc-300" style={{ padding: pad }}>
        {translate("autoClaimReady")}
      </span>
    </div>
  );
}

export function PromoTile({
  format,
  locale = DEFAULT_LOCALE,
}: {
  format: "small" | "marquee";
  locale?: SupportedLocale;
}): React.ReactElement {
  const translate = useScreenshotCatalog(locale);
  const dir = isRtlLocale(locale) ? "rtl" : "ltr";

  if (format === "small") {
    return (
      <div
        dir={dir}
        className="relative flex h-[280px] w-[440px] flex-col justify-center overflow-hidden bg-zinc-950 px-9 text-white"
      >
        <div className="pointer-events-none absolute inset-0" style={{ background: PROMO_GRADIENT }} />
        <div className="relative">
          <div className="mb-5 flex items-center gap-3">
            <img src="/logo-ring.svg" alt="" width={52} height={52} className="h-[52px] w-[52px]" />
            <span className="font-display text-[27px] font-bold leading-none tracking-tight text-white">
              {translate("extensionName")}
            </span>
          </div>
          <p className="mb-6 max-w-[360px] text-[18px] font-semibold leading-tight text-zinc-200">
            {translate("promoTagline")}
          </p>
          <PromoPills translate={translate} scale={0.82} />
        </div>
      </div>
    );
  }

  return (
    <div
      dir={dir}
      className="relative grid h-[560px] w-[1400px] grid-cols-[1fr_520px] items-center overflow-hidden bg-zinc-950 text-white"
    >
      <div className="pointer-events-none absolute inset-0" style={{ background: PROMO_GRADIENT }} />
      <section className="relative z-10 flex min-w-0 flex-col justify-center px-24">
        <div className="mb-8 flex items-center gap-4">
          <img src="/logo-ring.svg" alt="" width={68} height={68} className="h-[68px] w-[68px]" />
          <span className="font-display text-[34px] font-bold leading-none tracking-tight text-white">
            {translate("extensionName")}
          </span>
        </div>
        <h1 className="font-display max-w-[660px] text-[56px] font-bold leading-[0.98] tracking-normal text-white">
          {translate("screenshotHeroHeadline")}
        </h1>
        <p className="mt-6 max-w-[560px] text-[21px] leading-snug text-zinc-300">
          {translate("extensionDescription")}
        </p>
        <div className="mt-10">
          <PromoPills translate={translate} />
        </div>
      </section>
      <section className="relative flex h-full items-center justify-center">
        <div
          className="pointer-events-none absolute h-[520px] w-[520px] rounded-full opacity-70 blur-2xl"
          style={{ background: "radial-gradient(circle, rgba(145,71,255,0.45), rgba(83,252,24,0.18) 55%, transparent 72%)" }}
        />
        <img src="/logo-ring.svg" alt="" width={300} height={300} className="relative h-[300px] w-[300px] drop-shadow-2xl" />
      </section>
    </div>
  );
}
