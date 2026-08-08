import { describe, expect, it } from "vitest";
import {
  ageBand,
  ageInYears,
  isLiveDispatchable,
  pairingDecision,
  scheduleProblem,
  type AgeBand,
  type PairingParty,
} from "../eligibility.js";
import type { Gender } from "../onboarding.js";

const NOW = Date.UTC(2026, 7, 9); // 2026-08-09

/** Build a party whose age band is exactly `age` today. */
const aged = (age: number, gender: Gender): PairingParty => ({
  dateOfBirth: `${2026 - age}-08-09`,
  gender,
});

describe("ageInYears", () => {
  it("counts whole calendar years, not 365.25-day approximations", () => {
    expect(ageInYears("2008-08-09", NOW)).toBe(18); // birthday today
    expect(ageInYears("2008-08-10", NOW)).toBe(17); // tomorrow — still 17
    expect(ageInYears("2008-08-08", NOW)).toBe(18);
  });

  it("does not drift across leap years", () => {
    // Naive ms/365.25 arithmetic lands on the wrong side of this boundary.
    expect(ageInYears("2000-02-29", Date.UTC(2026, 1, 28))).toBe(25);
    expect(ageInYears("2000-02-29", Date.UTC(2026, 2, 1))).toBe(26);
  });
});

describe("ageBand", () => {
  it.each<[number, AgeBand]>([
    [17, "minor"],
    [18, "young"], // lower edge of young
    [35, "young"], // upper edge of young
    [36, "adult"], // first day out of the restricted band
    [59, "adult"],
    [60, "senior"], // the boundary the brief named explicitly
    [95, "senior"],
  ])("age %i is %s", (age, band) => {
    expect(ageBand(`${2026 - age}-08-09`, NOW)).toBe(band);
  });

  /** Fails closed: an unparseable date must never widen who someone can be matched with. */
  it("treats an unparseable date as a minor", () => {
    expect(ageBand("not-a-date", NOW)).toBe("minor");
    expect(ageBand("", NOW)).toBe("minor");
  });
});

