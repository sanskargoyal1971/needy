import { describe, expect, it } from "vitest";
import { awsUriEncode, EMPTY_SHA256, presignGet, s3CanonicalPath, signRequest } from "../sigv4.js";

/** The example credentials and request from AWS's S3 SigV4 documentation ("Examples: Signature
 *  Calculations in AWS Signature Version 4"). If these drift, every real request would fail
 *  with SignatureDoesNotMatch — and there is no bucket in this repo to notice that against. */
const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const MAY_24_2013 = Date.UTC(2013, 4, 24, 0, 0, 0);
const HOST = "examplebucket.s3.amazonaws.com";

describe("SigV4", () => {
  it("matches AWS's header-signed GET Object example", () => {
    const h = signRequest({
      method: "GET",
      host: HOST,
      path: "/test.txt",
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "s3",
      credentials: EXAMPLE,
      nowMs: MAY_24_2013,
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    // Static keys carry no session token, so none is sent.
    expect(h["x-amz-security-token"]).toBeUndefined();
  });

  it("matches AWS's presigned GET example", () => {
    const url = presignGet({
      origin: `https://${HOST}`,
      host: HOST,
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      credentials: EXAMPLE,
      nowMs: MAY_24_2013,
      expiresSeconds: 86400,
    });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  /** Temporary credentials are useless without their token, and AWS rejects a token that is
   *  attached but not signed. Both shapes must carry it inside the signature. */
  it("signs the session token into header auth and presigned URLs", () => {
    const temp = { ...EXAMPLE, sessionToken: "FQoGZXIvYXdzE+token/with=chars" };
    const h = signRequest({
      method: "PUT",
      host: HOST,
      path: "/k",
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "s3",
      credentials: temp,
      nowMs: MAY_24_2013,
    });
    expect(h["x-amz-security-token"]).toBe(temp.sessionToken);
    expect(h.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,",
    );
    const without = signRequest({
      method: "PUT",
      host: HOST,
      path: "/k",
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "s3",
      credentials: EXAMPLE,
      nowMs: MAY_24_2013,
    });
    expect(h.authorization.split("Signature=")[1]).not.toBe(
      without.authorization.split("Signature=")[1],
    );

    const url = new URL(
      presignGet({
        origin: `https://${HOST}`,
        host: HOST,
        path: "/k",
        region: "us-east-1",
        service: "s3",
        credentials: temp,
        nowMs: MAY_24_2013,
        expiresSeconds: 120,
      }),
    );
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe(temp.sessionToken);
    const plain = new URL(
      presignGet({
        origin: `https://${HOST}`,
        host: HOST,
        path: "/k",
        region: "us-east-1",
        service: "s3",
        credentials: EXAMPLE,
        nowMs: MAY_24_2013,
        expiresSeconds: 120,
      }),
    );
    expect(url.searchParams.get("X-Amz-Signature")).not.toBe(
      plain.searchParams.get("X-Amz-Signature"),
    );
  });

  it("encodes the way AWS canonicalises, not the way URLSearchParams does", () => {
    expect(awsUriEncode("a b+c/d~e*")).toBe("a%20b%2Bc%2Fd~e%2A");
    expect(awsUriEncode("a/b", false)).toBe("a/b");
    expect(s3CanonicalPath("kyc/u_1/selfie-ab.jpg")).toBe("/kyc/u_1/selfie-ab.jpg");
  });
});
