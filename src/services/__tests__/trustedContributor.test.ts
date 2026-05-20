import { describe, expect, it } from "vitest";
import { isTrustedAssociation } from "../trustedContributor.js";

describe("isTrustedAssociation", () => {
  it("trusts repository contributors and maintainers", () => {
    expect(isTrustedAssociation("OWNER")).toBe(true);
    expect(isTrustedAssociation("MEMBER")).toBe(true);
    expect(isTrustedAssociation("COLLABORATOR")).toBe(true);
    expect(isTrustedAssociation("CONTRIBUTOR")).toBe(true);
  });

  it("does not trust drive-by or first-time authors", () => {
    expect(isTrustedAssociation("NONE")).toBe(false);
    expect(isTrustedAssociation("FIRST_TIMER")).toBe(false);
    expect(isTrustedAssociation(undefined)).toBe(false);
  });
});
