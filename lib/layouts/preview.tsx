/**
 * Browser-preview primitives — the §8 counterpart to `pptx-text.ts`.
 *
 * §8's requirement: *"Both the React templated renderer and `toPptx` must consume the **same** zone
 * resolution function and the same percent→dimension math (one shared util, two consumers)."* These
 * components are the second consumer. They position from the SAME `SlotZone` percents via
 * `zoneToCssPercent`, and they size type from the SAME `DesignTokens.type` points via `ptToCqh` — so
 * "the preview matches the export" is a property of shared arithmetic rather than of careful copying.
 *
 * Why `cqh` rather than `pt`: a CSS point is a fixed physical size, so a 32pt title would render
 * identically in a 200px thumbnail and a full-screen canvas — the thumbnail would be unreadable and
 * neither would be a scale model of the slide. `1cqh` = 1% of the container height, so type scales
 * with the frame while staying tied to the point size the exporter uses. Requires the frame to set
 * `container-type: size`, which `SlideFrame` does.
 *
 * Overflow is `hidden` on every zone, matching §1.1/C1's finding that over-long text must not be
 * allowed to spill across neighbours. The preview therefore shows the same truncation the export
 * gets, rather than a friendlier version of it.
 */

import type { CSSProperties, ReactNode } from "react";
import type { DesignTokens, SlotZone } from "@/lib/brand/types";
import { ptToCqh, zoneToCssPercent } from "@/lib/layouts/zone-math";

const ALIGN: Record<SlotZone["align"], CSSProperties["textAlign"]> = {
  left: "left", center: "center", right: "right",
};

const VALIGN: Record<SlotZone["valign"], CSSProperties["justifyContent"]> = {
  top: "flex-start", middle: "center", bottom: "flex-end",
};

export interface ZoneStyle {
  fontFamily: string;
  /** Points — the same number `toPptx` passes as `fontSize`. */
  fontSize: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  lineHeight?: number;
}

/** The shared zone box. Everything positional lives here so no layout re-derives it. */
export function ZoneBox(
  { zone, style, children }: { zone: SlotZone; style: ZoneStyle; children: ReactNode },
): ReactNode {
  return (
    <div
      style={{
        position: "absolute",
        ...zoneToCssPercent(zone),
        display: "flex",
        flexDirection: "column",
        justifyContent: VALIGN[zone.valign],
        textAlign: ALIGN[zone.align],
        fontFamily: style.fontFamily,
        fontSize: `${ptToCqh(style.fontSize)}cqh`,
        color: `#${style.color}`,
        fontWeight: style.bold ? 700 : 400,
        fontStyle: style.italic ? "italic" : "normal",
        lineHeight: style.lineHeight ?? 1.2,
        // C1: the preview must not be more forgiving than the export.
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

export function ZoneText(
  { zone, style, text }: { zone: SlotZone; style: ZoneStyle; text: string | undefined },
): ReactNode {
  if (!text) return null;
  return (
    <ZoneBox zone={zone} style={style}>
      <span style={{ whiteSpace: "pre-wrap" }}>{text}</span>
    </ZoneBox>
  );
}

export function ZoneList(
  { zone, style, items, marker = "bullet" }: {
    zone: SlotZone; style: ZoneStyle; items: readonly string[] | undefined;
    marker?: "bullet" | "number" | "none";
  },
): ReactNode {
  if (!items || items.length === 0) return null;
  const Tag = marker === "number" ? "ol" : "ul";
  return (
    <ZoneBox zone={zone} style={style}>
      <Tag
        style={{
          listStyleType: marker === "number" ? "decimal" : marker === "none" ? "none" : "disc",
          listStylePosition: "outside",
          margin: 0,
          paddingLeft: marker === "none" ? 0 : "1.2em",
          display: "flex",
          flexDirection: "column",
          gap: "0.35em",
        }}
      >
        {items.map((item, index) => (
          // Items have no stable id — they are positional content, and the list is re-rendered
          // wholesale on every change, so the index is the honest key here.
          <li key={`${index}-${item.slice(0, 12)}`}>{item}</li>
        ))}
      </Tag>
    </ZoneBox>
  );
}

/**
 * The 16:9 slide frame. Establishes the containment context `ptToCqh` depends on, so type scales
 * with the frame. Every preview and thumbnail renders inside one of these.
 */
export function SlideFrame(
  { tokens, background, children }: {
    tokens: DesignTokens;
    /** Templated mode: a servable URL from `AssetStore.resolve`. */
    background?: { url: string; contain?: boolean };
    children: ReactNode;
  },
): ReactNode {
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "16 / 9",
        width: "100%",
        containerType: "size",
        overflow: "hidden",
        backgroundColor: `#${tokens.colors.background}`,
        // `contain` mirrors the exporter's letterbox choice (§1.1/C2) rather than cropping.
        ...(background
          ? {
            backgroundImage: `url(${background.url})`,
            backgroundSize: background.contain ? "contain" : "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }
          : {}),
      }}
    >
      {children}
    </div>
  );
}

/* ── token → style helpers, mirroring `pptx-text.ts`'s pair exactly ── */

export const previewHeading = (
  tokens: DesignTokens, size: number, color: string,
): ZoneStyle => ({
  fontFamily: tokens.fonts.headingCss,
  fontSize: size,
  color,
  bold: true,
});

export const previewBody = (
  tokens: DesignTokens, size: number, color: string,
): ZoneStyle => ({
  fontFamily: tokens.fonts.bodyCss,
  fontSize: size,
  color,
  lineHeight: 1.2,
});
