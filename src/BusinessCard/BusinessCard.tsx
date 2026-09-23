"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import "./BusinessCard.css";

export type BusinessCardLink = {
  label: string;
  value: string;
  href?: string;
};

export type BusinessCardProps = {
  name: string;
  role: string;
  handle: string;
  avatar: { src: string; alt: string };
  tagline?: ReactNode;
  footnote?: string;
  links: BusinessCardLink[];
  monogram?: ReactNode;
  defaultOpen?: boolean;
  showControls?: boolean;
  className?: string;
};

// One page at scale 1. The card scales down when its container is narrower than the open spread.
const PAGE_WIDTH = 240;
const PAGE_HEIGHT = 336;
// Camera distance, measured from the reference video: at 60° the free edge is ~22% taller.
const PERSPECTIVE = PAGE_WIDTH * 5;
const RADIUS = 14;
const BORDER = 2;
// Pointer travel for a full open. The free edge crosses about 1.5 pages on screen.
const DRAG_DISTANCE = PAGE_WIDTH * 1.5;
const DRAG_SLOP = 4;
const FLICK_VELOCITY = 1.2;
const STIFFNESS = 190;
const DAMPING = 25;

type Side = "front" | "back";

// The cover is a flat sheet hinged on its left edge. Only its silhouette is a real 3D transform;
// the face content stays flat (so the text stays sharp) and is clipped to the projected width.
function fold(progress: number) {
  const theta = progress * Math.PI;
  const degrees = progress * 180;
  // Slide the hinge right as the cover opens, so the closed card and the open spread are both centred.
  const hinge = PAGE_WIDTH / 2 + (PAGE_WIDTH / 4) * (1 - Math.cos(theta));
  const depth = PERSPECTIVE / (PERSPECTIVE - PAGE_WIDTH * Math.sin(theta));
  // Project the free edge through the stage's perspective origin (the stage centre, x = PAGE_WIDTH).
  const edge = PAGE_WIDTH + (hinge + PAGE_WIDTH * Math.cos(theta) - PAGE_WIDTH) * depth;
  const side: Side = edge >= hinge ? "front" : "back";
  // The crease line at the hinge fades out, so the open spread reads as one card.
  const crease = BORDER * (1 - progress);
  const windowLeft = side === "front" ? hinge + crease : edge + BORDER;
  const windowWidth = Math.max(0, Math.abs(edge - hinge) - crease - BORDER);
  // 0 when the visible face lies flat, 1 when it is edge-on to the viewer.
  const turn = side === "front" ? degrees / 90 : (180 - degrees) / 90;
  // Shadow the cover throws on the page below it.
  const cast = theta <= Math.PI / 2 ? Math.sin(theta) ** 0.6 : (1 + Math.cos(theta)) ** 0.75;

  return {
    side,
    vars: {
      "--bc-p": progress.toFixed(4),
      "--bc-hinge": `${hinge}px`,
      "--bc-angle": `${-degrees}deg`,
      "--bc-window-left": `${windowLeft}px`,
      "--bc-window-width": `${windowWidth}px`,
      "--bc-hinge-radius": `${RADIUS * Math.max(0, 1 - progress * 4)}px`,
      "--bc-turn": turn.toFixed(4),
      "--bc-cast": (0.75 * cast).toFixed(4),
    },
  };
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function readout(progress: number) {
  return `p ${progress.toFixed(2)} / θ ${Math.round(progress * 180)}°`;
}

// A cover face, drawn twice: a sharp copy and a blurred copy, cross-faded toward the free edge.
// A backdrop-filter would be one layer, but it blurs in the black silhouette around the window.
function Face({
  side,
  faceRef,
  children,
}: {
  side: Side;
  faceRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <div ref={faceRef} className={`bc-face bc-face--${side}`}>
      <div className="bc-page bc-face-sharp">{children}</div>
      <div className="bc-page bc-face-blurred" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

type Drag = {
  pointerId: number;
  startX: number;
  startProgress: number;
  moved: boolean;
  samples: { time: number; progress: number }[];
};

export function BusinessCard({
  name,
  role,
  handle,
  avatar,
  tagline,
  footnote,
  links,
  monogram,
  defaultOpen = false,
  showControls = true,
  className,
}: BusinessCardProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const insideRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const readoutRef = useRef<HTMLParagraphElement>(null);

  const progressRef = useRef(defaultOpen ? 1 : 0);
  const scaleRef = useRef(1);
  const frameRef = useRef(0);
  const dragRef = useRef<Drag | null>(null);
  const swallowClickRef = useRef(false);

  const [open, setOpen] = useState(defaultOpen);
  const [scale, setScale] = useState(1);

  // Server and first-paint state. After mount, frames write straight to the DOM instead of re-rendering.
  const initial = useMemo(() => fold(progressRef.current), []);

  function paint(progress: number) {
    progressRef.current = progress;
    const root = rootRef.current;
    if (!root) return;
    const { side, vars } = fold(progress);
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
    root.dataset.side = side;
    root.toggleAttribute("data-resting", progress === 0 || progress === 1);
    if (sliderRef.current) {
      sliderRef.current.value = String(progress);
      sliderRef.current.setAttribute("aria-valuetext", `${Math.round(progress * 100)}% open`);
    }
    if (readoutRef.current) readoutRef.current.textContent = readout(progress);
    setOpen(progress >= 0.5);
  }

  function stop() {
    cancelAnimationFrame(frameRef.current);
  }

  function settle(target: number, velocity = 0) {
    stop();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paint(target);
      return;
    }
    let position = progressRef.current;
    let speed = velocity;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      speed += (-STIFFNESS * (position - target) - DAMPING * speed) * dt;
      position += speed * dt;
      // The cover lands flat on the page or the table; it never swings through either.
      if (position <= 0 || position >= 1) {
        position = clamp01(position);
        speed = 0;
      }
      if (Math.abs(position - target) < 0.0005 && Math.abs(speed) < 0.01) {
        paint(target);
        return;
      }
      paint(position);
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.min(1, entry.contentRect.width / (PAGE_WIDTH * 2));
      scaleRef.current = next;
      setScale(next);
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  // Keep hidden pages out of the tab order and the accessibility tree.
  useEffect(() => {
    if (frontRef.current) frontRef.current.inert = open;
    if (backRef.current) backRef.current.inert = !open;
    if (insideRef.current) insideRef.current.inert = !open;
  }, [open]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    stop();
    swallowClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startProgress: progressRef.current,
      moved: false,
      samples: [{ time: event.timeStamp, progress: progressRef.current }],
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / scaleRef.current;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      drag.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      rootRef.current?.setAttribute("data-dragging", "");
    }
    const progress = clamp01(drag.startProgress - dx / DRAG_DISTANCE);
    paint(progress);
    drag.samples.push({ time: event.timeStamp, progress });
    while (drag.samples.length > 2 && event.timeStamp - drag.samples[0].time > 100) drag.samples.shift();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    rootRef.current?.removeAttribute("data-dragging");

    if (!drag.moved) {
      // A tap toggles the card, unless it landed on a link.
      if (!(event.target as Element).closest("a")) settle(progressRef.current < 0.5 ? 1 : 0);
      return;
    }

    swallowClickRef.current = true;
    const first = drag.samples[0];
    const last = drag.samples[drag.samples.length - 1];
    const elapsed = (last.time - first.time) / 1000;
    const velocity = elapsed > 0 ? (last.progress - first.progress) / elapsed : 0;
    const flicked = Math.abs(velocity) > FLICK_VELOCITY;
    settle(flicked ? (velocity > 0 ? 1 : 0) : Math.round(progressRef.current), velocity);
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    rootRef.current?.removeAttribute("data-dragging");
    settle(Math.round(progressRef.current));
  }

  const style = {
    "--bc-w": `${PAGE_WIDTH}px`,
    "--bc-h": `${PAGE_HEIGHT}px`,
    "--bc-perspective": `${PERSPECTIVE}px`,
    "--bc-radius": `${RADIUS}px`,
    "--bc-border": `${BORDER}px`,
    ...initial.vars,
  } as CSSProperties;

  const header = (
    <div className="bc-header">
      <span className="bc-monogram">{monogram}</span>
      <span className="bc-mono bc-muted">{handle}</span>
    </div>
  );

  const signature = (
    <div className="bc-signature">
      <p className="bc-name">{name}</p>
      <p className="bc-role">{role}</p>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={className ? `bc ${className}` : "bc"}
      data-side={initial.side}
      data-resting=""
      style={style}
    >
      <div
        className="bc-viewport"
        style={{ width: PAGE_WIDTH * 2 * scale, height: PAGE_HEIGHT * scale }}
      >
        <div
          className="bc-stage"
          style={{ transform: `scale(${scale})` }}
          role="group"
          aria-roledescription="business card"
          aria-label={name}
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
          <div className="bc-base">
            <div ref={insideRef} className="bc-page bc-page--inside">
              {header}
              <dl className="bc-links">
                {links.map((link) => (
                  <div key={link.label} className="bc-link">
                    <dt className="bc-muted">{link.label}</dt>
                    <dd>
                      {link.href ? (
                        <a href={link.href} target="_blank" rel="noreferrer" draggable={false}>
                          {link.value}
                        </a>
                      ) : (
                        link.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              {signature}
            </div>
          </div>

          <div className="bc-silhouette" aria-hidden="true" />

          <div className="bc-window">
            <Face faceRef={frontRef} side="front">
              {header}
              {signature}
            </Face>
            <Face faceRef={backRef} side="back">
              <img
                className="bc-avatar"
                src={avatar.src}
                alt={avatar.alt}
                width={56}
                height={56}
                draggable={false}
              />
              <div className="bc-about">
                {tagline ? <p className="bc-tagline">{tagline}</p> : null}
                {footnote ? <p className="bc-mono bc-muted">{footnote}</p> : null}
              </div>
            </Face>
            <div className="bc-shade" aria-hidden="true" />
          </div>
        </div>
      </div>

      {showControls ? (
        <div className="bc-controls" style={{ width: PAGE_WIDTH * scale }}>
          <p className="bc-hint">Drag the page or the slider.</p>
          <input
            ref={sliderRef}
            className="bc-slider"
            type="range"
            min={0}
            max={1}
            step={0.001}
            defaultValue={progressRef.current}
            aria-label="Open the card"
            onInput={(event) => {
              stop();
              paint(Number(event.currentTarget.value));
            }}
          />
          <p ref={readoutRef} className="bc-mono bc-muted" aria-hidden="true">
            {readout(progressRef.current)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
