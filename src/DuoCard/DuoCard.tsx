"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BusinessCard } from "../BusinessCard/BusinessCard";
import { PixelMark } from "../BusinessCard/PixelMark";
import { BODY, INNER_SCREEN, layoutShape, type Layout } from "./geometry";
import { TEXELS_PER_UNIT, type HomeApp, type LinkRect } from "./content";
import { fetchContributions } from "./github";
import { createMeter, perfEnabled } from "./perf";
import {
  EYE_Z,
  FRAME_UNITS,
  SHADOW_MARGIN,
  createRenderer,
  fullscreenCamera,
  fullscreenEdge,
  screenEdge,
  viewCenter,
  type Renderer,
} from "./renderer";
import "@fontsource/instrument-serif";
import "@fontsource-variable/inter";
import "./DuoCard.css";

export type DuoCardProps = {
  name: string;
  role: string;
  handle: string;
  avatar: { src: string; alt: string };
  footnote?: string;
  // The contribution graph on the home screen: whose, fetched live, and where it links.
  github: { login: string; href: string };
  // The apps on the home screen on the left page: projects, and profiles elsewhere.
  apps: HomeApp[];
  // The home screen's wallpaper, shown blurred. Same-origin or served with CORS.
  wallpaper?: string;
  // Start open rather than closed.
  defaultOpen?: boolean;
  // Show the play button and the fold slider.
  controls?: boolean;
  className?: string;
};

// Timing from the reference: the play loop holds open, closes over 3.1 s, holds closed, opens
// over 3.1 s; any other change eases with a 1.4 s smoothstep.
const LOOP = 8.6;
const HOLD = 1.2;
const SWING = 3.1;
const TRANSITION = 1.4;
const DRAG_SLOP = 4;
// Seconds for the name on the front to move fully into its readable place. A card that opens from
// closed waits for it, so the name does not move while the cover swings, as it moves back only once
// the card has closed.
const REVEAL = 0.9;

function loopAngle(phase: number) {
  if (phase < HOLD) return 180;
  if (phase < HOLD + SWING) return 90 * (1 + Math.cos(((phase - HOLD) / SWING) * Math.PI));
  if (phase < HOLD * 2 + SWING) return 0;
  return 90 * (1 - Math.cos(((phase - HOLD * 2 - SWING) / SWING) * Math.PI));
}

