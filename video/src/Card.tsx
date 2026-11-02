import { useEffect, useRef, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { TEXELS_PER_UNIT } from "../../src/DuoCard/content";
import { BODY, CARD_SHAPE, INNER_SCREEN } from "../../src/DuoCard/geometry";
import type { ContributionDay } from "../../src/DuoCard/github";
import { EYE_Z, FRAME_UNITS, SHADOW_MARGIN, createRenderer, viewCenter, type Renderer } from "../../src/DuoCard/renderer";
import { profile } from "../../src/profile";
import { Cursor, type Path } from "./Cursor";
import { SCRIPT, cardAt } from "./timeline";
import "@fontsource/instrument-serif";
import "@fontsource-variable/inter";
import "../../src/DuoCard/DuoCard.css";

export type CardProps = {
  // The contribution graph's days, fetched once for the whole render (see Root).
  days: ContributionDay[];
};

// The page, as in src/app.css.
const PAGE = "#f6f6f3";
const SANS = '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

// The card's frame, as a part of the video's width.
const CARD_WIDTH = 0.94;

/** The card on the page, as onkie.dev shows it on a desktop, opened and closed again by a cursor. */
export function Card({ days }: CardProps) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shadowRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  // Held until the first frame has drawn.
  const [building] = useState(() => delayRender("Building the card"));
  const builtRef = useRef(false);

  useEffect(() => {
    const root = rootRef.current!;
    const style = getComputedStyle(root);
    const fonts = {
      sans: style.fontFamily,
      mono: style.getPropertyValue("--duo-mono"),
      display: style.getPropertyValue("--duo-display"),
    };
    let disposed = false;
    let made: Renderer | null = null;
    createRenderer(
      canvasRef.current!,
      shadowRef.current!,
      {
        name: profile.name,
        role: profile.role,
        handle: profile.handle,
        footnote: profile.footnote,
        github: { href: profile.github.href, days },
        apps: profile.apps,
        wallpaper: profile.wallpaper,
      },
      fonts,
      { kind: "page" },
    ).then((next) => {
      if (disposed) return next.dispose();
      made = next;
      setRenderer(next);
    }, cancelRender);
    return () => {
      disposed = true;
      made?.dispose();
    };
  }, [days]);

  useEffect(() => {
    if (!renderer) return;
    const drawing = delayRender(`Drawing frame ${frame}`);
    const { angle, reveal } = cardAt(frame, fps);
    renderer.render(angle, reveal);
    renderer.settled().then(() => {
      continueRender(drawing);
      if (builtRef.current) return;
      builtRef.current = true;
      continueRender(building);
    }, cancelRender);
  }, [renderer, frame, fps, building]);

  // The card's frame on the video, and CSS pixels per model unit on the card's plane (see DuoCard).
  const frameWidth = width * CARD_WIDTH;
  const frameHeight = (frameWidth * FRAME_UNITS.height) / FRAME_UNITS.width;
  const frameLeft = (width - frameWidth) / 2;
  const frameTop = (height - frameHeight) / 2;
  const perUnit = (EYE_Z / (EYE_Z - BODY.top)) * (frameHeight / FRAME_UNITS.height);
  const onCard = (x: number, y: number) => ({
    x: frameLeft + frameWidth / 2 + (x - viewCenter(180)) * perUnit,
    y: frameTop + frameHeight / 2 - y * perUnit,
  });
  // The middle of the name on the closed card.
  const name = (() => {
    const area = renderer?.nameArea;
    if (!area) return { x: width / 2, y: height / 2 };
    const x = INNER_SCREEN.x + (area.x + area.width / 2) / TEXELS_PER_UNIT;
    const y = CARD_SHAPE.screenHeight / 2 - (area.y + area.height / 2) / TEXELS_PER_UNIT;
    return { x: frameLeft + frameWidth / 2 + (x - viewCenter(0)) * perUnit, y: frameTop + frameHeight / 2 - y * perUnit };
  })();
  const away = { x: width * 0.9, y: height + 40 };
  // A spot on the open card with no link on it, low on the right page.
  const spot = onCard(4.2, -3.6);
  const path: Path = [
    { t: 0.5, at: away },
    { t: SCRIPT.arrive, at: name },
    { t: SCRIPT.leave, at: name },
    { t: SCRIPT.close - 0.5, at: spot },
    { t: SCRIPT.close + 0.4, at: spot },
    { t: SCRIPT.close + 1.6, at: away },
  ];

  const margin = { x: (SHADOW_MARGIN / FRAME_UNITS.width) * 100, y: (SHADOW_MARGIN / FRAME_UNITS.height) * 100 };
  return (
    <AbsoluteFill style={{ background: PAGE }}>
      <div ref={rootRef} className="duo" style={{ position: "absolute", left: frameLeft, top: frameTop, width: frameWidth, fontFamily: SANS }}>
        <div className="duo-viewport" style={{ aspectRatio: `${FRAME_UNITS.width} / ${FRAME_UNITS.height}` }}>
          <canvas
            ref={shadowRef}
            className="duo-shadow"
            style={{ left: `${-margin.x}%`, top: `${-margin.y}%`, width: `${100 + 2 * margin.x}%`, height: `${100 + 2 * margin.y}%` }}
          />
          <canvas ref={canvasRef} className="duo-canvas" />
        </div>
      </div>
      <Cursor path={path} clicks={[SCRIPT.open, SCRIPT.close]} time={frame / fps} />
    </AbsoluteFill>
  );
}
