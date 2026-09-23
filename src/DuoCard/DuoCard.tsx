"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BusinessCard } from "../BusinessCard/BusinessCard";
import { PixelMark } from "../BusinessCard/PixelMark";
import { BODY, INNER_SCREEN } from "./geometry";
import { TEXELS_PER_UNIT, type HomeApp, type LinkRect } from "./content";
import { fetchContributions } from "./github";
import { EYE_Z, FRAME_UNITS, SHADOW_MARGIN, createRenderer, screenEdge, viewCenter, type Renderer } from "./renderer";
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
// Seconds for the name on the front to move fully into its readable place.
const REVEAL = 0.9;

function loopAngle(phase: number) {
  if (phase < HOLD) return 180;
  if (phase < HOLD + SWING) return 90 * (1 + Math.cos(((phase - HOLD) / SWING) * Math.PI));
  if (phase < HOLD * 2 + SWING) return 0;
  return 90 * (1 - Math.cos(((phase - HOLD * 2 - SWING) / SWING) * Math.PI));
}

// The angle whose free edge draws at `x` on screen. The edge is monotonic in the angle, so bisect.
function angleForEdge(x: number) {
  let low = 0;
  let high = 180;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (screenEdge(mid) > x) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

type Motion =
  | { kind: "idle" }
  | { kind: "playing"; phase: number }
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
  // The name's reveal. It shows while the mouse rests on the name, and whenever the card is not
  // fully closed, so a click that opens the card keeps the name readable.
  const revealRef = useRef({ value: 0, hovering: false });
  const [links, setLinks] = useState<LinkRect[]>([]);
  const [scale, setScale] = useState(0);
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
    motionRef.current = { kind: "transition", from, to, elapsed: 0, duration };
    setPlaying(false);
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    const root = rootRef.current;
    if (!viewport || !root) return;
    // A canvas per mount: a WebGPU context belongs to one device, and a remount must not
    // unconfigure the canvas the next renderer draws into.
    const canvas = document.createElement("canvas");
    canvas.className = "duo-canvas";
    canvas.setAttribute("aria-hidden", "true");
    // The shadow's canvas, behind the card's and larger by SHADOW_MARGIN model units on every side.
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.className = "duo-shadow";
    shadowCanvas.setAttribute("aria-hidden", "true");
    const marginX = (SHADOW_MARGIN / FRAME_UNITS.width) * 100;
    const marginY = (SHADOW_MARGIN / FRAME_UNITS.height) * 100;
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
    ).then(
      (renderer) => {
        if (disposed) {
          renderer.dispose();
          return;
        }
        rendererRef.current = renderer;
        setLinks(renderer.links);
        setNameArea(renderer.nameArea);
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
        const tick = (now: number) => {
          const dt = Math.min((now - last) / 1000, 0.05);
          last = now;
          const motion = motionRef.current;
          if (motion.kind === "playing") {
            motion.phase = (motion.phase + dt) % LOOP;
            setAngle(loopAngle(motion.phase));
          } else if (motion.kind === "transition") {
            motion.elapsed += dt;
            const t = Math.min(motion.elapsed / motion.duration, 1);
            const ease = t * t * (3 - 2 * t);
            setAngle(motion.from + (motion.to - motion.from) * ease);
            if (t === 1) motionRef.current = { kind: "idle" };
          }
          const reveal = revealRef.current;
          const target = reveal.hovering || angleRef.current > 0 ? 1 : 0;
          if (reveal.value !== target) {
            const step = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : dt / REVEAL;
            reveal.value = target > reveal.value ? Math.min(target, reveal.value + step) : Math.max(target, reveal.value - step);
            dirtyRef.current = true;
          }
          if (dirtyRef.current) {
            dirtyRef.current = false;
            renderer.render(angleRef.current, reveal.value);
          }
          frameId = requestAnimationFrame(tick);
        };
        frameId = requestAnimationFrame(tick);
      },
      () => {
        if (!disposed) setSupported(false);
      },
    );

    const observer = new ResizeObserver(([entry]) => {
      // CSS pixels per model unit on the z = 0 plane. The field of view is set by height.
      setScale(entry.contentRect.height / FRAME_UNITS.height);
      dirtyRef.current = true;
    });
    observer.observe(canvas);

    return () => {
      disposed = true;
      contributions.abort();
      cancelAnimationFrame(frameId);
      observer.disconnect();
      rendererRef.current?.dispose();
      rendererRef.current = null;
      canvas.remove();
      shadowCanvas.remove();
    };
    // The card content is drawn once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A press on a link can still fold the card: it only follows the link if it does not move.
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    swallowClickRef.current = false;
    dragRef.current = {
      id: event.pointerId,
      x: event.clientX,
      edge: screenEdge(angleRef.current),
      moved: false,
      link: (event.target as Element).closest("a") !== null,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId || !scale) return;
    const dx = event.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      motionRef.current = { kind: "idle" };
      setPlaying(false);
    }
    // Model units on the card's plane per CSS pixel: `scale` is measured at depth EYE_Z.
    setAngle(angleForEdge(drag.edge + (dx / scale) * ((EYE_Z - BODY.top) / EYE_Z)));
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
  // open, flat in the fixed half's plane, so their screen position is exact.
  const depthScale = EYE_Z / (EYE_Z - BODY.top);
  const cssPerTexel = (depthScale * scale) / TEXELS_PER_UNIT;
  // The view pans to keep the card centred; overlays only take input at rest, closed or open.
  const pan = viewCenter(open ? 180 : 0);
  const toCss = (texX: number, texY: number) => ({
    left: `calc(50% + ${(INNER_SCREEN.x + texX / TEXELS_PER_UNIT - pan) * depthScale * scale}px)`,
    top: `calc(50% - ${(INNER_SCREEN.y + INNER_SCREEN.height - texY / TEXELS_PER_UNIT) * depthScale * scale}px)`,
  });

  return (
    <div ref={rootRef} className={props.className ? `duo ${props.className}` : "duo"}>
      <div
        ref={viewportRef}
        className="duo-viewport"
        style={{ aspectRatio: `${FRAME_UNITS.width} / ${FRAME_UNITS.height}` }}
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
            style={{ ...toCss(nameArea.x, nameArea.y), width: nameArea.width * cssPerTexel, height: nameArea.height * cssPerTexel }}
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
              style={{
                ...toCss(link.x, link.y),
                width: link.width * cssPerTexel,
                height: link.height * cssPerTexel,
                borderRadius: link.radius * cssPerTexel,
              }}
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
