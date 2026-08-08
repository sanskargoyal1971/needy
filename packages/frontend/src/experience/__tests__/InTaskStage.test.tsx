import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@needy/shared";
import { RealtimeProvider } from "../../realtime/RealtimeProvider.js";
import { initialTaskState, type NeedyDriver, type TaskExperienceState } from "../../realtime/types.js";
import { MotionPreferencesProvider } from "../../motion/preferences.js";
import { stubNeedyDriver } from "../../test/stubDriver.js";
import { InTaskStage } from "../InTaskStage.js";

/**
 * B13 proof. InTaskStage used to compare against a module-level `const ME = "me"`, which is
 * only ever true for the scripted mock. With a live id like `req-abc123` that made EVERY
 * message the user sent render left-aligned as if the helper had sent it, hid all receipts,
 * and made the mark-read effect mark the user's own messages as read. The identity now comes
 * from the driver via TaskExperienceState.userId, so this test uses a realistic id
 * deliberately — a test that used "me" would have passed against the bug.
 */

const MY_ID = "req-abc123";
const HELPER_ID = "helper-priya";

function message(senderId: string, body: string, id: string): ChatMessage {
  return { id, taskId: "task-1", senderId, body, createdAt: 0, status: "sent" };
}

/** A minimal driver over a fixed state — enough for the stage, and it records markRead. */
function stubDriver(overrides: Partial<TaskExperienceState>) {
  const markRead = vi.fn<(messageIds: string[]) => void>();
  const driver = stubNeedyDriver({ ...initialTaskState(MY_ID), ...overrides }, { markRead });
  return { driver, markRead };
}

function renderStage(driver: NeedyDriver) {
  return render(
    <MotionPreferencesProvider defaultOverride="reduce">
      <RealtimeProvider driver={driver}>
        <InTaskStage />
      </RealtimeProvider>
    </MotionPreferencesProvider>,
  );
}

describe("InTaskStage message ownership (audit B13)", () => {
  it("renders a message from the driver's own userId as mine and the other party's as theirs", () => {
    const { driver } = stubDriver({
      userId: MY_ID,
      messages: [
        message(MY_ID, "Could you get my prescription too?", "m1"),
        message(HELPER_ID, "Of course — I'm at the pharmacy now.", "m2"),
      ],
      helper: {
        id: HELPER_ID,
        displayName: "Priya",
        photoUrl: "",
        rating: 4.9,
        helpedCount: 34,
        etaSeconds: 120,
      },
    });
    renderStage(driver);

    const mine = screen.getAllByTestId("msg-mine");
    const theirs = screen.getAllByTestId("msg-theirs");
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]).toHaveTextContent("Could you get my prescription too?");
    expect(theirs[0]).toHaveTextContent("Of course — I'm at the pharmacy now.");
    // Receipts only ever belong on our own bubbles — and they must actually appear.
    expect(mine[0]).toHaveTextContent("sent");
    expect(theirs[0]).not.toHaveTextContent("sent");
  });

  it("marks only INBOUND messages as read, never the user's own", () => {
    const { driver, markRead } = stubDriver({
      userId: MY_ID,
      messages: [
        message(MY_ID, "mine", "m1"),
        message(HELPER_ID, "theirs", "m2"),
      ],
    });
    renderStage(driver);

    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith(["m2"]);
  });

  it("aligns nothing as mine when every message came from the helper", () => {
    const { driver } = stubDriver({
      userId: MY_ID,
      messages: [message(HELPER_ID, "on my way", "m1")],
    });
    renderStage(driver);

    expect(screen.queryAllByTestId("msg-mine")).toHaveLength(0);
    expect(screen.getAllByTestId("msg-theirs")).toHaveLength(1);
  });
});
