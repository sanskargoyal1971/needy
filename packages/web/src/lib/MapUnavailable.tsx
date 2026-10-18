import { MapPinOff } from "lucide-react";

/** What a map shows when Google Maps cannot load — no key configured, the key rejected, or the
 *  network refused the script. Said plainly, in the map's own footprint, rather than a grey
 *  box that looks like it is still loading. */
export function MapUnavailable({ height, reason }: { height: number | string; reason: string }) {
  return (
    <div
      className="flex w-full flex-col items-center justify-center gap-2 rounded-[24px] border border-white/50 bg-white/40 px-6 text-center text-gray-500"
      style={{ height }}
      role="status"
    >
      <MapPinOff className="text-gray-400" aria-hidden />
      <span className="text-sm">The map can&apos;t be shown right now.</span>
      <span className="text-xs text-gray-400">{reason}</span>
    </div>
  );
}
