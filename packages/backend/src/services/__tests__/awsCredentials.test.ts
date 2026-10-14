import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containerCredentials,
  createCredentialProvider,
  imdsCredentials,
} from "../awsCredentials.js";
import { closeServer, fakeImds } from "./fakeAws.js";

const HOUR = 60 * 60 * 1000;

describe("instance-role credentials (IMDSv2)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
    vi.restoreAllMocks();
  });

  it("fetches with a session token, caches, and refreshes before expiry", async () => {
    let clock = Date.UTC(2026, 9, 15, 10);
    const imds = await fakeImds({ lifetimeMs: HOUR, now: () => clock });
    servers.push(imds.server);
    const creds = imdsCredentials({ now: () => clock, baseUrl: imds.baseUrl });

    const first = await creds.get();
    expect(first).toMatchObject({
      accessKeyId: "ASIAFAKEROLEKEY00001",
      secretAccessKey: "fake-secret-1",
      sessionToken: "fake-session-token-1",
      expiresAt: clock + HOUR,
    });
    // IMDSv2 only: every metadata GET presented the PUT-issued token.
    expect(imds.state.tokenRequests).toBe(1);
    expect(imds.state.unauthenticated).toBe(0);

    // Cached well inside the lifetime.
    clock += 30 * 60 * 1000;
    expect((await creds.get()).sessionToken).toBe("fake-session-token-1");
    expect(imds.state.issued).toBe(1);

    // Inside the five-minute margin: refreshed before the old token actually expires, so a
    // presigned link minted now does not die mid-review.
    clock += 26 * 60 * 1000;
    expect((await creds.get()).sessionToken).toBe("fake-session-token-2");
    expect(imds.state.issued).toBe(2);
  });

  it("shares one metadata round trip between concurrent callers", async () => {
    const clock = Date.UTC(2026, 9, 15, 10);
    const imds = await fakeImds({ lifetimeMs: HOUR, now: () => clock });
    servers.push(imds.server);
    const creds = imdsCredentials({ now: () => clock, baseUrl: imds.baseUrl });

    const all = await Promise.all(Array.from({ length: 8 }, () => creds.get()));
    expect(new Set(all.map((c) => c.sessionToken)).size).toBe(1);
    expect(imds.state.issued).toBe(1);
  });

  it("re-fetches after invalidate (S3 said ExpiredToken)", async () => {
    const clock = Date.UTC(2026, 9, 15, 10);
    const imds = await fakeImds({ lifetimeMs: HOUR, now: () => clock });
    servers.push(imds.server);
    const creds = imdsCredentials({ now: () => clock, baseUrl: imds.baseUrl });

    await creds.get();
    creds.invalidate();
    expect((await creds.get()).sessionToken).toBe("fake-session-token-2");
  });

  it("keeps serving still-valid credentials when a refresh fails, and fails once they expire", async () => {
    let clock = Date.UTC(2026, 9, 15, 10);
    const imds = await fakeImds({ lifetimeMs: HOUR, now: () => clock });
    servers.push(imds.server);
    const creds = imdsCredentials({ now: () => clock, baseUrl: imds.baseUrl });
    await creds.get();

    imds.state.fail = true;
    clock += 57 * 60 * 1000; // inside the margin, not yet expired
    expect((await creds.get()).sessionToken).toBe("fake-session-token-1");

    clock += 4 * 60 * 1000; // now past the real expiry
    await expect(creds.get()).rejects.toThrow(/token request failed: 500/);
  });

  it("does not go back to IMDS on every call when a refresh returns near-expiry credentials", async () => {
    let clock = Date.UTC(2026, 9, 15, 10);
    // Inside the five-minute margin the moment they are issued: what IMDS can hand out just
    // before it rotates, or what any credentials look like to a skewed clock.
    const imds = await fakeImds({ lifetimeMs: 2 * 60 * 1000, now: () => clock });
    servers.push(imds.server);
    const creds = imdsCredentials({ now: () => clock, baseUrl: imds.baseUrl });

    for (let i = 0; i < 20; i++) {
      expect((await creds.get()).sessionToken).toBe("fake-session-token-1");
    }
    expect(imds.state.issued).toBe(1);

    // After the pause it does ask again, so rotation is still picked up.
    clock += 11 * 1000;
    expect((await creds.get()).sessionToken).toBe("fake-session-token-2");
    expect(imds.state.issued).toBe(2);
  });

  it("never writes a secret or session token to the log", async () => {
    const clock = Date.UTC(2026, 9, 15, 10);
    const imds = await fakeImds({ lifetimeMs: HOUR, now: () => clock });
    servers.push(imds.server);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => void lines.push(String(s)));
    vi.spyOn(console, "error").mockImplementation((s: string) => void lines.push(String(s)));

    await imdsCredentials({ now: () => clock, baseUrl: imds.baseUrl }).get();
    const all = lines.join("\n");
    expect(all).toContain("instance-role");
    expect(all).not.toContain("fake-secret");
    expect(all).not.toContain("fake-session-token");
    expect(all).not.toContain("imds-token");
  });

  it("reports a missing instance profile instead of signing with nothing", async () => {
    const clock = Date.UTC(2026, 9, 15, 10);
    // A metadata server with a role path nobody asks for: the role listing 404s below.
    const server = createServer((req, res) => {
      if (req.method === "PUT") return void res.writeHead(200).end("t");
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await expect(imdsCredentials({ now: () => clock, baseUrl: base }).get()).rejects.toThrow(
      /no IAM role/,
    );
  });
});

