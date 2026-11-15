import { describe, expect, it } from "vitest";
import { isFetchAllowed, isTrustedLocalPage } from "../src/lib/netguard";

describe("page trust is stricter than target blocking", () => {
  it("public names that merely look internal never make a page trusted", () => {
    for (const h of ["printer-192-168-1-1.attacker.com", "10.0.0.5.attacker.com", "x.192.168.1.1.nip.io", "app.sslip.io", "lvh.me"]) {
      expect(isTrustedLocalPage(h)).toBe(false);
      expect(isFetchAllowed("http://192.168.1.1/status", "https://" + h + "/checkout")).toBe(false);
    }
  });
  it("genuinely local pages are trusted (fixture stores keep working)", () => {
    for (const h of ["localhost", "streamnest.localhost", "192.168.1.20", "10.0.0.2", "[::1]", "nas.local", "router", "printer.lan"]) {
      expect(isTrustedLocalPage(h)).toBe(true);
    }
    expect(isFetchAllowed("http://legal.localhost:4001/streamnest/terms", "http://streamnest.localhost:4000/checkout")).toBe(true);
  });
  it("public pages still reach public targets", () => {
    expect(isFetchAllowed("https://example.com/terms", "https://shop.example.com/checkout")).toBe(true);
  });
});
