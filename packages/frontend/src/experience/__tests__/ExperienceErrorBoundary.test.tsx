import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperienceErrorBoundary } from "../ExperienceErrorBoundary.js";
import { ConnectionBanner } from "../ConnectionBanner.js";

/**
 * C22 proof. There was no error boundary at all, so any throw during render blanked the whole
 * app. The fallback also has to be HUMAN — this audience is elderly and vulnerable — so these
 * tests assert not just that it renders, but that it renders no technical detail and does offer
 * a way forward.
 */

function Boom(): never {
  throw new Error("kaboom: helper.displayName of undefined");
}

/** React re-throws caught errors into a window `error` event so devtools can see them, and
 *  jsdom then dumps the whole stack to stderr. These throws are the POINT of this file, so
 *  swallow both channels — otherwise a passing run looks like a catastrophic failure. */
const swallowUncaught = (e: Event) => e.preventDefault();

describe("ExperienceErrorBoundary (audit C22)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    window.addEventListener("error", swallowUncaught);
  });
  afterEach(() => {
    window.removeEventListener("error", swallowUncaught);
    vi.restoreAllMocks();
  });

  it("renders its human fallback instead of propagating a thrown render error", () => {
    expect(() =>
      render(
        <ExperienceErrorBoundary>
          <Boom />
        </ExperienceErrorBoundary>,
      ),
    ).not.toThrow();

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Let's try that again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload this page/i })).toBeInTheDocument();
  });

  it("shows no stack trace, error message, or jargon to the user", () => {
    render(
      <ExperienceErrorBoundary>
        <Boom />
      </ExperienceErrorBoundary>,
    );
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).not.toContain("kaboom");
    expect(text).not.toContain("Error");
    expect(text).not.toMatch(/undefined|null|stack|at .*\.tsx/i);
    // It must say what is still true, so nobody thinks their request vanished.
    expect(text).toMatch(/nothing you asked for has been lost/i);
  });

  it("offers a real person to call when a support number is configured", () => {
    render(
      <ExperienceErrorBoundary supportPhone="1800 123 4567">
        <Boom />
      </ExperienceErrorBoundary>,
    );
    const link = screen.getByRole("link", { name: "1800 123 4567" });
    expect(link).toHaveAttribute("href", "tel:18001234567");
  });

  it("reports the error to onError for engineers while keeping it off screen", () => {
    const onError = vi.fn();
    render(
      <ExperienceErrorBoundary onError={onError}>
        <Boom />
      </ExperienceErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <ExperienceErrorBoundary>
        <span>all well</span>
      </ExperienceErrorBoundary>,
    );
    expect(screen.getByText("all well")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("ConnectionBanner offline copy (audit C22)", () => {
  it("renders calm, actionable copy for `offline` instead of a blank strip", () => {
    render(<ConnectionBanner connection="offline" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(banner).toHaveTextContent(/not connected right now/i);
  });

  it("still says nothing at all when the connection is healthy", () => {
    render(<ConnectionBanner connection="online" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
