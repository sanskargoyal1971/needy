import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MotionPreferencesProvider, useMotionPreferences } from "../../preferences";
import { Doorstep3D, Float, IconTile3D, MapPin3D, VerifiedShield3D } from "../index";
import { BreathingBackground } from "@/components/BreathingBackground";

/**
 * jsdom has no IntersectionObserver, which is itself one of the cases worth pinning (no
 * observer → still objects). For the rest, a controllable stand-in: tests decide when an
 * element is on screen, the way scrolling would.
 */
class FakeObserver {
  static all: FakeObserver[] = [];
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  el: Element | null = null;
  observe(el: Element) {
    this.el = el;
  }
  disconnect() {
    this.el = null;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
  emit(visible: boolean) {
    if (!this.el) return;
    this.cb(
      [{ isIntersecting: visible, target: this.el } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function emitAll(visible: boolean) {
  act(() => FakeObserver.all.forEach((o) => o.emit(visible)));
}

const OBJECTS: [string, () => ReactElement][] = [
  ["VerifiedShield3D", () => <VerifiedShield3D />],
  ["MapPin3D", () => <MapPin3D />],
  ["Doorstep3D", () => <Doorstep3D />],
  [
    "IconTile3D",
    () => (
      <IconTile3D>
        <span>i</span>
      </IconTile3D>
    ),
  ],
];

function stage(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-motion]");
  if (!el) throw new Error("no stage rendered");
  return el;
}

/** jsdom declares `matchMedia` but leaves it unimplemented. `systemReduce` stands in for the
 *  OS-level "reduce motion" switch. */
let systemReduce = false;
beforeEach(() => {
  systemReduce = false;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("reduce") && systemReduce,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  FakeObserver.all = [];
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

describe("3D objects — without an IntersectionObserver", () => {
  it.each(OBJECTS)("%s renders still and hidden from assistive technology", (_, make) => {
    const { container } = render(make());
    const root = stage(container);
    expect(root.getAttribute("aria-hidden")).toBe("true");
    // Nothing to tell it when it is visible, so it must not animate blind.
    expect(root.dataset.motion).toBe("static");
  });
});

describe("3D objects — with an observer", () => {
  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  });

  it.each(OBJECTS)("%s stays still under reduced motion even when on screen", (_, make) => {
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="reduce">{make()}</MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("static");
    // Reduced motion does not even observe: there is nothing to pause.
    expect(FakeObserver.all.filter((o) => o.el)).toHaveLength(0);
  });

  it.each(OBJECTS)("%s follows the operating system's reduce-motion setting", (_, make) => {
    systemReduce = true;
    const { container } = render(<MotionPreferencesProvider>{make()}</MotionPreferencesProvider>);
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("static");
  });

  it.each(OBJECTS)("%s runs on screen when motion is allowed", (_, make) => {
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="allow">{make()}</MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("running");
  });

  it("waits off screen, enters when scrolled to, and pauses when scrolled away", () => {
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="allow">
        <VerifiedShield3D />
      </MotionPreferencesProvider>,
    );
    const root = stage(container);
    // Server render and first client render: still, so hydration matches.
    expect(root.dataset.motion).toBe("static");
    emitAll(false);
    expect(root.dataset.motion).toBe("waiting");
    emitAll(true);
    expect(root.dataset.motion).toBe("running");
    emitAll(false);
    expect(root.dataset.motion).toBe("paused");
  });

  it("does not hide an object that was already on screen at load", () => {
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="allow">
        <MapPin3D />
      </MotionPreferencesProvider>,
    );
    emitAll(true);
    emitAll(false);
    // Seen at load, then scrolled past: paused, never re-hidden for a second entrance.
    expect(stage(container).dataset.motion).toBe("paused");
  });

  it("stops when reduced motion is switched on while it is running", () => {
    let setOverride: (o: "system" | "reduce" | "allow") => void = () => {};
    function Grab() {
      setOverride = useMotionPreferences().setOverride;
      return null;
    }
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="allow">
        <Grab />
        <Doorstep3D />
      </MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("running");
    act(() => setOverride("reduce"));
    // Same mounted object, not a fresh one: the preference must reach a live loop.
    expect(stage(container).dataset.motion).toBe("static");
  });
});

describe("3D objects — pointer safety", () => {
  it("a backdrop stage takes no pointer events, so it cannot swallow a click", () => {
    const { container } = render(<VerifiedShield3D interactive={false} />);
    expect(stage(container).style.pointerEvents).toBe("none");
  });

  it("an interactive stage keeps pointer events for its own tilt", () => {
    const { container } = render(<VerifiedShield3D />);
    expect(stage(container).style.pointerEvents).toBe("");
  });

  it("lets a caller position it absolutely, so a backdrop never pushes the layout", () => {
    // `relative` and `absolute` together resolve to `relative` in Tailwind's output order.
    const { container } = render(<VerifiedShield3D className="absolute right-0" />);
    expect(stage(container).classList.contains("relative")).toBe(false);
    cleanup();
    const flow = render(<VerifiedShield3D className="mx-auto" />);
    expect(stage(flow.container).classList.contains("relative")).toBe(true);
  });

  it("holds no compositor layer while it is not moving", () => {
    const { container } = render(<IconTile3D>x</IconTile3D>);
    const promoted = [...container.querySelectorAll<HTMLElement>("*")].filter(
      (el) => el.style.willChange === "transform",
    );
    expect(promoted).toHaveLength(0);
  });
});

describe("Float", () => {
  it("is hidden from assistive technology only when decorative", () => {
    const { container } = render(
      <>
        <Float decorative>blob</Float>
        <Float>card</Float>
      </>,
    );
    const [decorative, content] = [...container.querySelectorAll("[data-motion]")];
    expect(decorative?.getAttribute("aria-hidden")).toBe("true");
    expect(content?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("does not drift under reduced motion", () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="reduce">
        <Float decorative>blob</Float>
      </MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(container.querySelector<HTMLElement>("[data-motion]")?.dataset.motion).toBe("static");
  });
});

describe("Doorstep3D — the code tag", () => {
  /** The tag is the face holding the key icon. Its depth may sit on it or on a wrapper, but
   *  something between it and the stage must carry the translateZ. */
  function tagDepth(container: HTMLElement): string[] {
    const icon = container.querySelector("svg");
    const root = stage(container);
    const transforms: string[] = [];
    for (let el = icon?.parentElement ?? null; el && el !== root; el = el.parentElement) {
      if (el.style.transform) transforms.push(el.style.transform);
    }
    return transforms;
  }

  it("floats in front of the door when still", () => {
    const { container } = render(<Doorstep3D />);
    // framer-motion overwrites a transform string in a motion.div's style with its own; if
    // the depth lived there the tag would sit flat on the wall's plane.
    expect(tagDepth(container).some((t) => t.includes("translateZ(38px)"))).toBe(true);
  });

  it("keeps its depth while the idle loop runs", () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="allow">
        <Doorstep3D />
      </MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("running");
    expect(tagDepth(container).some((t) => t.includes("translateZ(38px)"))).toBe(true);
  });
});

describe("BreathingBackground", () => {
  beforeEach(() => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  });

  it("does not breathe under reduced motion, even on screen", () => {
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="reduce">
        <BreathingBackground>hero</BreathingBackground>
      </MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("static");
  });

  it("follows the operating system's reduce-motion setting", () => {
    systemReduce = true;
    const { container } = render(
      <MotionPreferencesProvider>
        <BreathingBackground>hero</BreathingBackground>
      </MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("static");
  });

  it("breathes on screen and stops when scrolled away", () => {
    const { container } = render(
      <MotionPreferencesProvider defaultOverride="allow">
        <BreathingBackground>hero</BreathingBackground>
      </MotionPreferencesProvider>,
    );
    emitAll(true);
    expect(stage(container).dataset.motion).toBe("running");
    emitAll(false);
    expect(stage(container).dataset.motion).toBe("paused");
  });
});
