import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describePid, listenerPid } from "../src/netinfo.js";

const canReadProc = process.platform === "linux";

test("the listener for a port is this process", { skip: !canReadProc }, async () => {
  const server = createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.equal(listenerPid(port), process.pid);
    const described = describePid(process.pid);
    assert.match(described, new RegExp(`pid ${process.pid}`));
    assert.match(described, /node/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a closed port has no owner", { skip: !canReadProc }, async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.equal(listenerPid(port), null);
});

test("other platforms say they do not know", () => {
  assert.equal(listenerPid(8790, { platform: "darwin" }), null);
  assert.equal(listenerPid(8790, { platform: "win32" }), null);
});
