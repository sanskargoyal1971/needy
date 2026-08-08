/** Small formatting helpers shared by the helper screens. Kept out of the components so the
 *  offer card and the active-task panel phrase the same quantity the same way — a distance that
 *  reads "600 m" on one screen and "0.6 km" on the next looks like two different numbers. */

export function formatDistance(meters: number): string {
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** The helper's OWN ETA, phrased in second person. The requester's `formatEta` says "5 min
 *  away" about someone else; said to the person travelling that reads oddly, and "you're"
 *  makes it unmistakable whose number this is when both parties discuss it in chat. */
export function formatOwnEta(seconds: number): string {
  if (seconds <= 60) return "You're nearly there";
  const mins = Math.round(seconds / 60);
  return `You're about ${mins} min away`;
}
