"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RotateCcw, Square, Video } from "lucide-react";
import { Button, FormError } from "@/components/ui";

/** ── Live capture ──────────────────────────────────────────────────────────
 *  The selfie and the video testimony must be taken *now*, on this device. That is the whole
 *  point of them: an uploaded existing photo proves nothing a stolen ID scan doesn't already
 *  prove, and the testimony exists so a reviewer can see a real, present person say their name.
 *
 *  Honest limitation, stated plainly because AGENTS.md forbids dressing a stub up as finished:
 *  using getUserMedia rather than a file picker raises the cost of faking this, it does not
 *  eliminate it. A determined attacker can feed a virtual camera. Real liveness detection is a
 *  provider integration (challenge-response, depth, passive signals) and is NOT implemented
 *  here — the actual assurance in this system is the human reviewer comparing the selfie, the
 *  ID and the spoken testimony. This component makes casual faking inconvenient and gives the
 *  reviewer consistent material to judge.
 */

export type CaptureMode = "photo" | "video";

interface Props {
  mode: CaptureMode;
  /** Seconds. Video only — keeps testimony short enough to review and small enough to upload. */
  maxDurationSeconds?: number;
  onCapture: (blob: Blob, filename: string) => void;
  disabled?: boolean;
}

export function CameraCapture({ mode, maxDurationSeconds = 30, onCapture, disabled }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [preview, setPreview] = useState<{ url: string; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Release the camera. Called on unmount, after capture, and on error.
   *
   *  Not optional housekeeping: a live MediaStream keeps the camera indicator lit and the
   *  hardware held, and on a phone that is both alarming and a battery drain. It is also the
   *  difference between "the app used my camera for a moment" and "the app is watching me". */
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setReady(false);
  }, []);

  useEffect(() => stopStream, [stopStream]);

  // Revoke the object URL when the preview changes or unmounts — without this each retake
  // leaks a blob for the lifetime of the document.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // `user` = front camera. A selfie taken on the rear camera is not a selfie.
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: mode === "video", // the testimony is spoken; a silent clip is useless
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setReady(true);
    } catch (err) {
      // Distinguish "you said no" from "there is no camera": the first is fixable by the user
      // in their browser settings, the second means they need a different device, and telling
      // someone to check permissions they already granted is its own dead end.
      const name = (err as { name?: string }).name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Camera access was blocked. Allow camera access for this site in your browser settings, then try again.",
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera found on this device. You'll need a device with a camera to continue.");
      } else {
        setError("Couldn't start the camera. Close any other app using it and try again.");
      }
    }
  }, [mode]);

  function takePhoto() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setPreview({ url: URL.createObjectURL(blob), blob });
        stopStream();
      },
      "image/jpeg",
      0.9,
    );
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];

    // WebM/VP8 is the format Chrome and Firefox agree on; Safari produces MP4. Both are in
    // the server's accepted list, and the server sniffs the bytes regardless, so passing an
    // unsupported mimeType here would fail for no benefit — let the browser choose.
    const preferred = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    const supported = preferred.find((t) => MediaRecorder.isTypeSupported(t));

    const recorder = new MediaRecorder(stream, supported ? { mimeType: supported } : undefined);
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" });
      setPreview({ url: URL.createObjectURL(blob), blob });
      stopStream();
      setRecording(false);
    };
    recorder.start();
    setRecording(true);
    setElapsed(0);
  }

  // Tick the timer and hard-stop at the cap, so an abandoned recording cannot grow past the
  // server's size limit and be rejected after the user has already spoken.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      setElapsed((s) => {
        const next = s + 1;
        if (next >= maxDurationSeconds) recorderRef.current?.stop();
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [recording, maxDurationSeconds]);

  function retake() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    void start();
  }

  function accept() {
    if (!preview) return;
    const ext = mode === "photo" ? "jpg" : preview.blob.type.includes("mp4") ? "mp4" : "webm";
    onCapture(preview.blob, `${mode}.${ext}`);
  }

  return (
    <div className="space-y-3">
      <FormError>{error}</FormError>

      <div className="relative overflow-hidden rounded-2xl bg-gray-900 aspect-[4/3]">
        {preview ? (
          mode === "photo" ? (
            // A plain <img>, not next/image: the source is a blob: URL created moments ago
            // from the camera, so there is nothing for the optimiser to fetch or cache — it
            // would only add a loader that fails on an object URL.
            <img src={preview.url} alt="Your captured selfie" className="h-full w-full object-cover" />
          ) : (
            <video src={preview.url} controls playsInline className="h-full w-full object-cover" />
          )
        ) : (
          <video
            ref={videoRef}
            muted
            playsInline
            // Mirrored so the live view behaves like a mirror, which is what people expect
            // when framing their own face. The captured frame is NOT mirrored — the canvas
            // draws the raw video — so the reviewer sees the true orientation of any text.
            className="h-full w-full -scale-x-100 object-cover"
          />
        )}

        {!ready && !preview && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-300">
            {mode === "photo" ? <Camera size={32} aria-hidden /> : <Video size={32} aria-hidden />}
          </div>
        )}

        {recording && (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-red-600/90 px-3 py-1 text-xs font-medium text-white">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            {elapsed}s / {maxDurationSeconds}s
          </div>
        )}
      </div>

      {preview ? (
        <div className="flex gap-3">
          <Button type="button" variant="secondary" onClick={retake} disabled={disabled}>
            <RotateCcw size={16} aria-hidden />
            Retake
          </Button>
          <Button type="button" onClick={accept} disabled={disabled}>
            Use this
          </Button>
        </div>
      ) : !ready ? (
        <Button type="button" onClick={() => void start()} disabled={disabled}>
          {mode === "photo" ? <Camera size={16} aria-hidden /> : <Video size={16} aria-hidden />}
          {mode === "photo" ? "Open camera" : "Open camera and mic"}
        </Button>
      ) : mode === "photo" ? (
        <Button type="button" onClick={takePhoto} disabled={disabled}>
          <Camera size={16} aria-hidden />
          Take photo
        </Button>
      ) : recording ? (
        <Button type="button" onClick={() => recorderRef.current?.stop()} disabled={disabled}>
          <Square size={16} aria-hidden />
          Stop recording
        </Button>
      ) : (
        <Button type="button" onClick={startRecording} disabled={disabled}>
          <Video size={16} aria-hidden />
          Start recording
        </Button>
      )}
    </div>
  );
}
