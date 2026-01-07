function haversineDistance(lon1, lat1, lon2, lat2) {
    // Convert degrees to radians
    const toRad = (deg) => deg * Math.PI / 180;
    
    const R = 6371000; // Earth's radius in meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    
    return R * c;
}

// Your coordinates
const point1_lon = -0.7738713771826338;
const point1_lat = 52.033895394650585;

const point2_lon = -0.7738713984301824;
const point2_lat = 52.03389539177841;

const distance = haversineDistance(point1_lon, point1_lat, point2_lon, point2_lat);

console.log(`Distance between the two points: ${distance.toFixed(2)} meters`);
console.log(`Distance in centimeters: ${(distance * 100).toFixed(1)} cm`);

// Show coordinate differences
const lonDiff = Math.abs(point2_lon - point1_lon);
const latDiff = Math.abs(point2_lat - point1_lat);

console.log(`\nCoordinate differences:`);
console.log(`Longitude difference: ${lonDiff.toFixed(12)} degrees`);
console.log(`Latitude difference: ${latDiff.toFixed(12)} degrees`);