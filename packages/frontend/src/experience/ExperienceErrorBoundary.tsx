import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A real React error boundary around the task experience (audit C22 — there was none, so any
 * throw during render unmounted the whole tree to a blank white page).
 *
 * The fallback is written for the people this app is FOR: elderly and vulnerable users, often
 * mid-request, sometimes frightened. So, deliberately:
 *   - no stack trace, no error message, no error code, no "something went wrong" shrug;
 *   - it says what is still true (their request and their helper have not been lost — that's
 *     the server's state, not this component's);
 *   - it offers exactly ONE obvious way forward, plus the human fallback of a phone call,
 *     because someone who can't get past this screen must not be left with nothing;
 *   - the tone matches the rest of the UI's copy: calm, plain, warm, no jargon.
 * The technical detail goes to the console (and, in production, to `onError`) where engineers
 * can find it — never onto the screen.
 */
export interface ExperienceErrorBoundaryProps {
  children: ReactNode;
  /** Reporting hook (e.g. Sentry). Kept injectable so tests can assert we report without
   *  depending on a real transport. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Optional override so a host app can offer its own recovery (e.g. reset a driver).
   *  Defaults to a full reload, which is the most reliable escape from a corrupted tree. */
  onRetry?: () => void;
  /** Support number shown as the human fallback. Left as a hint if not configured. */
  supportPhone?: string;
}

interface State {
  hasError: boolean;
}

export class ExperienceErrorBoundary extends Component<ExperienceErrorBoundaryProps, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console for the developer; never surfaced to the user.
    console.error("experience tree crashed", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private retry = (): void => {
    if (this.props.onRetry) {
      // Clear the error first so the host's recovery renders into a fresh tree.
      this.setState({ hasError: false });
      this.props.onRetry();
      return;
    }
    if (typeof window !== "undefined") window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const { supportPhone } = this.props;

    return (
      <div
        role="alert"
        style={{
          maxWidth: 420,
          margin: "0 auto",
          padding: "40px 24px",
          display: "grid",
          placeItems: "center",
          gap: 14,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 800 }}>Let's try that again</div>
        <div style={{ fontSize: 15, color: "var(--needy-text-soft)", lineHeight: 1.6 }}>
          This screen stopped loading properly. Nothing you asked for has been lost — your
          request and your helper are safe on our side.
        </div>
        <button
          onClick={this.retry}
          style={{
            marginTop: 4,
            border: "none",
            background: "var(--needy-warm)",
            color: "#fff",
            borderRadius: 12,
            padding: "13px 24px",
            fontSize: 15,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Reload this page
        </button>
        <div style={{ fontSize: 13, color: "var(--needy-text-soft)", lineHeight: 1.6 }}>
          {supportPhone ? (
            <>
              If it happens again, call us on{" "}
              <a href={`tel:${supportPhone.replace(/\s+/g, "")}`} style={{ color: "var(--needy-warm)", fontWeight: 700 }}>
                {supportPhone}
              </a>{" "}
              and a person will help you.
            </>
          ) : (
            <>If it happens again, call our help line and a person will sort it out with you.</>
          )}
        </div>
      </div>
    );
  }
}
