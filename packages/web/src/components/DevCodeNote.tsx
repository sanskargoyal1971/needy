import { SandboxNote } from "@/components/ui";
import { DEV_FIXED_OTP } from "@/lib/apiConfig";

/** The sandbox note under every code field. Prints the code only when the build was told it
 *  (see DEV_FIXED_OTP), never a guess. */
export function DevCodeNote() {
  return (
    <SandboxNote>
      No SMS provider is connected yet, so every account accepts the same code
      {DEV_FIXED_OTP ? (
        <>
          : <strong>{DEV_FIXED_OTP}</strong>
        </>
      ) : (
        <> — the fixed code set on the server, which whoever runs it can tell you</>
      )}
      . This is a development stand-in — the server refuses to start with a fixed code in
      production.
    </SandboxNote>
  );
}
