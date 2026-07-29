import type { LatLng, MatchedHelper } from "@needy/shared";

/** Helper avatar: the KYC-verified selfie when present (§3 Stage 2), else a warm monogram —
 *  never a generic gray placeholder icon, which would read as "a system", not a person. */
export function HelperAvatar({
  helper,
  size = 56,
}: {
  helper: Pick<MatchedHelper, "displayName" | "photoUrl">;
  size?: number;
}) {
  const initial = helper.displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        background: "var(--needy-warm)",
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontWeight: 700,
        fontSize: size * 0.4,
        flex: "0 0 auto",
      }}
    >
      {helper.photoUrl ? (
        <img
          src={helper.photoUrl}
          alt={helper.displayName}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initial
      )}
    </div>
  );
}

export function formatEta(seconds: number): string {
  if (seconds <= 60) return "arriving now";
  const mins = Math.round(seconds / 60);
  return `${mins} min away`;
}

/** Project a lat/lng onto a pixel box centered on `origin`, spanning `spanDeg` degrees.
 *  Kept deliberately simple (equirectangular) — good enough for a small local tracking view;
 *  swap for the map SDK's projection once a real map is dropped in. */
export function projectToBox(
  point: LatLng,
  origin: LatLng,
  box: { w: number; h: number },
  spanDeg = 0.02,
): { x: number; y: number } {
  const nx = (point.lng - origin.lng) / spanDeg + 0.5;
  const ny = 0.5 - (point.lat - origin.lat) / spanDeg; // north is up
  return {
    x: Math.max(0, Math.min(1, nx)) * box.w,
    y: Math.max(0, Math.min(1, ny)) * box.h,
  };
}
