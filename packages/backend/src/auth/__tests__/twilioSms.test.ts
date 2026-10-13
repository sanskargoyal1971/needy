import { describe, expect, it, vi } from "vitest";
import { SmsDeliveryError, TwilioSmsProvider } from "../providers.js";

/** ── TwilioSmsProvider ─────────────────────────────────────────────────────
 *  No network and no credentials, so what is tested is what would actually break in a real
 *  deployment: the request encoding, the auth header, and — above all — that a refusal from the
 *  carrier raises instead of returning quietly.
 *
 *  That last point is the reason this adapter was written rather than left as a stub. `send`
 *  returns `Promise<void>`, so a provider that swallows a non-2xx response is indistinguishable
 *  from one that succeeded: the OTP service would record a code, tell the user "we've texted
 *  you", and the user would wait for a message that was never sent. For an audience that may
 *  already be confused or distressed, that is a much worse failure than an honest error.
 */

const CREDS = {
  accountSid: "ACtest0000000000000000000000000000",
  authToken: "test-auth-token",
  from: "+15550001111",
};

function okResponse(): Response {
  return new Response(JSON.stringify({ sid: "SM123", status: "queued" }), { status: 201 });
}

describe("TwilioSmsProvider", () => {
  it("posts a form-encoded message to the account's Messages endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    await new TwilioSmsProvider({ ...CREDS, fetchImpl }).send(
      "+919876543210",
      "Your code is 123456",
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${CREDS.accountSid}/Messages.json`,
    );
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // Basic auth, decoded back to sid:token — a malformed header is a 401 at runtime and is
    // otherwise invisible until the first real send.
    const decoded = Buffer.from(headers.authorization!.replace("Basic ", ""), "base64").toString();
    expect(decoded).toBe(`${CREDS.accountSid}:${CREDS.authToken}`);

    const form = new URLSearchParams(init?.body as string);
    expect(form.get("To")).toBe("+919876543210");
    expect(form.get("Body")).toBe("Your code is 123456");
    expect(form.get("From")).toBe(CREDS.from);
  });

  it("sends a Messaging Service SID in MessagingServiceSid, not From", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    await new TwilioSmsProvider({
      ...CREDS,
      from: "MG9999999999999999999999999999999",
      fetchImpl,
    }).send("+919876543210", "hi");

    const form = new URLSearchParams(fetchImpl.mock.calls[0]![1]?.body as string);
    // Twilio rejects a Messaging Service SID placed in `From`, so this distinction is the
    // difference between working and a 400 on every message.
    expect(form.get("MessagingServiceSid")).toBe("MG9999999999999999999999999999999");
    expect(form.get("From")).toBeNull();
  });

  it("throws SmsDeliveryError on a carrier refusal instead of returning quietly", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "The 'To' number is not valid", code: 21211 }), {
        status: 400,
      }),
    );

    // The assertion that matters: a refusal must be observable to the caller. If this ever
    // becomes a silent resolve, the OTP service will promise a code it never sent.
    const err = await new TwilioSmsProvider({ ...CREDS, fetchImpl })
      .send("+1", "Your code is 123456")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect((err as SmsDeliveryError).status).toBe(400);
    expect((err as SmsDeliveryError).providerCode).toBe(21211);
    // The provider's own code is preserved for diagnosis...
    expect((err as SmsDeliveryError).message).toContain("21211");
    // ...but the message body — which holds the OTP — must never end up in the error text,
    // because errors get logged, reported and aggregated.
    expect((err as SmsDeliveryError).message).not.toContain("123456");
  });

  it("throws on a 5xx even when the error body is not JSON", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>gateway error</html>", { status: 502 }));

    await expect(
      new TwilioSmsProvider({ ...CREDS, fetchImpl }).send("+919876543210", "code"),
    ).rejects.toBeInstanceOf(SmsDeliveryError);
  });

  it("surfaces a transport failure as a delivery error, not the raw network error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNRESET"));

    const err = await new TwilioSmsProvider({ ...CREDS, fetchImpl })
      .send("+919876543210", "code")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect((err as Error).message).toContain("transport failure");
  });

  it("aborts a hung request rather than holding the login endpoint open", async () => {
    // A request that never settles would otherwise pin the HTTP handler until the client gives
    // up, turning every OTP request into a held connection.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );

    const err = await new TwilioSmsProvider({ ...CREDS, fetchImpl, timeoutMs: 30 })
      .send("+919876543210", "code")
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SmsDeliveryError);
    expect((err as Error).message).toContain("timed out");
  });

  it("resolves without throwing when Twilio accepts the message", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    await expect(
      new TwilioSmsProvider({ ...CREDS, fetchImpl }).send("+919876543210", "code"),
    ).resolves.toBeUndefined();
  });
});
