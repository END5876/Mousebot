// test/features.test.js 用的假模組：被 require 時留下紀錄
globalThis.__featuresProbeLoads = (globalThis.__featuresProbeLoads ?? 0) + 1;
module.exports = {
  setupProbe(client) {
    client.setupCalls.push('probe');
  },
};
