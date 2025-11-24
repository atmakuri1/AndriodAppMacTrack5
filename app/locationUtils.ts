// blustick/app/locationUtils.ts
// Utilities for estimating device locations based on user position and distance

export type Coordinate = {
  latitude: number;
  longitude: number;
};

/**
 * Calculate a point at a given distance and bearing from a coordinate
 * @param origin Starting coordinate
 * @param distanceMeters Distance in meters
 * @param bearingDegrees Bearing in degrees (0 = North, 90 = East, 180 = South, 270 = West)
 * @returns New coordinate
 */
export function calculateDestinationPoint(
  origin: Coordinate,
  distanceMeters: number,
  bearingDegrees: number
): Coordinate {
  const R = 6371000; // Earth's radius in meters
  const φ1 = toRadians(origin.latitude);
  const λ1 = toRadians(origin.longitude);
  const θ = toRadians(bearingDegrees);
  const δ = distanceMeters / R;

  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) +
    Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );

  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );

  return {
    latitude: toDegrees(φ2),
    longitude: toDegrees(λ2),
  };
}

/**
 * Simple estimation: Place detection at random bearing from user
 * Good for first detection of a device
 */
export function estimateLocationSimple(
  userLocation: Coordinate,
  distanceMeters: number
): Coordinate {
  // Random bearing (0-360 degrees)
  const randomBearing = Math.random() * 360;
  
  return calculateDestinationPoint(
    userLocation,
    distanceMeters,
    randomBearing
  );
}

/**
 * Smarter estimation: Use multiple detections to triangulate
 * This averages multiple readings from different user positions
 */
export function estimateLocationFromMultipleReadings(
  readings: Array<{
    userLocation: Coordinate;
    distance: number;
  }>
): Coordinate | null {
  if (readings.length === 0) return null;
  if (readings.length === 1) {
    return estimateLocationSimple(readings[0].userLocation, readings[0].distance);
  }

  // For 2+ readings, find the point that minimizes error to all circles
  // Simple approach: weighted average based on signal strength (inverse distance)
  let totalWeight = 0;
  let weightedLat = 0;
  let weightedLon = 0;

  for (const reading of readings) {
    // Weight inversely proportional to distance (closer = more accurate)
    const weight = 1 / (reading.distance + 1);
    totalWeight += weight;
    weightedLat += reading.userLocation.latitude * weight;
    weightedLon += reading.userLocation.longitude * weight;
  }

  return {
    latitude: weightedLat / totalWeight,
    longitude: weightedLon / totalWeight,
  };
}

/**
 * Estimate with phone's compass bearing (if available)
 * This is more accurate if user's phone orientation is known
 */
export function estimateLocationWithBearing(
  userLocation: Coordinate,
  distanceMeters: number,
  phoneBearingDegrees: number
): Coordinate {
  // Assume device is roughly in the direction the phone is pointing
  // Add some randomness (±30 degrees) since RSSI doesn't give exact direction
  const randomOffset = (Math.random() - 0.5) * 60; // ±30 degrees
  const estimatedBearing = (phoneBearingDegrees + randomOffset + 360) % 360;

  return calculateDestinationPoint(
    userLocation,
    distanceMeters,
    estimatedBearing
  );
}

/**
 * Helper: Convert degrees to radians
 */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Helper: Convert radians to degrees
 */
function toDegrees(radians: number): number {
  return radians * (180 / Math.PI);
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 * @returns Distance in meters
 */
export function calculateDistance(
  point1: Coordinate,
  point2: Coordinate
): number {
  const R = 6371000; // Earth's radius in meters
  const φ1 = toRadians(point1.latitude);
  const φ2 = toRadians(point2.latitude);
  const Δφ = toRadians(point2.latitude - point1.latitude);
  const Δλ = toRadians(point2.longitude - point1.longitude);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}