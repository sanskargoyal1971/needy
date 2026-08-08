"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { adminClient, type PacketDocument } from "@/lib/adminClient";
import { formatBytes, relativeTime } from "./format";

/** ── Document viewer ───────────────────────────────────────────────────────
 *  Fetches the bytes with the admin's credentials and renders them from an object URL.
 *
 *  Why not `<img src={doc.url}>`: the raw route requires an admin session *as well as* the
 *  signature, and a bare subresource load gives no control over whether cookies are attached
 *  — that depends on SameSite and cross-origin subresource rules, which differ between the
 *  local `:3000 → :4000` split and a production `web. → api.` one. An explicit
 *  `credentials: "include"` fetch behaves the same in both.
 *
 *  Rendering from a blob is also what makes `Content-Disposition: attachment` on the server
 *  free: the browser never navigates to those bytes, so it never has the chance to render an
 *  unexpected document type in the admin origin.
 */
export function DocumentViewer({ doc }: { doc: PacketDocument }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const created = await adminClient.fetchDocument(doc.url);
        if (cancelled) {
          // The component unmounted mid-fetch; release immediately rather than stranding it.
          URL.revokeObjectURL(created);
          return;
        }
        url = created;
        setObjectUrl(created);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      // Without this every packet opened leaks its documents — including video — for the
      // lifetime of the tab.
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc.url]);

  const isImage = doc.contentType.startsWith("image/");
  const isVideo = doc.contentType.startsWith("video/");

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-gray-900">{doc.label}</p>
          <p className="text-xs text-gray-500">
            {doc.contentType} · {formatBytes(doc.sizeBytes)} · uploaded{" "}
            {relativeTime(doc.uploadedAt)}
          </p>
        </div>
        {objectUrl && (
          <a
            href={objectUrl}
            download={`${doc.kind}`}
            className="shrink-0 rounded-lg p-2 text-gray-500 transition-colors hover:bg-background hover:text-primary"
            aria-label={`Download ${doc.label}`}
          >
            <Download size={16} aria-hidden />
          </a>
        )}
      </div>

      {/* The duplicate-bytes signal, surfaced where the decision is made rather than buried
          in a report nobody opens. The same ID scan on two accounts is worth a hard look. */}
      {doc.alsoSubmittedBy.length > 0 && (
        <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Identical file also submitted by {doc.alsoSubmittedBy.length} other account
            {doc.alsoSubmittedBy.length === 1 ? "" : "s"} ({doc.alsoSubmittedBy.join(", ")}).
          </span>
        </div>
      )}

      <div className="flex min-h-[16rem] items-center justify-center bg-gray-900">
        {failed ? (
          <p className="p-6 text-center text-sm text-gray-300">
            Couldn&apos;t load this document. The view link may have expired — reload the packet.
          </p>
        ) : !objectUrl ? (
          <Loader2 className="animate-spin text-gray-400" aria-label="Loading document" />
        ) : isImage ? (
          // The alt text is the document's own label ("Government photo ID"). It reads as
          // redundant to a linter that flags the word "photo", but here the word IS the
          // content — a reviewer using a screen reader needs to know which artefact this is.
          <img src={objectUrl} alt={doc.label} className="max-h-[32rem] w-full object-contain" />
        ) : isVideo ? (
          <video src={objectUrl} controls playsInline className="max-h-[32rem] w-full" />
        ) : (
          // PDFs and anything else: offer the download rather than embedding. An <iframe> of
          // a blob runs in this origin, and this is the highest-privilege session on the
          // platform — not the place to be casual about what gets rendered.
          <a
            href={objectUrl}
            download={doc.kind}
            className="p-6 text-sm font-medium text-white underline"
          >
            Open {doc.label} ({doc.contentType})
          </a>
        )}
      </div>
    </div>
  );
}
