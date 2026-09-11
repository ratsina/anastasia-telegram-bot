import test from "node:test";
import assert from "node:assert/strict";

import { findInstagramAccount } from "./tools/instagram-account-id.mjs";

test("gets username and account ID without putting the token in the URL", async () => {
  const requests = [];
  const accessToken = "private-test-token";
  const account = await findInstagramAccount({
    accessToken,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(200, { user_id: "17841400000000000", username: "anastasia" });
    },
  });

  assert.deepEqual(account, { id: "17841400000000000", username: "anastasia" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.includes(accessToken), false);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${accessToken}`);
});

test("supports access tokens returned by the Facebook Login flow", async () => {
  let requestCount = 0;
  const account = await findInstagramAccount({
    accessToken: "private-test-token",
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount < 3) return jsonResponse(400, { error: { code: 100 } });
      return jsonResponse(200, {
        data: [
          {
            instagram_business_account: {
              id: "17841400000000001",
              username: "ratsinaaa",
            },
          },
        ],
      });
    },
  });

  assert.deepEqual(account, { id: "17841400000000001", username: "ratsinaaa" });
  assert.equal(requestCount, 3);
});

test("does not include the access token in lookup errors", async () => {
  const accessToken = "never-print-this-token";

  await assert.rejects(
    findInstagramAccount({
      accessToken,
      fetchImpl: async () => jsonResponse(403, { error: { code: 190 } }),
    }),
    (error) => {
      assert.equal(error.message.includes(accessToken), false);
      assert.match(error.message, /account_not_found/);
      return true;
    },
  );
});

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}
