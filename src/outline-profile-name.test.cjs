const { test } = require("node:test");
const assert = require("node:assert/strict");
const { outlineProfileName, MAX_CUSTOMER_NAME_LENGTH } = require("./outline-profile-name");

test("Outline profile names use the exact brand separator and sanitized username/name fallbacks", () => {
  const cases = [
    [{ username: "ShinHtetMaung", firstName: "Ignored" }, "Metro Secure | ShinHtetMaung"],
    [{ username: "@ShinHtetMaung" }, "Metro Secure | ShinHtetMaung"],
    [{ username: "  @ShinHtetMaung  " }, "Metro Secure | ShinHtetMaung"],
    [{ firstName: "Shin Htet" }, "Metro Secure | Shin Htet"],
    [{ username: " @\n\t ", firstName: "  Shin Htet  " }, "Metro Secure | Shin Htet"],
    [{ username: "Shin\r\nHtet\0\u007f\u0085\u202e\u2028\u2029@Maung" }, "Metro Secure | ShinHtetMaung"],
    [{ username: "\ud800", firstName: "Mya" }, "Metro Secure | Mya"],
    [{ username: null, firstName: null }, "Metro Secure | Customer"],
    [{ username: 123, firstName: {} }, "Metro Secure | Customer"],
    [{}, "Metro Secure | Customer"],
    [null, "Metro Secure | Customer"],
  ];
  for (const [customer, expected] of cases) {
    const result = outlineProfileName(customer);
    assert.equal(result, expected);
    assert.doesNotMatch(result, /[@\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
  }
});

test("profile names cap the customer portion at 64 Unicode code points without splitting characters", () => {
  for (const input of ["a".repeat(100), "မြ".repeat(100), "😀".repeat(100)]) {
    const label = outlineProfileName({ username: input }).slice("Metro Secure | ".length);
    assert.equal(Array.from(label).length, MAX_CUSTOMER_NAME_LENGTH);
    assert.doesNotThrow(() => encodeURIComponent(label));
  }
});