describe("container credentials", () => {
  const servers: Server[] = [];
  let dir = "";
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("presents the authorization token from the token file", async () => {
    const clock = Date.UTC(2026, 9, 15, 10);
    const seen: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          AccessKeyId: "ASIACONTAINERKEY0001",
          SecretAccessKey: "container-secret",
          Token: "container-session",
          Expiration: new Date(clock + HOUR).toISOString(),
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    dir = await mkdtemp(join(tmpdir(), "needy-creds-"));
    await writeFile(join(dir, "token"), "pod-identity-token\n");

    const creds = createCredentialProvider({
      now: () => clock,
      isProduction: true,
      env: {
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${(server.address() as AddressInfo).port}/creds`,
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: join(dir, "token"),
      },
    });
    expect(creds.source).toBe("container");
    expect(await creds.get()).toMatchObject({ sessionToken: "container-session" });
    expect(seen).toEqual(["pod-identity-token"]);
  });

  /** An env var pointing the auth token at an arbitrary plain-HTTP host would hand that host
   *  our credentials-endpoint token on every refresh. */
  it("refuses a plain-http full URI that is not loopback or the AWS agent", () => {
    expect(() =>
      containerCredentials({ url: "http://attacker.example/creds", now: () => 0 }),
    ).toThrow(/must be https/);
    expect(() =>
      containerCredentials({ url: "http://169.254.170.23/v1/credentials", now: () => 0 }),
    ).not.toThrow();
  });
});

describe("credential source selection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses static keys when both are set, and warns in production", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((s: string) => void lines.push(String(s)));
    const creds = createCredentialProvider({
      now: () => 0,
      isProduction: true,
      accessKeyId: "AKIASTATICEXAMPLE001",
      secretAccessKey: "static-secret",
      env: {},
    });
    expect(creds.source).toBe("static");
    expect((await creds.get()).sessionToken).toBeUndefined();
    expect(lines.join("\n")).toMatch(/static access keys/);
    expect(lines.join("\n")).not.toContain("static-secret");
  });

  it("refuses half a key pair rather than silently falling through to the role", () => {
    expect(() =>
      createCredentialProvider({ now: () => 0, isProduction: false, accessKeyId: "AKIA", env: {} }),
    ).toThrow(/both/);
  });

  it("falls back to the instance role, honouring the metadata endpoint override", () => {
    const creds = createCredentialProvider({
      now: () => 0,
      isProduction: true,
      env: { AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://127.0.0.1:1" },
    });
    expect(creds.source).toBe("instance-role");
  });
});
