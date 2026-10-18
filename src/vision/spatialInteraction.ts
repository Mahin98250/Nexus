/**
 * Requires two distinct, timestamped camera samples before a spatial pinch can
 * grab the hologram. Animation frames must not count as new camera observations.
 * Tracking loss and a detected release disarm the grab immediately.
 */
export class SpatialPinchGate {
  private lastSampleTimestamp = Number.NaN;
  private candidateSince = 0;
  private candidateSamples = 0;
  private active = false;

  reset() {
    this.lastSampleTimestamp = Number.NaN;
    this.candidateSince = 0;
    this.candidateSamples = 0;
    this.active = false;
  }

  update(detected: boolean, pinching: boolean, sampleTimestamp: number, now: number): boolean {
    if (!detected || !pinching || !Number.isFinite(sampleTimestamp) || sampleTimestamp <= 0 || !Number.isFinite(now)) {
      this.reset();
      return false;
    }

    // A repeated animation-frame read of the same inference result is not a
    // second confirmation. Reject out-of-order samples rather than reviving a grab.
    if (Number.isFinite(this.lastSampleTimestamp) && sampleTimestamp < this.lastSampleTimestamp) {
      this.reset();
      return false;
    }

    if (sampleTimestamp !== this.lastSampleTimestamp) {
      if (this.candidateSamples === 0) this.candidateSince = now;
      this.candidateSamples += 1;
      this.lastSampleTimestamp = sampleTimestamp;
    }

    if (this.candidateSamples >= 2 && now - this.candidateSince >= 20) {
      this.active = true;
    }
    return this.active;
  }
}