// The angle whose free edge draws at `x` on screen. The edge is monotonic in the angle, so bisect.
function angleForEdge(x: number, edgeAt: (angle: number) => number) {
  let low = 0;
  let high = 180;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (edgeAt(mid) > x) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

// A phone held upright: there the card fills the screen.
const FULLSCREEN = "(max-width: 767px) and (max-aspect-ratio: 3/4)";

/**
 * The layout for the viewport now. A small change of shape, such as a browser bar that shows, keeps
 * the card as it is: its view covers the screen and crops the page a little. A larger change builds
 * the card again in the new shape.
 */
function currentLayout(previous: Layout | null): Layout {
  if (!matchMedia(FULLSCREEN).matches) return previous?.kind === "page" ? previous : { kind: "page" };
  const aspect = innerWidth / innerHeight;
  if (previous?.kind === "fullscreen" && Math.abs(aspect / previous.aspect - 1) < 0.04) return previous;
  return { kind: "fullscreen", aspect };
}

type Motion =
  | { kind: "idle" }
  | { kind: "playing"; phase: number }
  // `elapsed` starts below zero by the time the fold waits for the name.
  | { kind: "transition"; from: number; to: number; elapsed: number; duration: number };

export function DuoCard(props: DuoCardProps) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const angleRef = useRef(props.defaultOpen ? 180 : 0);
  const motionRef = useRef<Motion>({ kind: "idle" });
  const dirtyRef = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(!!props.defaultOpen);
  // Closed or open, not on the way: the only states where the name takes a hover.
  const [resting, setResting] = useState(true);
  const [nameArea, setNameArea] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [edgeColors, setEdgeColors] = useState<{ closed: string; open: string } | null>(null);
  // The name's reveal. It shows while the mouse rests on the name, while a click opens the card, and
  // whenever the card is not fully closed.
  const revealRef = useRef({ value: 0, hovering: false });
  const [links, setLinks] = useState<LinkRect[]>([]);
  // The viewport's size in CSS pixels.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // Measured on the client before the first paint, so the card is built once, in the right shape.
  const [layout, setLayout] = useState<Layout | null>(null);
  const shape = useMemo(() => layout && layoutShape(layout), [layout]);
  const fullscreen = layout?.kind === "fullscreen";
  const dragRef = useRef<{ id: number; x: number; edge: number; moved: boolean; link: boolean } | null>(null);
  const swallowClickRef = useRef(false);

  function setAngle(value: number) {
    angleRef.current = value;
    dirtyRef.current = true;
    if (sliderRef.current) {
      sliderRef.current.value = String(value);
      sliderRef.current.style.setProperty("--progress", `${value / 1.8}%`);
    }
    setOpen(value >= 180);
    setResting(value >= 180 || value <= 0);
  }

  function transitionTo(to: number) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      motionRef.current = { kind: "idle" };
      setPlaying(false);
      setAngle(to);
      return;
    }
    const from = angleRef.current;
    const duration = Math.max(0.3, (TRANSITION * Math.abs(to - from)) / 180);
    const wait = from === 0 && to > 0 ? (1 - revealRef.current.value) * REVEAL : 0;
    motionRef.current = { kind: "transition", from, to, elapsed: -wait, duration };
    setPlaying(false);
  }

  useLayoutEffect(() => {
    setLayout((previous) => currentLayout(previous));
    let timer = 0;
    const onResize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setLayout((previous) => currentLayout(previous)), 150);
    };
    addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const root = rootRef.current;
    if (!viewport || !root || !layout) return;
    // A canvas per mount: a WebGPU context belongs to one device, and a remount must not
    // unconfigure the canvas the next renderer draws into.
    const canvas = document.createElement("canvas");
    canvas.className = "duo-canvas";
    canvas.setAttribute("aria-hidden", "true");
    // The shadow's canvas, behind the card's. On the page it is larger by SHADOW_MARGIN model units
    // on every side; filling the screen, it is the same size.
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.className = "duo-shadow";
    shadowCanvas.setAttribute("aria-hidden", "true");
    const marginX = fullscreen ? 0 : (SHADOW_MARGIN / FRAME_UNITS.width) * 100;
    const marginY = fullscreen ? 0 : (SHADOW_MARGIN / FRAME_UNITS.height) * 100;
    Object.assign(shadowCanvas.style, {
      left: `${-marginX}%`,
      top: `${-marginY}%`,
      width: `${100 + 2 * marginX}%`,
      height: `${100 + 2 * marginY}%`,
    });
    viewport.prepend(shadowCanvas, canvas);
    let disposed = false;
    let frameId = 0;
    const contributions = new AbortController();
    const meter = perfEnabled() ? createMeter() : null;
    const style = getComputedStyle(root);
    const fonts = {
      sans: style.fontFamily,
      mono: style.getPropertyValue("--duo-mono") || "ui-monospace, monospace",
      display: style.getPropertyValue("--duo-display") || style.fontFamily,
    };

    createRenderer(
      canvas,
      shadowCanvas,
      {
        name: props.name,
        role: props.role,
        handle: props.handle,
        footnote: props.footnote,
        github: { href: props.github.href, days: [] },
        apps: props.apps,
        wallpaper: props.wallpaper,
      },
      fonts,
      layout,
      meter,
    ).then(
      (renderer) => {
        if (disposed) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;
        meter?.benchmark(renderer.bench);
        setLinks(renderer.links);
        setNameArea(renderer.nameArea);
        setEdgeColors(renderer.edgeColors);
        setSupported(true);
        fetchContributions(props.github.login, contributions.signal).then(
          (days) => {
            if (disposed) return;
            renderer.contributions(days);
            dirtyRef.current = true;
          },
          (error) => {
            if (!contributions.signal.aborted) console.warn("[duo-card] contribution graph:", error);
          },
        );
        let last = performance.now();
        // One frame: moves the card on by `dt`, and draws it if anything changed. True if it drew.
        const step = (now: number) => {
          const dt = Math.min((now - last) / 1000, 0.05);
          last = now;
          const motion = motionRef.current;
          if (motion.kind === "playing") {
            motion.phase = (motion.phase + dt) % LOOP;
            setAngle(loopAngle(motion.phase));
          } else if (motion.kind === "transition") {
            motion.elapsed += dt;
            const t = Math.min(Math.max(0, motion.elapsed) / motion.duration, 1);
            const ease = t * t * (3 - 2 * t);
            setAngle(motion.from + (motion.to - motion.from) * ease);
            if (t === 1) motionRef.current = { kind: "idle" };
          }
          const reveal = revealRef.current;
          const opening = motionRef.current.kind === "transition" && motionRef.current.to > motionRef.current.from;
          const target = reveal.hovering || opening || angleRef.current > 0 ? 1 : 0;
          if (reveal.value !== target) {
            const step = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : dt / REVEAL;
            reveal.value = target > reveal.value ? Math.min(target, reveal.value + step) : Math.max(target, reveal.value - step);
            dirtyRef.current = true;
          }
          if (!dirtyRef.current) return false;
          dirtyRef.current = false;
          renderer.render(angleRef.current, reveal.value);
          return true;
        };
        const tick = (now: number) => {
          if (meter) meter.frame(now, () => step(now));
          else step(now);
          frameId = requestAnimationFrame(tick);
        };
        frameId = requestAnimationFrame(tick);
      },
      () => {
        if (!disposed) setSupported(false);
      },
    );

    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      dirtyRef.current = true;
    });
    observer.observe(canvas);

    return () => {
      disposed = true;
      contributions.abort();
      cancelAnimationFrame(frameId);
      meter?.dispose();
      observer.disconnect();
      rendererRef.current?.dispose();
      rendererRef.current = null;
      canvas.remove();
      shadowCanvas.remove();
    };
    // The card content is drawn once per mount, and again for a new layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Filling the screen, the card at rest also sets the colour of the browser's own bars: the colour
  // along its edge, the front's closed and the home screen's open. Chrome and older Safari read it
  // from the theme-color, Safari 26 from the background of the fixed viewport, which the card covers.
  // On the way the page shows round the card, and the bars take the page's colour again.
  const barColor = fullscreen && resting && edgeColors ? (open ? edgeColors.open : edgeColors.closed) : null;
  useEffect(() => {
    if (!barColor) return;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const added = !meta;
    meta ??= document.head.appendChild(Object.assign(document.createElement("meta"), { name: "theme-color" }));
    const page = meta.content;
    meta.content = barColor;
    return () => {
      if (added) meta.remove();
      else meta.content = page;
    };
  }, [barColor]);

  // Where the cover's free edge draws: on the page in model units after the pan, filling the screen
  // in view widths.
  function edgeAt(angle: number) {
    if (fullscreen && shape && size) return fullscreenEdge(shape, angle, size.width / size.height);
    return screenEdge(angle);
  }

  // A press on a link can still fold the card: it only follows the link if it does not move.
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    swallowClickRef.current = false;
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      edge: edgeAt(angleRef.current),
      moved: false,
      link: (event.target as Element).closest("a") !== null,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId || !size) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      motionRef.current = { kind: "idle" };
      setPlaying(false);
    }
    if (fullscreen) {
      setAngle(angleForEdge(drag.edge + dx / size.width, edgeAt));
      return;
    }
    // Model units on the card's plane per CSS pixel. FRAME_UNITS is measured at depth EYE_Z.
    const scale = size.height / FRAME_UNITS.height;
    setAngle(angleForEdge(drag.edge + (dx / scale) * ((EYE_Z - BODY.top) / EYE_Z), edgeAt));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) {
      swallowClickRef.current = true;
      transitionTo(angleRef.current < 90 ? 0 : 180);
    } else if (!drag.link) transitionTo(angleRef.current < 90 ? 180 : 0);
  }

  // The browser took the pointer over, for example to scroll the page. That is
  // not a tap, so the card only settles if it was being dragged.
  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    if (drag.moved) transitionTo(angleRef.current < 90 ? 0 : 180);
  }

  function togglePlay() {
    if (motionRef.current.kind === "playing") {
      motionRef.current = { kind: "idle" };
      setPlaying(false);
      return;
    }
    // Enter the loop at the point on the closing swing that matches the current angle.
    const phase = HOLD + (Math.acos((2 * angleRef.current) / 180 - 1) / Math.PI) * SWING;
    motionRef.current = { kind: "playing", phase };
    setPlaying(true);
  }

  if (supported === false) {
    return (
      <BusinessCard
        {...props}
        links={[{ label: "GitHub", value: props.handle, href: props.github.href }]}
        monogram={<PixelMark />}
        defaultOpen={props.defaultOpen}
        showControls={props.controls}
        className={props.className}
      />
    );
  }

  // The links and the project list are on the cover. They only take input while the cover lies
  // open, flat in the fixed half's plane, so their screen position is exact. The view moves as the
  // card opens; overlays only take input at rest, closed or open, so they follow the rest view: its
  // middle on x, and CSS pixels per model unit on the card's plane.
  const rest = (() => {
    if (!size || !shape) return null;
    if (!fullscreen) return { center: viewCenter(open ? 180 : 0), perUnit: (EYE_Z / (EYE_Z - BODY.top)) * (size.height / FRAME_UNITS.height) };
    const view = fullscreenCamera(shape, open ? 180 : 0, size.width / size.height);
    return { center: view.center, perUnit: size.height / view.unitsTall };
  })();
  // A box on the inner image, in texels, placed over where it draws.
  const place = (box: { x: number; y: number; width: number; height: number }): CSSProperties => {
    if (!rest || !size || !shape) return { display: "none" };
    const perTexel = rest.perUnit / TEXELS_PER_UNIT;
    return {
      left: size.width / 2 + (INNER_SCREEN.x + box.x / TEXELS_PER_UNIT - rest.center) * rest.perUnit,
      top: size.height / 2 - (shape.screenHeight / 2 - box.y / TEXELS_PER_UNIT) * rest.perUnit,
      width: box.width * perTexel,
      height: box.height * perTexel,
    };
  };

  return (
    <div ref={rootRef} className={["duo", fullscreen && "duo--fullscreen", props.className].filter(Boolean).join(" ")}>
      <div
        ref={viewportRef}
        className="duo-viewport"
        style={fullscreen ? { backgroundColor: barColor ?? undefined } : { aspectRatio: `${FRAME_UNITS.width} / ${FRAME_UNITS.height}` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={(event) => {
          if (!swallowClickRef.current) return;
          swallowClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {nameArea ? (
          // On the closed card, the name reveals while the mouse rests on it. Once the card opens it
          // stays revealed (see revealRef).
          <div
            className="duo-name"
            data-resting={resting ? "" : undefined}
            aria-hidden="true"
            style={place(nameArea)}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") revealRef.current.hovering = true;
            }}
            onPointerLeave={() => {
              revealRef.current.hovering = false;
            }}
          />
        ) : null}
        <div className="duo-links" data-open={open ? "" : undefined}>
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              aria-label={link.label}
              draggable={false}
              tabIndex={open ? 0 : -1}
              style={{ ...place(link), borderRadius: rest ? (link.radius * rest.perUnit) / TEXELS_PER_UNIT : 0 }}
            />
          ))}
        </div>
        <div className="duo-sr">
          <p>{props.name}</p>
          <p>{props.role}</p>
          {props.footnote ? <p>{props.footnote}</p> : null}
        </div>
      </div>

      {props.controls ? (
        <div className="duo-dock">
          <button type="button" className="duo-play" onClick={togglePlay} aria-label={playing ? "Pause animation" : "Play animation"} disabled={!supported}>
            {playing ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 6v12M16 6v12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true" className="duo-play-icon">
                <path d="m9 5 10 7-10 7Z" />
              </svg>
            )}
          </button>
          <input
            ref={sliderRef}
            className="duo-slider"
            type="range"
            min={0}
            max={180}
            step={0.1}
            defaultValue={angleRef.current}
            style={{ "--progress": `${angleRef.current / 1.8}%` } as CSSProperties}
            aria-label="Fold progress"
            disabled={!supported}
            onInput={(event) => {
              motionRef.current = { kind: "idle" };
              setPlaying(false);
              setAngle(Number(event.currentTarget.value));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
