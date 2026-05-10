import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { probeDaemonStatusFromPort, probeWebStatusFromPort } from "../src/status-probe.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("tools-dev status port probe", () => {
  it("recognizes a daemon that answers /api/health", async () => {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "http://127.0.0.1:18123/api/health");
      return new Response("ok", { status: 200 });
    };

    const status = await probeDaemonStatusFromPort(18123, 1234);
    assert.deepEqual(status, {
      pid: 1234,
      state: "running",
      url: "http://127.0.0.1:18123",
    });
  });

  it("recognizes a web listener on its root URL", async () => {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "http://127.0.0.1:18124");
      return new Response("<!doctype html>", { status: 200 });
    };

    const status = await probeWebStatusFromPort(18124, null);
    assert.deepEqual(status, {
      pid: null,
      state: "running",
      url: "http://127.0.0.1:18124",
    });
  });
});
