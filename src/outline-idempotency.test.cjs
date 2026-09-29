const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createOrderAccessKey, provisioningKeyId, setAccessKeyDataLimit } = require("./outline");

const order = { id: 42, orderNumber: "VPN-0123456789abcdef0123456789abcdef" };
const accessUrl = "ss://synthetic@192.0.2.1:1234";

function fakeClient(mode = "normal") {
  const id = provisioningKeyId(order);
  let key = null;
  let creates = 0;
  let limitWrites = 0;
  return {
    state: () => ({ key, creates, limitWrites }),
    seed() { key = { id, name: id, accessUrl }; },
    async get(path) {
      assert.equal(path, `/access-keys/${id}`);
      if (!key) throw { response: { status: 404, data: {
        code: "NotFoundError", message: "No access key found",
      } } };
      return { data: key };
    },
    async put(path, body) {
      if (path.endsWith("/data-limit")) {
        assert.equal(path, `/access-keys/${id}/data-limit`);
        limitWrites++;
        key.dataLimit = { bytes: body.limit.bytes };
        return { data: null };
      }
      assert.equal(path, `/access-keys/${id}`);
      assert.deepEqual(body, { name: id });
      creates++;
      if (mode === "before-mutation" && creates === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      if (key) throw { response: { status: 409, data: { code: "Conflict" } } };
      key = { id, name: id, accessUrl };
      if (mode === "lost-response") throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      return { data: key };
    },
  };
}

test("fixed ID is stable and opaque; absent key is created once then verified", async () => {
  const client = fakeClient();
  assert.match(provisioningKeyId(order), /^ms-o-[a-f0-9]{40}$/);
  assert.equal(provisioningKeyId({ ...order }), provisioningKeyId(order));
  assert.equal((await createOrderAccessKey(order, { client })).id, provisioningKeyId(order));
  assert.equal(client.state().creates, 1);
  assert.equal((await createOrderAccessKey(order, { client })).accessUrl, accessUrl);
  assert.equal(client.state().creates, 1);
});

test("existing key and lost create response reconcile without another create", async () => {
  const existing = fakeClient();
  existing.seed();
  await createOrderAccessKey(order, { client: existing });
  assert.equal(existing.state().creates, 0);
  const lost = fakeClient("lost-response");
  await createOrderAccessKey(order, { client: lost });
  assert.equal(lost.state().creates, 1);
  await createOrderAccessKey(order, { client: lost });
  assert.equal(lost.state().creates, 1);
});

test("pre-mutation failure retries only the same fixed ID", async () => {
  const client = fakeClient("before-mutation");
  await createOrderAccessKey(order, { client });
  assert.equal(client.state().creates, 2);
  assert.equal(client.state().key.id, provisioningKeyId(order));
});

test("limit is set to an exact value and a retry does not write it twice", async () => {
  const client = fakeClient();
  await createOrderAccessKey(order, { client });
  await setAccessKeyDataLimit(provisioningKeyId(order), 1024, { client });
  await setAccessKeyDataLimit(provisioningKeyId(order), 1024, { client });
  assert.equal(client.state().limitWrites, 1);
});

test("certificate failures and conflicting IDs fail closed", async () => {
  const cert = fakeClient();
  cert.get = async () => { throw Object.assign(new Error("mismatch"), { code: "OUTLINE_CERT_MISMATCH" }); };
  await assert.rejects(createOrderAccessKey(order, { client: cert }), /mismatch/);
  assert.equal(cert.state().creates, 0);
  const collision = fakeClient();
  collision.seed();
  collision.state().key.name = "unrelated";
  await assert.rejects(createOrderAccessKey(order, { client: collision }), /already in use/);
  assert.equal(collision.state().creates, 0);
});

test("HTTP failures never trigger a second create", async () => {
  for (const status of [400, 401, 403, 500]) {
    const client = fakeClient();
    client.put = async () => {
      throw { response: { status, data: { code: "Failure" } } };
    };
    await assert.rejects(createOrderAccessKey(order, { client }));
    assert.equal(client.state().creates, 0);
  }
});

test("an invalid create reply fails closed unless GET confirms the key", async () => {
  const client = fakeClient();
  client.put = async () => ({ data: { invalid: true } });
  await assert.rejects(createOrderAccessKey(order, { client }), /not confirmed/);
});