describe("pairingDecision", () => {
  // ── the restriction ────────────────────────────────────────────────────────

  /** The rule the whole module exists for, and it is SYMMETRIC — a restriction that bound
   *  only one direction would leave the other party's safety resting on the first party's
   *  good behaviour. */
  it("requires an exception between two young adults of different gender, both ways", () => {
    const mToF = pairingDecision(aged(25, "male"), aged(28, "female"), NOW);
    const fToM = pairingDecision(aged(28, "female"), aged(25, "male"), NOW);
    expect(mToF.kind).toBe("requires-exception");
    expect(fToM.kind).toBe("requires-exception");
  });

  it("allows two young adults of the same gender", () => {
    expect(pairingDecision(aged(25, "male"), aged(30, "male"), NOW).kind).toBe("allowed");
    expect(pairingDecision(aged(25, "female"), aged(30, "female"), NOW).kind).toBe("allowed");
  });

  // ── who is exempt ──────────────────────────────────────────────────────────

  it("lets a senior requester book anyone", () => {
    for (const helper of [aged(22, "male"), aged(22, "female"), aged(70, "male")]) {
      expect(pairingDecision(aged(72, "female"), helper, NOW).kind).toBe("allowed");
      expect(pairingDecision(aged(72, "male"), helper, NOW).kind).toBe("allowed");
    }
  });

  it("lets an adult (36-59) requester book anyone", () => {
    expect(pairingDecision(aged(40, "male"), aged(25, "female"), NOW).kind).toBe("allowed");
    expect(pairingDecision(aged(40, "female"), aged(25, "male"), NOW).kind).toBe("allowed");
  });

  /** The restriction is about the pair, so it lifts as soon as EITHER side leaves the band. */
  it("lifts once either party is out of the young band", () => {
    expect(pairingDecision(aged(25, "male"), aged(36, "female"), NOW).kind).toBe("allowed");
    expect(pairingDecision(aged(36, "male"), aged(25, "female"), NOW).kind).toBe("allowed");
  });

  /** The exact day someone ages out. Worth pinning: this is the boundary a stored age band
   *  would get wrong, and the reason bands are derived rather than persisted. */
  it("flips on the 36th birthday, not before", () => {
    const dayBefore = { dateOfBirth: "1990-08-10", gender: "female" as const }; // 35 today
    const onTheDay = { dateOfBirth: "1990-08-09", gender: "female" as const }; // 36 today
    expect(pairingDecision(aged(25, "male"), dayBefore, NOW).kind).toBe("requires-exception");
    expect(pairingDecision(aged(25, "male"), onTheDay, NOW).kind).toBe("allowed");
  });

  // ── gender "other" ─────────────────────────────────────────────────────────

  /** Documented policy choice, pinned so it cannot drift silently: the restriction addresses
   *  a specific concern between young men and young women, and is not stretched to a third
   *  value. If the policy changes, this test is the thing that should fail first. */
  it("does not restrict pairings involving 'other'", () => {
    expect(pairingDecision(aged(25, "other"), aged(25, "female"), NOW).kind).toBe("allowed");
    expect(pairingDecision(aged(25, "male"), aged(25, "other"), NOW).kind).toBe("allowed");
    expect(pairingDecision(aged(25, "other"), aged(25, "other"), NOW).kind).toBe("allowed");
  });

  // ── hard denials ───────────────────────────────────────────────────────────

  it("denies anyone under 18 on either side, with no exception route", () => {
    const minor = aged(17, "male");
    expect(pairingDecision(minor, aged(40, "female"), NOW).kind).toBe("denied");
    expect(pairingDecision(aged(40, "female"), minor, NOW).kind).toBe("denied");
  });

  it("fails closed on incomplete identity rather than assuming the safe-looking answer", () => {
    const noDob: PairingParty = { dateOfBirth: null, gender: "male" };
    const noGender: PairingParty = { dateOfBirth: "1990-01-01", gender: null };
    expect(pairingDecision(noDob, aged(40, "female"), NOW).kind).toBe("denied");
    expect(pairingDecision(noGender, aged(40, "female"), NOW).kind).toBe("denied");
    expect(pairingDecision(aged(40, "female"), noDob, NOW).kind).toBe("denied");
    expect(pairingDecision(aged(40, "female"), noGender, NOW).kind).toBe("denied");
  });

  it("always explains a refusal", () => {
    const denied = pairingDecision(aged(17, "male"), aged(40, "female"), NOW);
    const exception = pairingDecision(aged(25, "male"), aged(25, "female"), NOW);
    expect(denied.kind === "denied" && denied.reason.length).toBeGreaterThan(0);
    expect(exception.kind === "requires-exception" && exception.reason.length).toBeGreaterThan(0);
  });

  // ── exhaustive truth table ─────────────────────────────────────────────────

  /** Every band × gender combination, asserted against an independently written expectation.
   *  If the implementation is ever "simplified" into something subtly different, this is what
   *  catches it. */
  it("matches the full specified matrix", () => {
    const bands: [AgeBand, number][] = [
      ["minor", 17],
      ["young", 25],
      ["adult", 45],
      ["senior", 70],
    ];
    const genders: Gender[] = ["male", "female", "other"];

    const expected = (rb: AgeBand, rg: Gender, hb: AgeBand, hg: Gender) => {
      if (rb === "minor" || hb === "minor") return "denied";
      const restricted = (g: Gender) => g === "male" || g === "female";
      if (rb === "young" && hb === "young" && restricted(rg) && restricted(hg) && rg !== hg) {
        return "requires-exception";
      }
      return "allowed";
    };

    let checked = 0;
    for (const [rb, rAge] of bands) {
      for (const rg of genders) {
        for (const [hb, hAge] of bands) {
          for (const hg of genders) {
            const got = pairingDecision(aged(rAge, rg), aged(hAge, hg), NOW).kind;
            expect(got, `${rb}/${rg} -> ${hb}/${hg}`).toBe(expected(rb, rg, hb, hg));
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(144);
  });
});

describe("isLiveDispatchable", () => {
  /** A restricted pairing is not merely "pending" — it must not enter live dispatch at all,
   *  because the whole point is that a human looks first. */
  it("is true only for an outright allowed pairing", () => {
    expect(isLiveDispatchable({ kind: "allowed" })).toBe(true);
    expect(isLiveDispatchable({ kind: "requires-exception", reason: "x" })).toBe(false);
    expect(isLiveDispatchable({ kind: "denied", reason: "x" })).toBe(false);
  });
});

describe("scheduleProblem", () => {
  const HOUR = 3_600_000;

  it("requires at least a day's lead time, because a human has to review first", () => {
    expect(scheduleProblem(NOW + 23 * HOUR, NOW)).toBe("too-soon");
    expect(scheduleProblem(NOW + 25 * HOUR, NOW)).toBeNull();
  });

  it("rejects the past and the far future", () => {
    expect(scheduleProblem(NOW - HOUR, NOW)).toBe("in-the-past");
    expect(scheduleProblem(NOW, NOW)).toBe("in-the-past");
    expect(scheduleProblem(NOW + 40 * 24 * HOUR, NOW)).toBe("too-far");
  });
});
