const assert = require('assert');
const { computeDurationSeconds } = require('../src/ffmpegRunner');

function approxEqual(actual, expected, tolerance = 0.001) {
  assert(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);
}

// Frame range with fps
approxEqual(computeDurationSeconds({ fps: 24, source: { inFrame: 0, outFrame: 239 } }), 10);

// Default when no source
approxEqual(computeDurationSeconds({ fps: 30 }), 5);

// Invalid frame range falls back to default
approxEqual(computeDurationSeconds({ fps: 24, source: { inFrame: 10, outFrame: 5 } }), 5);

// Clamps to max duration
approxEqual(computeDurationSeconds({ fps: 24, source: { inFrame: 0, outFrame: 5000 } }), 60);

console.log('All computeDurationSeconds tests passed');
