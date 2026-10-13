"use client";

/** ── Authenticator-app setup: the two things shown exactly once ────────────
 *  The setup key, and the recovery codes. Both appear on the sign-in screen (a super admin's
 *  first sign-in) and on the account screen (a member of staff adding one later), and the two
 *  must not word them differently — these are the screens where someone is deciding whether
 *  they have written down enough to get back in.
 *
 *  Neither value is ever persisted here. They arrive in a response, live in the calling
 *  component's state while it is on screen, and are gone on navigation — deliberately not in
 *  localStorage or sessionStorage, where they would outlive the moment they are for.
 */

/** Grouped in fours so a 32-character key can be read across to a phone without losing
 *  the place. Authenticator apps ignore the spaces. */
function grouped(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(" ") ?? secret;
}

export function AuthenticatorSecret({
  secret,
  otpauthUri,
}: {
  secret: string;
  otpauthUri: string;
}) {
  return (
    <div className="space-y-3 rounded-2xl bg-gray-50 p-4 text-sm text-gray-700">
      <p>
        Open your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password,
        Authy…), choose <strong>add an account</strong> and then <strong>enter a setup key</strong>.
      </p>
      <div>
        <p className="text-xs font-medium text-gray-500">Account name</p>
        <p className="font-medium text-gray-900">Needy</p>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500">Setup key (time-based)</p>
        <p className="select-all break-all font-mono text-base font-semibold tracking-wide text-gray-900">
          {grouped(secret)}
        </p>
      </div>
      {/* An `otpauth://` link opens the app directly when this page is on the same device as
          the app. There is no QR code yet — drawing one needs a rendering dependency this
          package does not have — so typing the key is the route that works everywhere. */}
      <a
        href={otpauthUri}
        className="inline-block font-semibold text-primary hover:text-primary-dark"
      >
        On the same phone as the app? Open it there
      </a>
      <p className="text-xs text-gray-500">
        This key is shown once. Anyone who has it can generate your codes, so don&apos;t photograph
        it or send it to anyone.
      </p>
    </div>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-inset ring-amber-100">
      <p className="font-semibold">Save these recovery codes now.</p>
      <p>
        If you lose your phone, one of these gets you in instead of a code from the app. Each works
        once. We can&apos;t show them again — write them down or print them, and keep them somewhere
        that isn&apos;t this computer.
      </p>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-base text-gray-900">
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>
    </div>
  );
}
