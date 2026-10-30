import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isFakeRailsHostAllowed } from "../engine/apiConsumer/fakeRailsAllowlist";

const reset = () => {
  delete process.env.ALLOW_FAKE_RAILS_HOSTS;
  delete process.env.FAKE_RAILS_ALLOWED_HOSTS;
};

describe("scoped Fake Rails SSRF allowlist", () => {
  beforeEach(reset);
  afterEach(reset);

  test("is closed unless ALLOW_FAKE_RAILS_HOSTS is explicitly true", () => {
    process.env.FAKE_RAILS_ALLOWED_HOSTS = "127.0.0.1";
    expect(isFakeRailsHostAllowed("127.0.0.1", ["127.0.0.1"])).toBe(false);
  });

  test("allows only a host that is in BOTH the environment and the gateway list", () => {
    process.env.ALLOW_FAKE_RAILS_HOSTS = "true";
    process.env.FAKE_RAILS_ALLOWED_HOSTS = "127.0.0.1,fakerails.internal";
    expect(isFakeRailsHostAllowed("127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(isFakeRailsHostAllowed("127.0.0.1", ["api.real-bank.ly"])).toBe(false);
    expect(isFakeRailsHostAllowed("evil.internal", ["evil.internal"])).toBe(false);
    expect(isFakeRailsHostAllowed("169.254.169.254", ["169.254.169.254"])).toBe(false);
  });

  test("an empty gateway allowlist never matches", () => {
    process.env.ALLOW_FAKE_RAILS_HOSTS = "true";
    process.env.FAKE_RAILS_ALLOWED_HOSTS = "127.0.0.1";
    expect(isFakeRailsHostAllowed("127.0.0.1", [])).toBe(false);
  });
});
